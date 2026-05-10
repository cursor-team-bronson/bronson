import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { JobState, JobStatus, RunState, RunStatus, SerializedDAG, WorkflowConfig } from "@bronson/types";
import { resolveDAG } from "../parser/dag-resolver.js";
import { parseWorkflowString } from "../parser/yaml-parser.js";

let client: SupabaseClient | null | undefined;

/** Extra context when PostgREST returns Postgres privilege errors. */
function formatPersistError(message: string): string {
  if (/permission denied for table/i.test(message)) {
    return (
      `${message} ` +
      "(These tables are granted only to `service_role`. Use the **service role** key from Supabase Dashboard → Settings → API, not the anon/publishable key. If the project is new, apply repo migration `20260510120000_bronson_orchestrator_job_persistence.sql`.)"
    );
  }
  return message;
}

function getClient(): SupabaseClient | null {
  if (client !== undefined) return client;
  const url = process.env.SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.SUPABASE_SECRET_KEY?.trim() ||
    process.env.SB_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    client = null;
    return null;
  }
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

export function isJobPersistenceEnabled(): boolean {
  return getClient() !== null;
}

export async function persistRunStart(
  runId: string,
  workflowName: string,
  workflowYaml: string,
): Promise<void> {
  const sb = getClient();
  if (!sb) return;
  const now = new Date().toISOString();
  const { error } = await sb.from("bronson_run_snapshots").upsert(
    {
      run_id: runId,
      workflow_name: workflowName,
      workflow_yaml: workflowYaml,
      status: "running",
      updated_at: now,
    },
    { onConflict: "run_id" },
  );
  if (error) throw new Error(`Failed to persist run snapshot: ${formatPersistError(error.message)}`);
}

export async function persistRunStatus(runId: string, status: RunStatus): Promise<void> {
  const sb = getClient();
  if (!sb) return;
  const { error } = await sb
    .from("bronson_run_snapshots")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("run_id", runId);
  if (error) console.error("[bronson] persistRunStatus:", error.message);
}

type JobRow = {
  job_id: string;
  status: string;
  output_text: string | null;
  error_message: string | null;
  tokens_used: number | null;
  cost_usd: number | null;
  started_at: string | null;
  completed_at: string | null;
};

function rowToJobState(row: JobRow): JobState {
  return {
    jobId: row.job_id,
    status: row.status as JobStatus,
    retryCount: 0,
    output: row.output_text ?? undefined,
    error: row.error_message ?? undefined,
    tokensUsed: row.tokens_used ?? undefined,
    costUsd: row.cost_usd ?? undefined,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
  };
}

export async function persistJobRow(
  runId: string,
  job: JobState,
): Promise<void> {
  const sb = getClient();
  if (!sb) return;
  const now = new Date().toISOString();
  const { error } = await sb.from("bronson_job_outputs").upsert(
    {
      run_id: runId,
      job_id: job.jobId,
      status: job.status,
      output_text: job.output ?? null,
      error_message: job.error ?? null,
      tokens_used: job.tokensUsed ?? null,
      cost_usd: job.costUsd ?? null,
      started_at: job.startedAt ?? null,
      completed_at: job.completedAt ?? null,
      updated_at: now,
    },
    { onConflict: "run_id,job_id" },
  );
  if (error) {
    console.error("[bronson] persistJobRow:", job.jobId, error.message);
    throw new Error(`Failed to persist job ${job.jobId}: ${formatPersistError(error.message)}`);
  }
}

/** Completed-job text for upstream context (deps), after restart or from another worker. */
export async function fetchJobOutputFromDb(runId: string, jobId: string): Promise<string | undefined> {
  const sb = getClient();
  if (!sb) return undefined;
  const { data, error } = await sb
    .from("bronson_job_outputs")
    .select("output_text,status")
    .eq("run_id", runId)
    .eq("job_id", jobId)
    .maybeSingle();
  if (error || !data || data.status !== "completed") return undefined;
  const t = data.output_text;
  return typeof t === "string" && t.length ? t : undefined;
}

export type RunSnapshotRow = {
  run_id: string;
  workflow_name: string;
  workflow_yaml: string;
  status: string;
  created_at: string;
};

export async function fetchRunSnapshot(runId: string): Promise<RunSnapshotRow | null> {
  const sb = getClient();
  if (!sb) return null;
  const { data, error } = await sb.from("bronson_run_snapshots").select("*").eq("run_id", runId).maybeSingle();
  if (error || !data) return null;
  return data as RunSnapshotRow;
}

export async function fetchJobRows(runId: string): Promise<JobRow[]> {
  const sb = getClient();
  if (!sb) return [];
  const { data, error } = await sb.from("bronson_job_outputs").select("*").eq("run_id", runId);
  if (error || !data) return [];
  return data as JobRow[];
}

export function buildRunStateFromPersistence(
  runId: string,
  snapshot: RunSnapshotRow,
  rows: JobRow[],
): { run: RunState; config: WorkflowConfig } {
  const config = parseWorkflowString(snapshot.workflow_yaml);
  const dag = resolveDAG(config);
  const serializedDag: SerializedDAG = {
    nodes: Array.from(dag.nodes.values()).map((n) => ({
      jobId: n.jobId,
      dependencies: n.dependencies,
      dependents: n.dependents,
    })),
    executionWaves: dag.executionWaves,
  };

  const byId = new Map(rows.map((r) => [r.job_id, r]));
  const jobs: Record<string, JobState> = {};
  for (const jobId of dag.nodes.keys()) {
    const row = byId.get(jobId);
    jobs[jobId] = row ? rowToJobState(row) : { jobId, status: "pending", retryCount: 0 };
  }

  const runStatus = deriveRunStatusFromJobs(jobs);
  const run: RunState = {
    runId,
    workflowName: snapshot.workflow_name,
    status: runStatus,
    createdAt: snapshot.created_at,
    jobs,
    dag: serializedDag,
  };
  return { run, config };
}

function deriveRunStatusFromJobs(jobs: Record<string, JobState>): RunStatus {
  const list = Object.values(jobs);
  if (list.some((j) => j.status === "failed")) return "failed";
  if (list.some((j) => j.status === "gate_pending")) return "gate_pending";
  if (list.some((j) => j.status === "running" || j.status === "gate_approved")) return "running";
  if (list.every((j) => j.status === "completed" || j.status === "skipped")) return "completed";
  return "running";
}
