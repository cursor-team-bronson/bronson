import { v4 as uuidv4 } from "uuid";
import { WorkflowConfig, RunState, JobState, SerializedDAG, EventType } from "@bronson/types";
import { resolveDAG } from "../parser/dag-resolver.js";
import { eventLog, VersionMismatchError } from "../event-log/event-log.js";
import { gateManager } from "../gates/gate-manager.js";
import { runAgent } from "../agent-runner/clod-client.js";
import { budgetTracker, BudgetExceededError } from "./budget-tracker.js";

const runs = new Map<string, RunState>();
const killed = new Set<string>();

export const getRun = (runId: string) => runs.get(runId);
export const getRunDag = (runId: string) => getRun(runId)?.dag;
export const listRuns = () => [...runs.values()];
export const isKilled = (runId: string) => killed.has(runId);

/** Append an event with optimistic concurrency — retries on version mismatch. */
function appendVersioned(
  runId: string,
  type: EventType,
  jobId?: string,
  payload?: Record<string, unknown>,
) {
  for (;;) {
    const expectedVersion = eventLog.getLastVersion(runId);
    try {
      eventLog.append(runId, type, jobId, payload, expectedVersion);
      return;
    } catch (e) {
      if (e instanceof VersionMismatchError) continue;
      throw e;
    }
  }
}

export async function startRun(config: WorkflowConfig): Promise<RunState> {
  const runId = uuidv4();
  const dag = resolveDAG(config);

  const jobs: Record<string, JobState> = {};
  for (const jobId of dag.nodes.keys()) {
    jobs[jobId] = { jobId, status: "pending", retryCount: 0 };
  }

  for (const [jobId, jobConfig] of Object.entries(config.jobs)) {
    if (jobConfig.budget_usd) budgetTracker.register(runId, jobId, jobConfig.budget_usd);
  }

  const serializedDag: SerializedDAG = {
    nodes: Array.from(dag.nodes.values()).map(n => ({
      jobId: n.jobId,
      dependencies: n.dependencies,
      dependents: n.dependents,
    })),
    executionWaves: dag.executionWaves,
  };

  const run: RunState = {
    runId,
    workflowName: config.name,
    status: "running",
    createdAt: new Date().toISOString(),
    jobs,
    dag: serializedDag,
  };

  runs.set(runId, run);

  eventLog.append(runId, "RUN_STARTED", undefined, { workflowName: config.name });

  executeRun(run, config, dag.executionWaves).catch(err => {
    if (killed.has(runId)) return;
    run.status = "failed";
    eventLog.append(runId, "RUN_FAILED", undefined, { error: String(err) });
  });

  return run;
}

