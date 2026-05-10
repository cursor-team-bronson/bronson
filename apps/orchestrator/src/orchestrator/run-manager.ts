import { v4 as uuidv4 } from "uuid";
import { WorkflowConfig, RunState, JobState, SerializedDAG } from "@bronson/types";
import { resolveDAG } from "../parser/dag-resolver.js";
import { eventLog, VersionMismatchError } from "../event-log/event-log.js";
import { gateManager } from "../gates/gate-manager.js";
import { runAgent } from "../agent-runner/clod-client.js";
import { parseWorkflowString } from "../parser/yaml-parser.js";
import {
  buildRunStateFromPersistence,
  fetchJobRows,
  fetchJobOutputFromDb,
  fetchRunSnapshot,
  isJobPersistenceEnabled,
  persistJobRow,
  persistRunStart,
  persistRunStatus,
} from "../persistence/supabase-job-store.js";

const runs = new Map<string, RunState>();

export const getRun = (runId: string) => runs.get(runId);
export const getRunDag = (runId: string) => getRun(runId)?.dag;
export const listRuns = () => [...runs.values()];

/** Rebuild in-memory run + jobs from Supabase (after orchestrator restart). */
export async function hydrateRunFromDb(runId: string): Promise<RunState | null> {
  if (runs.has(runId)) return runs.get(runId)!;
  if (!isJobPersistenceEnabled()) return null;
  const snap = await fetchRunSnapshot(runId);
  if (!snap) return null;
  const rows = await fetchJobRows(runId);
  const { run } = buildRunStateFromPersistence(runId, snap, rows);
  runs.set(runId, run);
  return run;
}

async function committedJobOutput(runId: string, jobId: string): Promise<string | undefined> {
  const fromEvent = eventLog.getJobOutput(runId, jobId);
  if (fromEvent !== undefined) return fromEvent;
  return fetchJobOutputFromDb(runId, jobId);
}

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

