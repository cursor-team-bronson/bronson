import yaml from "js-yaml";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  JobConfigSchema,
  type AgentRunResult,
  type JobConfig,
  type JobStatus,
  type RunState,
  type RunStatus,
  type SerializedDAG,
  type WorkflowConfig,
} from "@bronson/types";
import { resolveDAG } from "../parser/dag-resolver.js";
import { getSupabase } from "./supabase-client.js";

export interface RunPersistenceContext {
  workflowId: string;
  stepIdByJobId: Record<string, string>;
  stepRunIdByJobId: Record<string, string>;
}

const ctxByRunId = new Map<string, RunPersistenceContext>();

function logErr(scope: string, err: unknown) {
  console.error(`[supabase] ${scope}`, err);
}

/** Canonical stored description: empty / whitespace-only YAML is stored as NULL. */
function normalizeWorkflowDescription(rawYaml?: string): string | null {
  const t = rawYaml?.trim();
  return t ? t : null;
}

/**
 * Reuse a workflow row when name + description match AND every job has an identical `steps` row.
 * Otherwise insert a new workflow and steps (catalog lists one row per logical name via dedupe).
 */
async function resolveWorkflowAndStepIds(
  sb: SupabaseClient,
  config: WorkflowConfig,
  rawYaml?: string,
): Promise<{ workflowId: string; stepIdByJobId: Record<string, string> } | null> {
  const desc = normalizeWorkflowDescription(rawYaml);

  let wfQuery = sb.from("workflows").select("id").eq("name", config.name);
  if (desc === null) wfQuery = wfQuery.is("description", null);
  else wfQuery = wfQuery.eq("description", desc);

  const { data: matchedWf } = await wfQuery.maybeSingle();

  if (matchedWf?.id) {
    const wfId = matchedWf.id as string;
    const { data: stepRows, error: stErr } = await sb
      .from("steps")
      .select("id, name, yaml_config")
      .eq("workflow_id", wfId);

    if (!stErr && stepRows?.length) {
      const stepIdByJobId: Record<string, string> = {};
      let reuseOk = true;
      for (const jobId of Object.keys(config.jobs)) {
        const row = stepRows.find((r: { name: string; id: string; yaml_config: unknown }) => r.name === jobId);
        const wantYaml = yaml.dump(config.jobs[jobId]);
        if (!row || row.yaml_config !== wantYaml) {
          reuseOk = false;
          break;
        }
        stepIdByJobId[jobId] = row.id as string;
      }
      if (reuseOk && Object.keys(stepIdByJobId).length === Object.keys(config.jobs).length) {
        const { error: touchErr } = await sb
          .from("workflows")
          .update({ updated_at: new Date().toISOString() })
          .eq("id", wfId);
        if (touchErr) logErr("workflows.touch", touchErr);
        return { workflowId: wfId, stepIdByJobId };
      }
    }
  }

  const { data: wf, error: wfErr } = await sb
    .from("workflows")
    .insert({
      name: config.name,
      description: desc,
    })
    .select("id")
    .single();

  if (wfErr || !wf) {
    logErr("workflows.insert", wfErr);
    return null;
  }

  const workflowId = wf.id as string;

  const stepRows = Object.entries(config.jobs).map(([name, job]) => ({
    workflow_id: workflowId,
    name,
    yaml_config: yaml.dump(job),
    depends_on: job.depends_on ?? [],
    context_budget: job.context_budget,
  }));

  const { data: insertedSteps, error: stepErr } = await sb.from("steps").insert(stepRows).select("id, name");

  if (stepErr || !insertedSteps?.length) {
    logErr("steps.insert", stepErr);
    return null;
  }

  const stepIdByJobId: Record<string, string> = {};
  for (const row of insertedSteps) {
    stepIdByJobId[row.name as string] = row.id as string;
  }

  return { workflowId, stepIdByJobId };
}

