import { v4 as uuidv4 } from "uuid";
import { WorkflowConfig, RunState, JobState, SerializedDAG, EventType, UpstreamKind } from "@bronson/types";
import { resolveDAG } from "../parser/dag-resolver.js";
import { eventLog, VersionMismatchError } from "../event-log/event-log.js";
import { gateManager } from "../gates/gate-manager.js";
import { runAgent } from "../agent-runner/clod-client.js";
import {
  budgetTracker,
  BudgetExceededError,
  BudgetCheckoutUnavailableError,
} from "./budget-tracker.js";

const runs = new Map<string, RunState>();

export const getRun = (runId: string) => runs.get(runId);
export const getRunDag = (runId: string) => getRun(runId)?.dag;
export const listRuns = () => [...runs.values()];

function gatherUpstreamPayload(
  runId: string,
  deps: string[],
): { outputs: Record<string, string>; kinds: Record<string, UpstreamKind> } {
  const outputs: Record<string, string> = {};
  const kinds: Record<string, UpstreamKind> = {};
  for (const dep of deps) {
    const success = eventLog.getJobOutput(runId, dep);
    if (success !== undefined) {
      outputs[dep] = success;
      kinds[dep] = "completed";
      continue;
    }
    const failed = eventLog.getFailureContextForJob(runId, dep);
    if (failed !== undefined) {
      outputs[dep] = failed;
      kinds[dep] = "failed";
    }
  }
  return { outputs, kinds };
}

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
    run.status = "failed";
    appendVersioned(runId, "RUN_FAILED", undefined, { error: String(err) });
  });

  return run;
}

export function topUpJobBudget(runId: string, jobId: string, amountUsd: number) {
  const run = runs.get(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  const jobState = run.jobs[jobId];
  if (!jobState) throw new Error(`Job ${jobId} not found in run ${runId}`);
  if (jobState.status !== "awaiting_funding")
    throw new Error(`Job ${jobId} is not awaiting funding (status: ${jobState.status})`);

  budgetTracker.topUp(runId, jobId, amountUsd);
  jobState.checkoutUrl = undefined;
  appendVersioned(runId, "BUDGET_FUNDED", jobId, { amountUsd });
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

async function executeRun(run: RunState, config: WorkflowConfig, waves: string[][]): Promise<void> {
  for (const wave of waves) {
    await Promise.all(wave.map(jobId => executeJob(run, config, jobId)));
    if (
      wave.some(
        jobId =>
          run.jobs[jobId].status === "failed" && config.jobs[jobId].on_failure === "halt",
      )
    ) {
      run.status = "failed";
      cancelAwaitingJobs(run, "Run halted due to job failure");
      appendVersioned(run.runId, "RUN_FAILED", undefined, { reason: "Job failed with on_failure: halt" });
      return;
    }
  }

  const failedJobIds = Object.values(run.jobs).filter(j => j.status === "failed").map(j => j.jobId);
  if (failedJobIds.length > 0) {
    run.status = "failed";
    run.completedAt = new Date().toISOString();
    cancelAwaitingJobs(run, "Run failed");
    appendVersioned(run.runId, "RUN_FAILED", undefined, {
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
  const jobConfig = config.jobs[jobId];
  const jobState = run.jobs[jobId];
  const maxAttempts = 1 + (jobConfig.max_retries ?? 0);

  const priorAttemptErrors: string[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    jobState.status = "running";
    jobState.startedAt = new Date().toISOString();

    const { outputs: upstreamOutputs, kinds: upstreamKind } = gatherUpstreamPayload(
      run.runId,
      jobConfig.depends_on ?? [],
    );

    try {
      const result = await runAgent(
        run.runId,
        {
          jobId,
          jobConfig,
          contextInput: "",
          priorAttemptErrors: priorAttemptErrors.length > 0 ? [...priorAttemptErrors] : undefined,
          upstreamKind: Object.keys(upstreamKind).length > 0 ? upstreamKind : undefined,
        },
        upstreamOutputs,
      );
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
      if (err instanceof BudgetCheckoutUnavailableError) {
        jobState.status = "failed";
        jobState.error = err.message;
        appendVersioned(run.runId, "JOB_FAILED", jobId, { error: err.message });
        return;
      }

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
          jobState.status = "failed";
          jobState.error = String(fundErr);
          appendVersioned(run.runId, "JOB_FAILED", jobId, { error: String(fundErr) });
          return;
        }

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
          jobState.tokensUsed = err.tokensUsed ?? 0;
          jobState.costUsd = err.costUsd ?? 0;
          appendVersioned(run.runId, "JOB_COMPLETED", jobId, {
            output: finalOutput,
            tokensUsed: err.tokensUsed ?? 0,
            costUsd: err.costUsd ?? 0,
          });
          return;
        }

        attempt--;
        continue;
      }

      const msg = String(err);
      jobState.retryCount = attempt;
      priorAttemptErrors.push(`Attempt ${attempt}: ${msg}`);
      if (attempt < maxAttempts) {
        const delayMs = 500 * Math.pow(2, attempt - 1);
        appendVersioned(run.runId, "JOB_RETRY_WARNING", jobId, {
          attempt,
          maxAttempts,
          reason: msg,
          nextRetryDelayMs: delayMs,
        });
        await new Promise(r => setTimeout(r, delayMs));
      } else {
        jobState.status = "failed";
        jobState.error = msg;
        appendVersioned(run.runId, "JOB_FAILED", jobId, { error: msg });
      }
    }
  }
}
