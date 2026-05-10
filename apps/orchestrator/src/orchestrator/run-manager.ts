import { v4 as uuidv4 } from "uuid";
import { WorkflowConfig, RunState, JobState, JobStatus, SerializedDAG, EventType } from "@bronson/types";
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
import { persistStepGateApproved, persistWorkflowRunStatus } from "../persist/supabase-sync.js";
import { attachJobAbort, detachJobAbort } from "./job-abort-registry.js";

const runs = new Map<string, RunState>();

/** In-flight DAG execution per run (avoids overlapping resume/start on the same run id). */
const runExecutionPromises = new Map<string, Promise<void>>();

function trackRunExecution(runId: string, p: Promise<void>): void {
  runExecutionPromises.set(runId, p);
  void p.finally(() => {
    if (runExecutionPromises.get(runId) === p) runExecutionPromises.delete(runId);
  });
}

/**
 * After {@link runExecutionPromises} is idle, reserve it synchronously. If multiple callers wake
 * together when the same execution promise settles, only one wins the slot; losers release their
 * orphan lease and loop (awaiting the winner's work).
 */
async function acquireRunExecutionLease(runId: string): Promise<{
  abandon: () => void;
  releaseLease: () => void;
}> {
  for (;;) {
    while (runExecutionPromises.has(runId)) {
      await runExecutionPromises.get(runId)!;
    }

    let releaseLease!: () => void;
    const lease = new Promise<void>((r) => {
      releaseLease = r;
    });
    if (runExecutionPromises.has(runId)) continue;

    runExecutionPromises.set(runId, lease);
    if (runExecutionPromises.get(runId) !== lease) {
      releaseLease();
      continue;
    }

    const abandon = () => {
      if (runExecutionPromises.get(runId) === lease) runExecutionPromises.delete(runId);
      releaseLease();
    };
    return { abandon, releaseLease };
  }
}

function normalizeJobsForResume(run: RunState): void {
  for (const j of Object.values(run.jobs)) {
    if (j.status === "running" || j.status === "gate_approved" || j.status === "gate_pending") {
      j.status = "pending";
      j.retryCount = 0;
      delete j.startedAt;
      delete j.completedAt;
      delete j.output;
      delete j.tokensUsed;
      delete j.costUsd;
      delete j.error;
    }
  }
}

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

/** In-memory run if present, otherwise load from Supabase (for GET /api/runs/:id after reload). */
export async function ensureRunLoaded(runId: string): Promise<RunState | null> {
  const existing = getRun(runId);
  if (existing) return existing;
  return hydrateRunFromDb(runId);
}

async function committedJobOutput(runId: string, jobId: string): Promise<string | undefined> {
  const fromEvent = eventLog.getJobOutput(runId, jobId);
  if (fromEvent !== undefined) return fromEvent;
  return fetchJobOutputFromDb(runId, jobId);
}

/** Append a run event with CAS on expectedVersion so concurrent writers cannot corrupt the version sequence. */
function appendRunEvent(
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

  appendRunEvent(runId, "RUN_STARTED", undefined, { workflowName: config.name });

  const p = executeRun(run, config, dag.executionWaves).catch((err) => {
    run.status = "failed";
    run.completedAt = run.completedAt ?? new Date().toISOString();
    appendRunEvent(runId, "RUN_FAILED", undefined, { error: String(err) });
    void persistRunStatus(runId, "failed");
  });
  trackRunExecution(runId, p);

  return run;
}

/**
 * Continue a persisted run using the workflow YAML stored in Supabase (ignores the editor string).
 * Drops any stale in-memory copy so a browser refresh always picks up latest job rows from the DB.
 * Skips completed/skipped/failed jobs; returns null if persistence is off, snapshot missing, fully done,
 * or only failed jobs remain.
 */