export async function persistBeginRun(params: {
  runId: string;
  config: WorkflowConfig;
  rawYaml?: string;
}): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;

  const { runId, config, rawYaml } = params;

  try {
    const resolved = await resolveWorkflowAndStepIds(sb, config, rawYaml);
    if (!resolved) return;

    const { workflowId, stepIdByJobId } = resolved;

    const { error: wrErr } = await sb.from("workflow_runs").insert({
      id: runId,
      workflow_id: workflowId,
      status: "running",
    });

    if (wrErr) {
      logErr("workflow_runs.insert", wrErr);
      return;
    }

    const stepRunIdByJobId: Record<string, string> = {};
    for (const jobId of Object.keys(config.jobs)) {
      const stepId = stepIdByJobId[jobId];
      if (!stepId) continue;
      const { data: sr, error: srErr } = await sb
        .from("step_runs")
        .insert({
          run_id: runId,
          step_id: stepId,
          status: "pending",
        })
        .select("id")
        .single();

      if (srErr || !sr) {
        logErr(`step_runs.insert(${jobId})`, srErr);
        continue;
      }
      stepRunIdByJobId[jobId] = sr.id as string;
    }

    ctxByRunId.set(runId, { workflowId, stepIdByJobId, stepRunIdByJobId });
  } catch (e) {
    logErr("persistBeginRun", e);
  }
}

async function patchWorkflowRun(runId: string, patch: Record<string, unknown>) {
  const sb = getSupabase();
  if (!sb) return;
  const { error } = await sb.from("workflow_runs").update(patch).eq("id", runId);
  if (error) logErr("workflow_runs.update", error);
}

async function patchStepRun(runId: string, jobId: string, patch: Record<string, unknown>) {
  const ctx = ctxByRunId.get(runId);
  const sb = getSupabase();
  if (!sb || !ctx) return;
  const stepRunId = ctx.stepRunIdByJobId[jobId];
  if (!stepRunId) return;
  const { error } = await sb.from("step_runs").update(patch).eq("id", stepRunId);
  if (error) logErr(`step_runs.update(${jobId})`, error);
}

/** Gate / concurrency: only apply patch when `step_runs.status` is one of `allowedCurrent`. */
async function patchStepRunWhenStatus(
  runId: string,
  jobId: string,
  patch: Record<string, unknown>,
  allowedCurrent: string[],
): Promise<boolean> {
  const ctx = ctxByRunId.get(runId);
  const sb = getSupabase();
  if (!sb || !ctx) return false;
  const stepRunId = ctx.stepRunIdByJobId[jobId];
  if (!stepRunId) return false;

  const { data, error } = await sb
    .from("step_runs")
    .update(patch)
    .eq("id", stepRunId)
    .in("status", allowedCurrent)
    .select("id");

  if (error) {
    logErr(`step_runs.update(${jobId})`, error);
    return false;
  }
  if (!data?.length) {
    console.warn(
      `[supabase] step_runs stale gate transition skipped (${jobId}): expected status ∈ [${allowedCurrent.join(", ")}]`,
    );
    return false;
  }
  return true;
}

export async function persistWorkflowRunStatus(runId: string, status: string) {
  await patchWorkflowRun(runId, { status });
}

export async function persistWorkflowRunTerminal(runId: string, status: string, completedAt: string) {
  const sb = getSupabase();
  if (!sb) return;
  const { error } = await sb
    .from("workflow_runs")
    .update({ status, completed_at: completedAt })
    .eq("id", runId);
  if (error) logErr("workflow_runs.update", error);
  else ctxByRunId.delete(runId);
}

export async function persistStepRunning(
  runId: string,
  jobId: string,
  inputContext: Record<string, unknown>,
) {
  await patchStepRun(runId, jobId, {
    status: "running",
    started_at: new Date().toISOString(),
    input_context: inputContext,
  });
}

export async function persistStepGatePending(runId: string, jobId: string, proposedOutput: string) {
  await patchStepRunWhenStatus(
    runId,
    jobId,
    {
      status: "gate_pending",
      output_data: { proposedOutput, gate: "pending" },
    },
    ["running"],
  );
}

export async function persistStepGateApproved(runId: string, jobId: string) {
  await patchStepRunWhenStatus(runId, jobId, { status: "gate_approved" }, ["gate_pending"]);
}

export async function persistStepGateRejected(runId: string, jobId: string, reason?: string) {
  await patchStepRunWhenStatus(
    runId,
    jobId,
    {
      status: "failed",
      error_message: reason ?? "Gate rejected",
      completed_at: new Date().toISOString(),
    },
    ["gate_pending"],
  );
}

export async function persistStepRetry(
  runId: string,
  jobId: string,
  attempt: number,
  maxAttempts: number,
  reason: string,
) {
  await patchStepRun(runId, jobId, {
    retry_count: attempt,
    output_data: { retryWarning: true, attempt, maxAttempts, reason },
  });
}