export function topUpJobBudget(runId: string, jobId: string, amountUsd: number, intentId?: string) {
  const run = runs.get(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  const jobState = run.jobs[jobId];
  if (!jobState) throw new Error(`Job ${jobId} not found in run ${runId}`);
  if (jobState.status !== "awaiting_funding")
    throw new Error(`Job ${jobId} is not awaiting funding (status: ${jobState.status})`);

  const applied = budgetTracker.topUp(runId, jobId, amountUsd, intentId);
  if (!applied) {
    throw new Error(`Duplicate funding attempt for job ${jobId} (intentId: ${intentId ?? "none"})`);
  }
  jobState.checkoutUrl = undefined;
  appendVersioned(runId, "BUDGET_FUNDED", jobId, { amountUsd, intentId });
}

export function cancelJobFunding(runId: string, jobId: string) {
  const run = runs.get(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  const jobState = run.jobs[jobId];
  if (!jobState) throw new Error(`Job ${jobId} not found in run ${runId}`);
  if (jobState.status !== "awaiting_funding")
    throw new Error(`Job ${jobId} is not awaiting funding (status: ${jobState.status})`);

  budgetTracker.cancelFunding(runId, jobId, "Funding cancelled by user");
}

export function stopRun(runId: string) {
  const run = runs.get(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  if (run.status === "completed" || run.status === "failed")
    throw new Error(`Run ${runId} already ${run.status}`);

  killed.add(runId);
  run.status = "failed";
  run.completedAt = new Date().toISOString();

  cancelAwaitingJobs(run, "Run killed by user");
  gateManager.cancelAll(runId, "Run killed by user");

  for (const [jobId, jobState] of Object.entries(run.jobs)) {
    if (jobState.status === "running" || jobState.status === "gate_pending" || jobState.status === "gate_approved" || jobState.status === "awaiting_funding") {
      jobState.status = "failed";
      jobState.error = "Run killed by user";
      jobState.checkoutUrl = undefined;
    }
    if (jobState.status === "pending") {
      jobState.status = "skipped";
    }
  }

  appendVersioned(runId, "RUN_FAILED", undefined, { reason: "Killed by user" });
}

async function executeRun(run: RunState, config: WorkflowConfig, waves: string[][]): Promise<void> {
  for (const wave of waves) {
    if (killed.has(run.runId)) return;
    await Promise.all(wave.map(jobId => executeJob(run, config, jobId)));
    if (killed.has(run.runId)) return;
    if (
      wave.some(
        jobId =>
          run.jobs[jobId].status === "failed" && config.jobs[jobId].on_failure === "halt",
      )
    ) {
      run.status = "failed";
      cancelAwaitingJobs(run, "Run halted due to job failure");
      eventLog.append(run.runId, "RUN_FAILED", undefined, { reason: "Job failed with on_failure: halt" });
      return;
    }
  }

  if (killed.has(run.runId)) return;

  const failedJobIds = Object.values(run.jobs).filter(j => j.status === "failed").map(j => j.jobId);
  if (failedJobIds.length > 0) {
    run.status = "failed";
    run.completedAt = new Date().toISOString();
    cancelAwaitingJobs(run, "Run failed");
    eventLog.append(run.runId, "RUN_FAILED", undefined, {
      reason: "One or more jobs failed after retries",
      failedJobIds,
    });
    return;
  }

  run.status = "completed";
  run.completedAt = new Date().toISOString();
  eventLog.append(run.runId, "RUN_COMPLETED");
}

function cancelAwaitingJobs(run: RunState, reason: string) {
  for (const [jobId, jobState] of Object.entries(run.jobs)) {
    if (jobState.status === "awaiting_funding") {
      budgetTracker.cancelFunding(run.runId, jobId, reason);
    }
  }
}

async function executeJob(run: RunState, config: WorkflowConfig, jobId: string): Promise<void> {
  if (killed.has(run.runId)) return;
  const jobConfig = config.jobs[jobId];
  const jobState = run.jobs[jobId];
  const maxAttempts = 1 + (jobConfig.max_retries ?? 0);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (killed.has(run.runId)) return;
    jobState.status = "running";
    jobState.startedAt = new Date().toISOString();

    const upstreamOutputs: Record<string, string> = {};
    for (const dep of jobConfig.depends_on ?? []) {
      const out = eventLog.getJobOutput(run.runId, dep);
      if (out) upstreamOutputs[dep] = out;
    }

    try {
      const result = await runAgent(run.runId, { jobId, jobConfig, contextInput: "" }, upstreamOutputs);
      let finalOutput = result.output;

      if (jobConfig.gate === "human") {
        jobState.status = "gate_pending";
        run.status = "gate_pending";
        appendVersioned(run.runId, "GATE_PENDING", jobId, { proposedOutput: result.output });

        const decision = await gateManager.waitForApproval({
          runId: run.runId,
          jobId,
          proposedOutput: result.output,
          context: Object.values(upstreamOutputs).join("\n\n"),
        });
        if (killed.has(run.runId)) return;

        if (!decision.approved) {
          jobState.status = "failed";
          jobState.error = decision.reason ?? "Gate rejected";
          appendVersioned(run.runId, "GATE_REJECTED", jobId, { reason: decision.reason });
          return;
        }

        if (decision.editedOutput) finalOutput = decision.editedOutput;
        jobState.status = "gate_approved";
        run.status = gateManager.listPending(run.runId).length > 0 ? "gate_pending" : "running";
        appendVersioned(run.runId, "GATE_APPROVED", jobId);
      }

      jobState.status = "completed";
      jobState.completedAt = new Date().toISOString();
      jobState.output = finalOutput;
      jobState.tokensUsed = result.tokensUsed;
      jobState.costUsd = result.costUsd;
      appendVersioned(run.runId, "JOB_COMPLETED", jobId, {
        output: finalOutput,
        tokensUsed: result.tokensUsed,
        costUsd: result.costUsd,
      });
      return;

    } catch (err) {
      if (err instanceof BudgetExceededError) {
        jobState.status = "awaiting_funding";
        jobState.checkoutUrl = err.checkoutUrl;
        run.status = "awaiting_funding";
        appendVersioned(run.runId, "BUDGET_EXCEEDED", jobId, {
          spentUsd: err.spentUsd,
          limitUsd: err.limitUsd,
          checkoutUrl: err.checkoutUrl,
          intentId: err.intentId,
        });

        try {
          await budgetTracker.waitForFunding(run.runId, jobId);
        } catch (fundErr) {
          if (killed.has(run.runId)) return;
          jobState.status = "failed";
          jobState.error = String(fundErr);
          appendVersioned(run.runId, "JOB_FAILED", jobId, { error: String(fundErr) });
          return;
        }
        if (killed.has(run.runId)) return;

        const stillAwaiting = budgetTracker.listAwaiting(run.runId).some(j => j.jobId !== jobId);
        run.status = stillAwaiting ? "awaiting_funding" : "running";
        appendVersioned(run.runId, "JOB_RESUMED", jobId);

        if (err.output !== undefined) {
          let finalOutput = err.output;

          if (jobConfig.gate === "human") {
            jobState.status = "gate_pending";
            run.status = "gate_pending";
            appendVersioned(run.runId, "GATE_PENDING", jobId, { proposedOutput: finalOutput });

            const decision = await gateManager.waitForApproval({
              runId: run.runId,
              jobId,
              proposedOutput: finalOutput,
              context: Object.values(upstreamOutputs).join("\n\n"),
            });
            if (killed.has(run.runId)) return;

            if (!decision.approved) {
              jobState.status = "failed";
              jobState.error = decision.reason ?? "Gate rejected";
              appendVersioned(run.runId, "GATE_REJECTED", jobId, { reason: decision.reason });
              return;
            }

            if (decision.editedOutput) finalOutput = decision.editedOutput;
            jobState.status = "gate_approved";
            run.status = gateManager.listPending(run.runId).length > 0 ? "gate_pending" : "running";
            appendVersioned(run.runId, "GATE_APPROVED", jobId);
          }

          jobState.status = "completed";
          jobState.completedAt = new Date().toISOString();
          jobState.output = finalOutput;
          jobState.tokensUsed = err.tokensUsed;
          jobState.costUsd = err.costUsd;
          appendVersioned(run.runId, "JOB_COMPLETED", jobId, {
            output: finalOutput,
            tokensUsed: err.tokensUsed,
            costUsd: err.costUsd,
          });
          return;
        }

        attempt--;
        continue;
      }

      jobState.retryCount = attempt;
      if (attempt < maxAttempts) {
        const delayMs = 500 * Math.pow(2, attempt - 1);
        eventLog.append(run.runId, "JOB_RETRY_WARNING", jobId, {
          attempt,
          maxAttempts,
          reason: String(err),
          nextRetryDelayMs: delayMs,
        });
        await new Promise(r => setTimeout(r, delayMs));
        if (killed.has(run.runId)) return;
      } else {
        jobState.status = "failed";
        jobState.error = String(err);
        eventLog.append(run.runId, "JOB_FAILED", jobId, { error: String(err) });
      }
    }
  }
}
