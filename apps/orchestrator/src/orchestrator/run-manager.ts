import { v4 as uuidv4 } from "uuid";
import {
  WorkflowConfig,
  RunState,
  JobState,
  JobStatus,
  SerializedDAG,
  EventType,
  UpstreamKind,
} from "@bronson/types";
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
import { attachJobAbort, detachJobAbort, stopJobRequest } from "./job-abort-registry.js";
import {
  budgetTracker,
  BudgetExceededError,
  BudgetCheckoutUnavailableError,
} from "./budget-tracker.js";

const runs = new Map<string, RunState>();
const killed = new Set<string>();

/** In-flight DAG execution per run (avoids overlapping resume/start on the same run id). */
const runExecutionPromises = new Map<string, Promise<void>>();

function trackRunExecution(runId: string, p: Promise<void>): void {
  runExecutionPromises.set(runId, p);
  void p.finally(() => {
    if (runExecutionPromises.get(runId) === p) runExecutionPromises.delete(runId);
    killed.delete(runId);
  });
}

function normalizeJobsForResume(run: RunState): void {
  for (const j of Object.values(run.jobs)) {
    if (
      j.status === "running" ||
      j.status === "gate_approved" ||
      j.status === "gate_pending" ||
      j.status === "awaiting_funding"
    ) {
      j.status = "pending";
      j.retryCount = 0;
      delete j.startedAt;
      delete j.completedAt;
      delete j.output;
      delete j.tokensUsed;
      delete j.costUsd;
      delete j.error;
      delete j.checkoutUrl;
    }
  }
}

export const getRun = (runId: string) => runs.get(runId);
export const getRunDag = (runId: string) => getRun(runId)?.dag;
export const listRuns = () => [...runs.values()];
export const isKilled = (runId: string) => killed.has(runId);

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

async function gatherUpstreamPayload(
  runId: string,
  deps: string[],
  run: RunState,
): Promise<{ outputs: Record<string, string>; kinds: Record<string, UpstreamKind> }> {
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
      continue;
    }
    const fromDb = await fetchJobOutputFromDb(runId, dep);
    if (fromDb !== undefined) {
      outputs[dep] = fromDb;
      kinds[dep] = "completed";
      continue;
    }
    const js = run.jobs[dep];
    if (js?.status === "failed" && js.error) {
      outputs[dep] = js.error;
      kinds[dep] = "failed";
    }
  }

  return { outputs, kinds };
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

  for (const [jobId, jobConfig] of Object.entries(config.jobs)) {
    if (jobConfig.budget_usd) budgetTracker.register(runId, jobId, jobConfig.budget_usd);
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
    if (killed.has(runId)) return;
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

  let releaseClaim!: () => void;
  const claim = new Promise<void>((r) => {
    releaseClaim = r;
  });
  runExecutionPromises.set(rid, claim);

  const abandonClaim = (): null => {
    if (runExecutionPromises.get(rid) === claim) runExecutionPromises.delete(rid);
    releaseClaim();
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
        j.status === "gate_approved" ||
        j.status === "awaiting_funding",
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
      if (killed.has(rid)) return;
      run.status = "failed";
      run.completedAt = run.completedAt ?? new Date().toISOString();
      appendRunEvent(rid, "RUN_FAILED", undefined, { error: String(err) });
      void persistRunStatus(rid, "failed");
    });
    trackRunExecution(rid, p);
    releaseClaim();

    return run;
  } catch (e) {
    console.error("[bronson] continuePersistedRun:", e);
    return abandonClaim();
  }
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
  appendRunEvent(runId, "BUDGET_FUNDED", jobId, { amountUsd, intentId });
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
  for (const jid of Object.keys(run.jobs)) {
    stopJobRequest(runId, jid);
  }
  run.status = "failed";
  run.completedAt = new Date().toISOString();
  cancelBudgetFundingAwaiters(run, "Run killed by user");
  gateManager.cancelAll(runId, "Run killed by user");
  const terminalAt = new Date().toISOString();
  for (const [_jobId, jobState] of Object.entries(run.jobs)) {
    if (jobState.status === "running" || jobState.status === "gate_pending" || jobState.status === "gate_approved" || jobState.status === "awaiting_funding") {
      jobState.status = "failed";
      jobState.error = "Run killed by user";
      jobState.checkoutUrl = undefined;
      jobState.completedAt = terminalAt;
    }
    if (jobState.status === "pending") {
      jobState.status = "skipped";
      jobState.completedAt = terminalAt;
    }
  }
  appendRunEvent(runId, "RUN_FAILED", undefined, { reason: "Killed by user" });
  void persistRunStatus(runId, "failed");
  for (const [, jobState] of Object.entries(run.jobs)) {
    void persistJobRow(runId, { ...jobState }).catch((e) =>
      console.error("[bronson] stopRun persistJobRow:", jobState.jobId, e),
    );
  }
}