export async function persistStepCompleted(
  runId: string,
  jobId: string,
  jobConfig: JobConfig,
  finalOutput: string,
  result: AgentRunResult,
) {
  await patchStepRun(runId, jobId, {
    status: "completed",
    completed_at: new Date().toISOString(),
    output_data: {
      output: finalOutput,
      tokensUsed: result.tokensUsed,
      costUsd: result.costUsd,
    },
    error_message: null,
  });

  const ctx = ctxByRunId.get(runId);
  const sb = getSupabase();
  if (!sb || !ctx) return;
  const stepRunId = ctx.stepRunIdByJobId[jobId];
  if (!stepRunId) return;

  const { error } = await sb.from("usage_metrics").insert({
    step_run_id: stepRunId,
    model_name: jobConfig.model,
    prompt_tokens: result.promptTokens ?? 0,
    completion_tokens: result.completionTokens ?? 0,
    total_tokens: result.tokensUsed,
    cost_usd: result.costUsd,
  });
  if (error) logErr("usage_metrics.insert", error);
}

export async function persistStepFailed(runId: string, jobId: string, errorMessage: string) {
  await patchStepRun(runId, jobId, {
    status: "failed",
    error_message: errorMessage,
    completed_at: new Date().toISOString(),
  });
}

function mapDbJobStatus(s: string): JobStatus {
  switch (s) {
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "gate_pending":
      return "gate_pending";
    case "gate_approved":
      return "gate_approved";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "awaiting_funding":
      return "awaiting_funding";
    default:
      return "pending";
  }
}

function mapDbRunStatus(s: string): RunStatus {
  switch (s) {
    case "running":
      return "running";
    case "gate_pending":
      return "gate_pending";
    case "awaiting_funding":
      return "awaiting_funding";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "running";
  }
}

/** Reconstruct run state from Supabase (for cold reads after restart). */
export async function hydrateRunFromDatabase(runId: string): Promise<RunState | null> {
  const sb = getSupabase();
  if (!sb) return null;

  const { data: wr, error: wrErr } = await sb
    .from("workflow_runs")
    .select("id, workflow_id, status, created_at, completed_at")
    .eq("id", runId)
    .maybeSingle();

  if (wrErr || !wr) return null;

  const { data: wf, error: wfErr } = await sb
    .from("workflows")
    .select("id, name")
    .eq("id", wr.workflow_id)
    .maybeSingle();

  if (wfErr || !wf) return null;

  type StepRow = {
    id: string;
    status: string;
    input_context: Record<string, unknown> | null;
    output_data: Record<string, unknown> | null;
    retry_count: number | null;
    error_message: string | null;
    started_at: string | null;
    completed_at: string | null;
    steps:
      | {
          name: string;
          yaml_config: string;
        }
      | {
          name: string;
          yaml_config: string;
        }[]
      | null;
  };

  const { data: srList, error: srErr } = await sb
    .from("step_runs")
    .select(
      `
      id,
      status,
      input_context,
      output_data,
      retry_count,
      error_message,
      started_at,
      completed_at,
      steps (
        name,
        yaml_config
      )
    `,
    )
    .eq("run_id", runId);

  if (srErr || !srList?.length) return null;

  const jobs: RunState["jobs"] = {};
  const jobsConfig: Record<string, JobConfig> = {};

  for (const row of srList as StepRow[]) {
    const rawStep = row.steps;
    const step = Array.isArray(rawStep) ? rawStep[0] : rawStep;
    if (!step) continue;
    const parsed = yaml.load(step.yaml_config);
    const parsedJob = JobConfigSchema.safeParse(parsed);
    if (!parsedJob.success) continue;
    jobsConfig[step.name] = parsedJob.data;

    const out = row.output_data;
    jobs[step.name] = {
      jobId: step.name,
      status: mapDbJobStatus(row.status),
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      output: typeof out?.output === "string" ? out.output : undefined,
      tokensUsed: typeof out?.tokensUsed === "number" ? out.tokensUsed : undefined,
      costUsd: typeof out?.costUsd === "number" ? out.costUsd : undefined,
      retryCount: row.retry_count ?? 0,
      error: row.error_message ?? undefined,
    };
  }

  let dag: SerializedDAG | undefined;
  try {
    const resolved = resolveDAG({ name: wf.name as string, jobs: jobsConfig });
    dag = {
      nodes: Array.from(resolved.nodes.values()).map(n => ({
        jobId: n.jobId,
        dependencies: n.dependencies,
        dependents: n.dependents,
      })),
      executionWaves: resolved.executionWaves,
    };
  } catch {
    dag = undefined;
  }

  return {
    runId: wr.id as string,
    workflowName: wf.name as string,
    status: mapDbRunStatus(wr.status as string),
    createdAt: wr.created_at as string,
    completedAt: (wr.completed_at as string | null) ?? undefined,
    jobs,
    ...(dag ? { dag } : {}),
  };
}