export async function continuePersistedRun(runId: string): Promise<RunState | null> {
  const rid = runId.trim();
  if (!rid || !isJobPersistenceEnabled()) return null;

  if (runExecutionPromises.has(rid)) {
    await runExecutionPromises.get(rid)!;
    return getRun(rid) ?? (await hydrateRunFromDb(rid)) ?? null;
  }

  const { abandon, releaseLease } = await acquireRunExecutionLease(rid);

  const abandonClaim = (): null => {
    abandon();
    return null;
  };

  runs.delete(rid);

  try {
    const snap = await fetchRunSnapshot(rid);
    if (!snap) return abandonClaim();

    let config: WorkflowConfig;
    try {
      config = parseWorkflowString(snap.workflow_yaml);
    } catch {
      return abandonClaim();
    }

    const run = (await hydrateRunFromDb(rid)) ?? undefined;
    if (!run) return abandonClaim();

    const allDone = Object.values(run.jobs).every((j) => j.status === "completed" || j.status === "skipped");
    if (allDone) return abandonClaim();

    const hasIncomplete = Object.values(run.jobs).some(
      (j) =>
        j.status === "pending" ||
        j.status === "running" ||
        j.status === "gate_pending" ||
        j.status === "gate_approved",
    );
    if (!hasIncomplete) return abandonClaim();

    normalizeJobsForResume(run);
    run.status = "running";
    delete run.completedAt;
    void persistRunStatus(rid, "running");
    await persistRunStart(rid, config.name, snap.workflow_yaml);
    appendRunEvent(rid, "RUN_RESUMED", undefined, { workflowName: config.name });

    const dag = resolveDAG(config);
    const p = resumeExecuteRun(run, config, dag.executionWaves).catch((err) => {
      run.status = "failed";
      appendRunEvent(rid, "RUN_FAILED", undefined, { error: String(err) });
      void persistRunStatus(rid, "failed");
    });
    trackRunExecution(rid, p);
    releaseLease();

    return run;
  } catch (e) {
    console.error("[bronson] continuePersistedRun:", e);
    return abandonClaim();
  }
}

function cancelAwaitingJobs(run: RunState, reason: string): void {
  const now = new Date().toISOString();
  const active: JobStatus[] = ["pending", "running", "gate_pending", "gate_approved", "awaiting_funding"];
  for (const j of Object.values(run.jobs)) {
    if (active.includes(j.status)) {
      j.status = "skipped";
      j.completedAt = now;
      j.error = reason;
    }
  }
}