export async function startRun(config: WorkflowConfig, workflowYamlSnapshot: string): Promise<RunState> {
  const runId = uuidv4();
  const dag = resolveDAG(config);

  const jobs: Record<string, JobState> = {};
  for (const jobId of dag.nodes.keys()) {
    jobs[jobId] = { jobId, status: "pending", retryCount: 0 };
  }

  const serializedDag: SerializedDAG = {
    nodes: Array.from(dag.nodes.values()).map((n) => ({
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

  await persistRunStart(runId, config.name, workflowYamlSnapshot);
  runs.set(runId, run);

  eventLog.append(runId, "RUN_STARTED", undefined, { workflowName: config.name });

  executeRun(run, config, dag.executionWaves).catch((err) => {
    run.status = "failed";
    eventLog.append(runId, "RUN_FAILED", undefined, { error: String(err) });
    void persistRunStatus(runId, "failed");
  });

  return run;
}

function applyRunTerminalState(run: RunState, config: WorkflowConfig): void {
  const failedJobIds = Object.values(run.jobs)
    .filter((j) => j.status === "failed")
    .map((j) => j.jobId);
  if (failedJobIds.length > 0) {
    run.status = "failed";
    run.completedAt = new Date().toISOString();
    eventLog.append(run.runId, "RUN_FAILED", undefined, {
      reason: "One or more jobs failed after retries",
      failedJobIds,
    });
    void persistRunStatus(run.runId, "failed");
    return;
  }
  const allDone = Object.values(run.jobs).every((j) => j.status === "completed" || j.status === "skipped");
  if (allDone) {
    run.status = "completed";
    run.completedAt = new Date().toISOString();
    eventLog.append(run.runId, "RUN_COMPLETED");
    void persistRunStatus(run.runId, "completed");
  }
}

async function executeRun(run: RunState, config: WorkflowConfig, waves: string[][]): Promise<void> {
  for (const wave of waves) {
    await Promise.all(wave.map((jobId) => executeJob(run, config, jobId)));
    if (wave.some((jobId) => run.jobs[jobId].status === "failed" && config.jobs[jobId].on_failure === "halt")) {
      run.status = "failed";
      run.completedAt = new Date().toISOString();
      eventLog.append(run.runId, "RUN_FAILED", undefined, { reason: "Job failed with on_failure: halt" });
      void persistRunStatus(run.runId, "failed");
      return;
    }
  }

  applyRunTerminalState(run, config);
}

async function runReadyDependents(run: RunState, config: WorkflowConfig, completedJobId: string): Promise<void> {
  const dag = run.dag;
  if (!dag) return;
  const node = dag.nodes.find((n) => n.jobId === completedJobId);
  if (!node?.dependents.length) return;

  const ready = node.dependents.filter((depId) => {
    if (!config.jobs[depId]) return false;
    const deps = config.jobs[depId].depends_on ?? [];
    return deps.every((d) => run.jobs[d]?.status === "completed") && run.jobs[depId]?.status === "pending";
  });

  await Promise.all(ready.map((depId) => executeJobThenContinue(run, config, depId)));
}

async function executeJobThenContinue(run: RunState, config: WorkflowConfig, depId: string): Promise<void> {
  await executeJob(run, config, depId);
  if (run.jobs[depId].status === "completed") {
    await runReadyDependents(run, config, depId);
  }
}

/**
 * Re-run a single failed job, then continue any dependents that become runnable (same process).
 * Requires Supabase persistence (upstream outputs were written when each step completed).
 */
export async function retryJobAndContinue(
  runId: string,
  jobId: string,
): Promise<{ ok: true } | { error: string }> {
  if (!isJobPersistenceEnabled()) {
    return {
      error:
        "Job persistence is disabled. Set SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY on the orchestrator.",
    };
  }
  let run = getRun(runId);
  if (!run) run = (await hydrateRunFromDb(runId)) ?? undefined;
  if (!run) return { error: "Run not found" };

  const snap = await fetchRunSnapshot(runId);
  if (!snap) return { error: "Run snapshot not found in database" };

  let config: WorkflowConfig;
  try {
    config = parseWorkflowString(snap.workflow_yaml);
  } catch (e) {
    return { error: String(e) };
  }

  if (!run.jobs[jobId]) return { error: "Unknown job id" };
  if (run.jobs[jobId].status !== "failed") {
    return { error: `Job is not failed (status=${run.jobs[jobId].status}); only failed jobs can be retried.` };
  }

  run.jobs[jobId] = { jobId, status: "pending", retryCount: 0 };
  run.status = "running";
  delete run.completedAt;

  void (async () => {
    try {
      await executeJob(run, config, jobId);
      if (run.jobs[jobId].status === "completed") {
        await runReadyDependents(run, config, jobId);
      }
      applyRunTerminalState(run, config);
    } catch (e) {
      console.error("[bronson] retryJobAndContinue:", e);
    }
  })();

  return { ok: true };
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
      const out = await committedJobOutput(run.runId, dep);
      if (out) upstreamOutputs[dep] = out;
    }

    try {
      const result = await runAgent(run.runId, { jobId, jobConfig, contextInput: "" }, upstreamOutputs);
      let finalOutput = result.output;

      if (jobConfig.gate === "human") {
        jobState.status = "gate_pending";
        run.status = "gate_pending";
        appendGateEvent(run.runId, "GATE_PENDING", jobId, { proposedOutput: result.output });

        const decision = await gateManager.waitForApproval({
          runId: run.runId,
          jobId,
          proposedOutput: result.output,
          context: Object.values(upstreamOutputs).join("\n\n"),
        });

        if (!decision.approved) {
          jobState.status = "failed";
          jobState.completedAt = new Date().toISOString();
          jobState.error = decision.reason ?? "Gate rejected";
          appendGateEvent(run.runId, "GATE_REJECTED", jobId, { reason: decision.reason });
          void persistJobRow(run.runId, { ...jobState });
          return;
        }

        if (decision.editedOutput) finalOutput = decision.editedOutput;
        jobState.status = "gate_approved";
        run.status = gateManager.listPending(run.runId).length > 0 ? "gate_pending" : "running";
        appendGateEvent(run.runId, "GATE_APPROVED", jobId);
      }

      jobState.status = "completed";
      jobState.completedAt = new Date().toISOString();
      jobState.output = finalOutput;
      jobState.tokensUsed = result.tokensUsed;
      jobState.costUsd = result.costUsd;

      eventLog.append(run.runId, "JOB_COMPLETED", jobId, {
        output: finalOutput,
        tokensUsed: result.tokensUsed,
        costUsd: result.costUsd,
      });
      void persistJobRow(run.runId, { ...jobState });
      return;
    } catch (err) {
      jobState.retryCount = attempt;
      if (attempt < maxAttempts) {
        const delayMs = 500 * Math.pow(2, attempt - 1);

        eventLog.append(run.runId, "JOB_RETRY_WARNING", jobId, {
          attempt,
          maxAttempts,
          reason: String(err),
          nextRetryDelayMs: delayMs,
        });

        await new Promise((r) => setTimeout(r, delayMs));
      } else {
        jobState.status = "failed";
        jobState.completedAt = new Date().toISOString();
        jobState.error = String(err);
        eventLog.append(run.runId, "JOB_FAILED", jobId, { error: String(err) });
        void persistJobRow(run.runId, { ...jobState });
      }
    }
  }
}
