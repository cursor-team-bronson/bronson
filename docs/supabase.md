# Supabase persistence (orchestrator)

The orchestrator can write workflow definitions, each run, step executions, token usage, and related fields into Supabase when credentials are set. If Supabase env vars are omitted, behavior is unchanged except there is no durable storage or hydration.

## Environment variables

Set **both** URL and key on the process that runs the orchestrator (for example `apps/orchestrator/.env`). The loader in `apps/orchestrator/src/index.ts` searches common paths.

| Variable | Purpose |
|----------|---------|
| `SUPABASE_URL` or `NEXT_PUBLIC_SUPABASE_URL` | Project URL (`https://….supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | **Recommended for the orchestrator server** — bypasses RLS so inserts/updates succeed without client policies |
| `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_ANON_KEY`, or `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Works only if your RLS policies allow the needed `INSERT`/`UPDATE`/`SELECT` |

Put keys on **separate lines** in `.env`. Do not commit real keys.

The Next.js app can keep `NEXT_PUBLIC_*` for browser Supabase usage; the orchestrator may reuse the same names.

## Tables (expected shape)

Align your Supabase schema with the DDL you are using. The code assumes:

- **`workflows`** — blueprint (`name`, optional `description`; we store the submitted YAML in `description` when present).
- **`steps`** — one row per job/node (`workflow_id`, `name`, `yaml_config`, `depends_on` text array, `context_budget`).
- **`workflow_runs`** — one row per execution (`id` set to the orchestrator run UUID, `workflow_id`, `status`, timestamps).
- **`step_runs`** — one row per step per run (`run_id`, `step_id`, `status`, `input_context`, `output_data`, `retry_count`, `error_message`, timestamps). Status values used include `pending`, `running`, `gate_pending`, `gate_approved`, `completed`, `failed`.
- **`usage_metrics`** — one row per successful LLM completion (`step_run_id`, `model_name`, token counts, `cost_usd`).

Indexes on `step_runs(run_id)` and `usage_metrics(step_run_id)` match your design.

## Row Level Security

If you use the **publishable/anon** key, enable policies that allow the orchestrator to insert and update these tables (or use the **service role** key only on the backend and keep RLS strict for anon).

Example **development-only** policies (adjust for production):

```sql
ALTER TABLE workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE step_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_metrics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "orch_workflows_all" ON workflows FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "orch_steps_all" ON steps FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "orch_workflow_runs_all" ON workflow_runs FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "orch_step_runs_all" ON step_runs FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "orch_usage_metrics_all" ON usage_metrics FOR ALL USING (true) WITH CHECK (true);
```

Prefer narrowing policies (e.g. `service_role` only or authenticated users) instead of `true` in production.

## HTTP API (orchestrator)

When Supabase is configured:

| Method | Path | Description |
|--------|------|--------------|
| `GET` | `/api/runs/db/history?limit=50` | Recent `workflow_runs` with workflow name |
| `GET` | `/api/catalog/workflows` | Recent workflows |
| `GET` | `/api/catalog/workflows/:workflowId` | One workflow and its `steps` |

`GET /api/runs/:runId` and `GET /api/runs/:runId/dag` use in-memory state first, then **hydrate from Supabase** if the run is not in memory (e.g. after a restart).

Live **SSE** (`/api/runs/:runId/events`) and in-memory **event history** are not replayed from Supabase; only checkpoint-style fields in `step_runs` / `usage_metrics` are durable unless you extend storage.

## Operational note

After editing `packages/types`, run `npm run build -w @bronson/types` before typechecking the orchestrator.
