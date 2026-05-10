import { v4 as uuidv4 } from "uuid";
import { WorkflowConfig, RunState, JobState } from "../types/index.js";
import { resolveDAG } from "../parser/dag-resolver.js";
import { eventLog, VersionMismatchError } from "../event-log/event-log.js";
import { gateManager } from "../gates/gate-manager.js";
import { runAgent } from "../agent-runner/clod-client.js";

const runs = new Map<string, RunState>();

/** Gate-related log writes use optimistic concurrency; retry if parallel jobs race on version. */
function appendGateEvent(
  runId: string,
  type: "GATE_PENDING" | "GATE_APPROVED" | "GATE_REJECTED",
  jobId: string,
  payload?: Record<string, unknown>,
) {
  for (;;) {
    const expectedVersion = eventLog.getLastVersion(runId);
    try {
      return eventLog.append(runId, type, jobId, payload, expectedVersion);
    } catch (e) {
      if (e instanceof VersionMismatchError) continue;
      throw e;
    }
  }
}

export const getRun = (runId: string) => runs.get(runId);
export const listRuns = () => [...runs.values()];

export async function startRun(config: WorkflowConfig): Promise<RunState> {
  const runId = uuidv4();
  const dag = resolveDAG(config);
  const jobs: Record<string, JobState> = {};
  for (const jobId of dag.nodes.keys()) jobs[jobId] = { jobId, status: "pending", retryCount: 0 };
  const run: RunState = { runId, workflowName: config.name, status: "running", createdAt: new Date().toISOString(), jobs };
  runs.set(runId, run);
  eventLog.append(runId, "RUN_STARTED", undefined, { workflowName: config.name });
  executeRun(run, config, dag.executionWaves).catch(err => {
    run.status = "failed";
    eventLog.append(runId, "RUN_FAILED", undefined, { error: String(err) });
  });
  return run;
}

async function executeRun(run: RunState, config: WorkflowConfig, waves: string[][]): Promise<void> {
  for (const wave of waves) {
    await Promise.all(wave.map(jobId => executeJob(run, config, jobId)));
    if (wave.some(jobId => run.jobs[jobId].status === "failed" && config.jobs[jobId].on_failure === "halt")) {
      run.status = "failed";
      eventLog.append(run.runId, "RUN_FAILED", undefined, { reason: "Job failed with on_failure: halt" });
      return;
    }
  }
  const failedJobIds = Object.values(run.jobs).filter(j => j.status === "failed").map(j => j.jobId);
  if (failedJobIds.length > 0) {
    run.status = "failed";
    run.completedAt = new Date().toISOString();
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

async function executeJob(run: RunState, config: WorkflowConfig, jobId: string): Promise<void> {
  const jobConfig = config.jobs[jobId];
  const jobState = run.jobs[jobId];
  const maxAttempts = 1 + (jobConfig.max_retries ?? 0);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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
        jobState.status = "gate_pending"; run.status = "gate_pending";
        appendGateEvent(run.runId, "GATE_PENDING", jobId, { proposedOutput: result.output });
        const decision = await gateManager.waitForApproval({
          runId: run.runId, jobId, proposedOutput: result.output,
          context: Object.values(upstreamOutputs).join("\n\n"),
        });
        if (!decision.approved) {
          jobState.status = "failed"; jobState.error = decision.reason ?? "Gate rejected";
          appendGateEvent(run.runId, "GATE_REJECTED", jobId, { reason: decision.reason });
          return;
        }
        if (decision.editedOutput) finalOutput = decision.editedOutput;
        jobState.status = "gate_approved";
        run.status = gateManager.listPending(run.runId).length > 0 ? "gate_pending" : "running";
        appendGateEvent(run.runId, "GATE_APPROVED", jobId);
      }
      jobState.status = "completed"; jobState.completedAt = new Date().toISOString();
      jobState.output = finalOutput; jobState.tokensUsed = result.tokensUsed; jobState.costUsd = result.costUsd;
      eventLog.append(run.runId, "JOB_COMPLETED", jobId, { output: finalOutput, tokensUsed: result.tokensUsed, costUsd: result.costUsd });
      return;
    } catch (err) {
      jobState.retryCount = attempt;
      if (attempt === maxAttempts) {
        jobState.status = "failed"; jobState.error = String(err);
        eventLog.append(run.runId, "JOB_FAILED", jobId, { error: String(err) });
      }
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt - 1)));
    }
  }
}