export async function listWorkflowRunsFromDb(
  limit = 50,
): Promise<
  Array<{
    id: string;
    workflow_id: string;
    status: string;
    created_at: string;
    completed_at: string | null;
    workflow_name?: string;
  }>
> {
  const sb = getSupabase();
  if (!sb) return [];

  const lim = Math.min(100, Math.max(1, limit));
  const { data, error } = await sb
    .from("workflow_runs")
    .select(
      `
      id,
      workflow_id,
      status,
      created_at,
      completed_at,
      workflows ( name )
    `,
    )
    .order("created_at", { ascending: false })
    .limit(lim);

  if (error || !data) {
    logErr("workflow_runs.list", error);
    return [];
  }

  return data.map((row: Record<string, unknown>) => {
    const w = row.workflows as { name?: string } | { name?: string }[] | null;
    const workflow_name = Array.isArray(w) ? w[0]?.name : w?.name;
    return {
      id: row.id as string,
      workflow_id: row.workflow_id as string,
      status: row.status as string,
      created_at: row.created_at as string,
      completed_at: (row.completed_at as string | null) ?? null,
      workflow_name,
    };
  });
}

export async function listWorkflowsFromDb(limit = 50): Promise<
  Array<{
    id: string;
    name: string;
    description: string | null;
    created_at: string;
    updated_at: string;
  }>
> {
  const sb = getSupabase();
  if (!sb) return [];

  const lim = Math.min(100, Math.max(1, limit));
  const fetchCap = Math.min(500, lim * 20);
  const { data, error } = await sb
    .from("workflows")
    .select("id, name, description, created_at, updated_at")
    .order("updated_at", { ascending: false })
    .limit(fetchCap);

  if (error || !data) {
    logErr("workflows.list", error);
    return [];
  }

  const rows = data as Array<{
    id: string;
    name: string;
    description: string | null;
    created_at: string;
    updated_at: string;
  }>;

  const seen = new Set<string>();
  const deduped: typeof rows = [];
  for (const row of rows) {
    if (seen.has(row.name)) continue;
    seen.add(row.name);
    deduped.push(row);
    if (deduped.length >= lim) break;
  }

  return deduped;
}

export async function getWorkflowWithSteps(workflowId: string): Promise<{
  workflow: {
    id: string;
    name: string;
    description: string | null;
    created_at: string;
    updated_at: string;
  };
  steps: Array<{
    id: string;
    workflow_id: string;
    name: string;
    yaml_config: string;
    depends_on: string[];
    context_budget: number | null;
    created_at: string;
  }>;
} | null> {
  const sb = getSupabase();
  if (!sb) return null;

  const { data: workflow, error: wfErr } = await sb
    .from("workflows")
    .select("id, name, description, created_at, updated_at")
    .eq("id", workflowId)
    .maybeSingle();

  if (wfErr || !workflow) return null;

  const { data: steps, error: stErr } = await sb
    .from("steps")
    .select("id, workflow_id, name, yaml_config, depends_on, context_budget, created_at")
    .eq("workflow_id", workflowId)
    .order("created_at", { ascending: true });

  if (stErr) {
    logErr("steps.select", stErr);
    return null;
  }

  type Wf = {
    id: string;
    name: string;
    description: string | null;
    created_at: string;
    updated_at: string;
  };
  type St = {
    id: string;
    workflow_id: string;
    name: string;
    yaml_config: string;
    depends_on: string[];
    context_budget: number | null;
    created_at: string;
  };

  return {
    workflow: workflow as Wf,
    steps: (steps ?? []) as St[],
  };
}
