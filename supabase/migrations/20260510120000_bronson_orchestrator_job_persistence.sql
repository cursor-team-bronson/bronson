-- Persist orchestrator runs + per-job outputs (orchestrator uses service_role; not exposed to anon).
create table if not exists public.bronson_run_snapshots (
  run_id uuid primary key,
  workflow_name text not null,
  workflow_yaml text not null,
  status text not null default 'running',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bronson_job_outputs (
  run_id uuid not null references public.bronson_run_snapshots (run_id) on delete cascade,
  job_id text not null,
  status text not null,
  output_text text,
  error_message text,
  tokens_used bigint,
  cost_usd double precision,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (run_id, job_id)
);

create index if not exists bronson_job_outputs_run_id_idx on public.bronson_job_outputs (run_id);

revoke all on table public.bronson_run_snapshots from anon, authenticated;
revoke all on table public.bronson_job_outputs from anon, authenticated;
grant all on table public.bronson_run_snapshots to service_role;
grant all on table public.bronson_job_outputs to service_role;