/** Release jobs blocked on budget funding (side-effect only — does not change job status). Used by stopRun before applying explicit terminal statuses. */
function cancelBudgetFundingAwaiters(run: RunState, reason: string): void {
  for (const j of Object.values(run.jobs)) {
    if (j.status === "awaiting_funding") {
      budgetTracker.cancelFunding(run.runId, j.jobId, reason);
    }
  }
}

function cancelAwaitingJobs(run: RunState, reason: string): void {
  const now = new Date().toISOString();
  const active: JobStatus[] = ["pending", "running", "gate_pending", "gate_approved", "awaiting_funding"];
  for (const j of Object.values(run.jobs)) {
    if (active.includes(j.status)) {
      if (j.status === "awaiting_funding") {
        budgetTracker.cancelFunding(run.runId, j.jobId, reason);
      }
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
    if (killed.has(run.runId)) return;
    await Promise.all(wave.map((jobId) => executeJob(run, config, jobId)));
    if (killed.has(run.runId)) return;
    if (wave.some((jobId) => run.jobs[jobId].status === "failed" && config.jobs[jobId].on_failure === "halt")) {
      run.status = "failed";
      run.completedAt = new Date().toISOString();
      appendRunEvent(run.runId, "RUN_FAILED", undefined, { reason: "Job failed with on_failure: halt" });
      void persistRunStatus(run.runId, "failed");
      return;
    }
  }

  if (killed.has(run.runId)) return;
  applyRunTerminalState(run, config);
}

/** Like {@link executeRun}, but skips jobs already completed, skipped, or failed (failed are left as-is). */
async function resumeExecuteRun(run: RunState, config: WorkflowConfig, waves: string[][]): Promise<void> {
  for (const wave of waves) {
    if (killed.has(run.runId)) return;
    await Promise.all(
      wave.map(async (jobId) => {
        const jobState = run.jobs[jobId];
        if (!jobState) return;
        const st = jobState.status;
        if (st === "completed" || st === "skipped" || st === "failed") return;
        await executeJob(run, config, jobId);
      }),
    );
    if (killed.has(run.runId)) return;
    if (wave.some((jobId) => run.jobs[jobId].status === "failed" && config.jobs[jobId]?.on_failure === "halt")) {
      run.status = "failed";
      run.completedAt = new Date().toISOString();
      appendRunEvent(run.runId, "RUN_FAILED", undefined, { reason: "Job failed with on_failure: halt" });
      void persistRunStatus(run.runId, "failed");
      return;
    }
  }

  if (killed.has(run.runId)) return;
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
  if (killed.has(runId)) {
    return { error: "Run was killed — cannot retry jobs on a killed run" };
  }
  if (!isJobPersistenceEnabled()) {
    return {
      error:
        "Job persistence is disabled. Set SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY on the orchestrator.",
    };
  }

  if (runExecutionPromises.has(runId)) {
    await runExecutionPromises.get(runId)!;
  }

  let releaseClaim!: () => void;
  const claim = new Promise<void>((r) => {
    releaseClaim = r;
  });
  runExecutionPromises.set(runId, claim);

  const abandonClaim = (error: string): { error: string } => {
    if (runExecutionPromises.get(runId) === claim) runExecutionPromises.delete(runId);
    releaseClaim();
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
        if (killed.has(runId)) return;
        if (runRef.jobs[jobId].status === "completed") {
          await runReadyDependents(runRef, config, jobId);
        }
        if (killed.has(runId)) return;
        applyRunTerminalState(runRef, config);
      } catch (e) {
        if (killed.has(runId)) return;
        console.error("[bronson] retryJobAndContinue:", e);
      }
    })();

    trackRunExecution(runId, p);
    releaseClaim();

    return { ok: true };
  } catch (e) {
    console.error("[bronson] retryJobAndContinue (claim setup):", e);
    return abandonClaim(String(e));
  }
}