function applyRunTerminalState(run: RunState, config: WorkflowConfig): void {
  const failedJobIds = Object.values(run.jobs)
    .filter((j) => j.status === "failed")
    .map((j) => j.jobId);
  if (failedJobIds.length > 0) {
    run.status = "failed";
    run.completedAt = new Date().toISOString();
    cancelAwaitingJobs(run, "Run failed");
    appendRunEvent(run.runId, "RUN_FAILED", undefined, {
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
    appendRunEvent(run.runId, "RUN_COMPLETED");
    void persistRunStatus(run.runId, "completed");
  }
}

async function executeRun(run: RunState, config: WorkflowConfig, waves: string[][]): Promise<void> {
  for (const wave of waves) {
    await Promise.all(wave.map((jobId) => executeJob(run, config, jobId)));
    if (wave.some((jobId) => run.jobs[jobId].status === "failed" && config.jobs[jobId].on_failure === "halt")) {
      run.status = "failed";
      run.completedAt = new Date().toISOString();
      appendRunEvent(run.runId, "RUN_FAILED", undefined, { reason: "Job failed with on_failure: halt" });
      void persistRunStatus(run.runId, "failed");
      return;
    }
  }

  applyRunTerminalState(run, config);
}

/** Like {@link executeRun}, but skips jobs already completed, skipped, or failed (failed are left as-is). */
async function resumeExecuteRun(run: RunState, config: WorkflowConfig, waves: string[][]): Promise<void> {
  for (const wave of waves) {
    await Promise.all(
      wave.map(async (jobId) => {
        const jobState = run.jobs[jobId];
        if (!jobState) return;
        const st = jobState.status;
        if (st === "completed" || st === "skipped" || st === "failed") return;
        await executeJob(run, config, jobId);
      }),
    );
    if (wave.some((jobId) => run.jobs[jobId].status === "failed" && config.jobs[jobId]?.on_failure === "halt")) {
      run.status = "failed";
      run.completedAt = new Date().toISOString();
      appendRunEvent(run.runId, "RUN_FAILED", undefined, { reason: "Job failed with on_failure: halt" });
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

  const { abandon, releaseLease } = await acquireRunExecutionLease(runId);

  const abandonClaim = (error: string): { error: string } => {
    abandon();
    return { error };
  };

  try {
    let run = getRun(runId);
    if (!run) run = (await hydrateRunFromDb(runId)) ?? undefined;
    if (!run) return abandonClaim("Run not found");

    const snap = await fetchRunSnapshot(runId);
    if (!snap) return abandonClaim("Run snapshot not found in database");

    let config: WorkflowConfig;
    try {
      config = parseWorkflowString(snap.workflow_yaml);
    } catch (e) {
      return abandonClaim(String(e));
    }

    if (!run.jobs[jobId]) return abandonClaim("Unknown job id");
    if (run.jobs[jobId].status !== "failed") {
      return abandonClaim(`Job is not failed (status=${run.jobs[jobId].status}); only failed jobs can be retried.`);
    }

    run.jobs[jobId] = { jobId, status: "pending", retryCount: 0 };
    run.status = "running";
    delete run.completedAt;

    const runRef = run;
    const p = (async () => {
      try {
        await executeJob(runRef, config, jobId);
        if (runRef.jobs[jobId].status === "completed") {
          await runReadyDependents(runRef, config, jobId);
        }
        applyRunTerminalState(runRef, config);
      } catch (e) {
        console.error("[bronson] retryJobAndContinue:", e);
      }
    })();

    trackRunExecution(runId, p);
    releaseLease();

    return { ok: true };
  } catch (e) {
    console.error("[bronson] retryJobAndContinue (claim setup):", e);
    return abandonClaim(String(e));
  }
}

async function executeJob(run: RunState, config: WorkflowConfig, jobId: string): Promise<void> {
  const jobConfig = config.jobs[jobId];
  const jobState = run.jobs[jobId];
  const maxAttempts = 1 + (jobConfig.max_retries ?? 0);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    jobState.status = "running";
    jobState.startedAt = new Date().toISOString();
    appendRunEvent(run.runId, "JOB_STARTED", jobId);

    const upstreamOutputs: Record<string, string> = {};
    for (const dep of jobConfig.depends_on ?? []) {
      const out = await committedJobOutput(run.runId, dep);
      if (out) upstreamOutputs[dep] = out;
    }

    const ac = attachJobAbort(run.runId, jobId);
    try {
      const result = await runAgent(
        run.runId,
        { jobId, jobConfig, contextInput: "", abortSignal: ac.signal },
        upstreamOutputs,
      );
      let finalOutput = result.output;

      if (jobConfig.gate === "human") {
        jobState.status = "gate_pending";
        run.status = "gate_pending";
        appendRunEvent(run.runId, "GATE_PENDING", jobId, { proposedOutput: result.output });

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
          appendRunEvent(run.runId, "GATE_REJECTED", jobId, { reason: decision.reason });
          await persistJobRow(run.runId, { ...jobState });
          return;
        }

        if (decision.editedOutput) finalOutput = decision.editedOutput;
        jobState.status = "gate_approved";
        await persistStepGateApproved(run.runId, jobId);
        run.status = gateManager.listPending(run.runId).length > 0 ? "gate_pending" : "running";
        await persistWorkflowRunStatus(run.runId, run.status);
        appendRunEvent(run.runId, "GATE_APPROVED", jobId);
      }

      jobState.status = "completed";
      jobState.completedAt = new Date().toISOString();
      jobState.output = finalOutput;
      jobState.tokensUsed = result.tokensUsed;
      jobState.costUsd = result.costUsd;

      appendRunEvent(run.runId, "JOB_COMPLETED", jobId, {
        output: finalOutput,
        tokensUsed: result.tokensUsed,
        costUsd: result.costUsd,
      });
      await persistJobRow(run.runId, { ...jobState });
      return;
    } catch (err) {
      const msg = String(err);
      if (msg.includes("Stopped by user")) {
        jobState.retryCount = attempt;
        jobState.status = "failed";
        jobState.completedAt = new Date().toISOString();
        jobState.error = "Stopped by user";
        appendRunEvent(run.runId, "JOB_FAILED", jobId, { error: jobState.error });
        await persistJobRow(run.runId, { ...jobState });
        return;
      }
      jobState.retryCount = attempt;
      if (attempt < maxAttempts) {
        const delayMs = 500 * Math.pow(2, attempt - 1);

        appendRunEvent(run.runId, "JOB_RETRY_WARNING", jobId, {
          attempt,
          maxAttempts,
          reason: msg,
          nextRetryDelayMs: delayMs,
        });

        await new Promise((r) => setTimeout(r, delayMs));
      } else {
        jobState.status = "failed";
        jobState.completedAt = new Date().toISOString();
        jobState.error = msg;
        appendRunEvent(run.runId, "JOB_FAILED", jobId, { error: msg });
        await persistJobRow(run.runId, { ...jobState });
      }
    } finally {
      detachJobAbort(run.runId, jobId);
    }
  }
}