async function executeJob(run: RunState, config: WorkflowConfig, jobId: string): Promise<void> {
  if (killed.has(run.runId)) return;
  const jobConfig = config.jobs[jobId];
  const jobState = run.jobs[jobId];
  const maxAttempts = 1 + (jobConfig.max_retries ?? 0);

  const priorAttemptErrors: string[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (killed.has(run.runId)) return;
    jobState.status = "running";
    jobState.startedAt = new Date().toISOString();

    const { outputs: upstreamOutputs, kinds: upstreamKind } = await gatherUpstreamPayload(
      run.runId,
      jobConfig.depends_on ?? [],
      run,
    );
    if (killed.has(run.runId)) return;

    const ac = attachJobAbort(run.runId, jobId);
    try {
      const result = await runAgent(
        run.runId,
        {
          jobId,
          jobConfig,
          contextInput: "",
          abortSignal: ac.signal,
          priorAttemptErrors: priorAttemptErrors.length > 0 ? [...priorAttemptErrors] : undefined,
          upstreamKind: Object.keys(upstreamKind).length > 0 ? upstreamKind : undefined,
        },
        upstreamOutputs,
      );
      if (killed.has(run.runId)) return;
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
        if (killed.has(run.runId)) return;

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

      if (killed.has(run.runId)) return;
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
      if (killed.has(run.runId)) return;

      if (err instanceof BudgetCheckoutUnavailableError) {
        jobState.status = "failed";
        jobState.completedAt = new Date().toISOString();
        jobState.error = err.message;
        appendRunEvent(run.runId, "JOB_FAILED", jobId, { error: err.message });
        await persistJobRow(run.runId, { ...jobState });
        return;
      }

      if (err instanceof BudgetExceededError) {
        jobState.status = "awaiting_funding";
        jobState.checkoutUrl = err.checkoutUrl;
        run.status = "awaiting_funding";
        appendRunEvent(run.runId, "BUDGET_EXCEEDED", jobId, {
          spentUsd: err.spentUsd,
          limitUsd: err.limitUsd,
          checkoutUrl: err.checkoutUrl,
          intentId: err.intentId,
        });
        await persistJobRow(run.runId, { ...jobState });
        await persistWorkflowRunStatus(run.runId, run.status);
        if (killed.has(run.runId)) return;

        try {
          await budgetTracker.waitForFunding(run.runId, jobId);
        } catch (fundErr) {
          if (killed.has(run.runId)) return;
          jobState.status = "failed";
          jobState.completedAt = new Date().toISOString();
          jobState.error = String(fundErr);
          appendRunEvent(run.runId, "JOB_FAILED", jobId, { error: String(fundErr) });
          await persistJobRow(run.runId, { ...jobState });
          return;
        }

        if (killed.has(run.runId)) return;
        const stillAwaiting = budgetTracker.listAwaiting(run.runId).some((j) => j.jobId !== jobId);
        run.status = stillAwaiting ? "awaiting_funding" : "running";
        appendRunEvent(run.runId, "JOB_RESUMED", jobId);
        await persistWorkflowRunStatus(run.runId, run.status);

        if (err.output !== undefined) {
          let finalOutput = err.output;

          if (jobConfig.gate === "human") {
            jobState.status = "gate_pending";
            run.status = "gate_pending";
            appendRunEvent(run.runId, "GATE_PENDING", jobId, { proposedOutput: finalOutput });

            const decision = await gateManager.waitForApproval({
              runId: run.runId,
              jobId,
              proposedOutput: finalOutput,
              context: Object.values(upstreamOutputs).join("\n\n"),
            });

            if (killed.has(run.runId)) return;
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

          if (killed.has(run.runId)) return;
          jobState.status = "completed";
          jobState.completedAt = new Date().toISOString();
          jobState.output = finalOutput;
          jobState.tokensUsed = err.tokensUsed ?? 0;
          jobState.costUsd = err.costUsd ?? 0;
          jobState.checkoutUrl = undefined;
          appendRunEvent(run.runId, "JOB_COMPLETED", jobId, {
            output: finalOutput,
            tokensUsed: err.tokensUsed ?? 0,
            costUsd: err.costUsd ?? 0,
          });
          await persistJobRow(run.runId, { ...jobState });
          return;
        }

        attempt--;
        continue;
      }

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
      priorAttemptErrors.push(`Attempt ${attempt}: ${msg}`);
      if (attempt < maxAttempts) {
        const delayMs = 500 * Math.pow(2, attempt - 1);

        appendRunEvent(run.runId, "JOB_RETRY_WARNING", jobId, {
          attempt,
          maxAttempts,
          reason: msg,
          nextRetryDelayMs: delayMs,
        });

        await new Promise((r) => setTimeout(r, delayMs));
        if (killed.has(run.runId)) return;
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
