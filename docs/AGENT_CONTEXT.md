# Bronson — Agent Context & Plan Summary

Use this document to onboard a new agent to the project. It covers the project goal, current repo state, architecture decisions, division of responsibilities, and open issues.

---

## Project Overview

**Bronson** is an agentic workflow orchestrator built for a Cursor Hackathon. It lets users define multi-agent pipelines in YAML, execute them as a DAG with concurrent fan-out, pause on human-in-the-loop approval gates before destructive steps, and track token/cost usage per job.

**Stack:** **npm workspaces monorepo** (Turborepo-style `apps/` + `packages/` layout)

| Package / app | Responsibility |
|---------------|------------------|
| **`@bronson/types`** ([`packages/types`](../packages/types)) | Zod schemas + shared TypeScript types (single source of truth for orchestrator and web) |
| **`@bronson/orchestrator`** ([`apps/orchestrator`](../apps/orchestrator)) | Long-lived Express process — YAML parsing, DAG execution, CLōD calls, gates, REST + SSE |
| **`@bronson/web`** ([`apps/web`](../apps/web)) | Next.js (App Router) on port **3000** — POC UI + thin **same-origin** `/api/*` proxy to Express |

**Agent integration:** CLōD (https://clod.io) — OpenAI-compatible API, used as the LLM layer for all agent calls. Multiple models available (deepseek-v3 for cheap steps, stronger models for gate-review summarization).

---

## Current Repo State

```
packages/types/src/index.ts     — Zod schemas + shared TS types (@bronson/types)
apps/orchestrator/src/
  parser/yaml-parser.ts        — Parse & validate workflow YAML strings/files
  parser/dag-resolver.ts       — Topological sort, cycle detection, wave building
  event-log/event-log.ts       — Append-only in-memory event log with pub/sub
  agent-runner/clod-client.ts  — CLōD via OpenAI SDK, fires agent calls
  agent-runner/context-router.ts — Trims upstream outputs to token budget
  gates/gate-manager.ts        — Human gate pause/resume via promise map
  orchestrator/run-manager.ts   — Wave-based parallel executor with retry/backoff
  api/routes.ts                — All REST endpoints
  api/sse.ts                   — SSE stream with past-event replay on connect
  index.ts                     — Express entry (default port 3001)
apps/web/app/
  page.tsx                     — POC landing page
  api/[...path]/route.ts       — Proxies to orchestrator /api/*
examples/
  pr-review-pipeline.yaml      — Demo: analyze → suggest → [human gate] → apply
```

---

## Architecture Decisions

### Why Express stays separate from Next.js

The orchestrator must be a **long-lived process**. Human gates use an in-memory promise map; SSE and the event log are in-memory for the hackathon. Next.js route handlers are not a substitute for this process model on serverless/lambda-style deployments (timeouts, cold starts). In this monorepo, **Express runs as its own process** alongside Next (`npm run dev` starts both).

### Execution Model

Jobs are grouped into **execution waves** (topological sort). All jobs in a wave run concurrently via `Promise.all`. A wave only starts after all jobs in the prior wave complete. This means:

- Zero-dependency jobs all run in wave 0 (full parallelism)
- Each dependent job waits only as long as its slowest dependency

### Human Gates

When a job has `gate: human`, the orchestrator:

1. Runs the agent and gets `proposedOutput`
2. Emits a `GATE_PENDING` event (SSE pushes this to the UI)
3. Suspends that branch by awaiting a Promise stored in `GateManager`
4. The UI calls `POST /api/runs/:runId/gates/:jobId/approve` (or `/reject`) — **against the orchestrator base URL** (or via Next proxy at `/api/runs/...` if same-origin is required)
5. The resolve callback fires, run continues with the (optionally edited) output

**Key:** The Promise map is in-process. If the server restarts, pending gates are lost. This is fine for the hackathon but needs persistence for production.

### Event Log

In-memory append-only array. All state changes are recorded as typed events. The SSE endpoint replays the full run history on connect so the frontend doesn't miss anything from before subscribing.

### Context Passing

Upstream job outputs are passed to downstream jobs as a formatted string block. The `context_budget` field caps how many tokens of upstream context are injected (rough approximation: 4 chars/token). This prevents multi-stage pipelines from blowing up context windows.

### CLōD Integration

Uses the OpenAI SDK pointed at CLōD's base URL. Each job specifies its own `model`. No streaming yet — single `chat.completions.create` call per job.

### Base URLs for API calls

| Caller | Base URL | Notes |
|--------|-----------|-------|
| curl / scripts | `http://localhost:3001` | Direct to Express |
| Browser (same-origin) | `http://localhost:3000` | Next proxies `/api/*` → orchestrator via `ORCHESTRATOR_URL` |
| Browser (SSE / health POC) | `NEXT_PUBLIC_ORCHESTRATOR_URL` (default `http://127.0.0.1:3001`) | Avoids implementing SSE streaming through Next for the POC |

---

## YAML Schema Reference

```yaml
name: pipeline-name

jobs:
  job_id:
    prompt: "..."                # Required. Sent to the agent as user message.
    model: deepseek-v3           # Any CLōD model slug.
    depends_on: [other_job_id]   # DAG edges. Omit for root jobs.
    gate: auto                   # auto | human. Human = pause for approval.
    context_budget: 2000         # Max tokens of upstream output to inject.
    tools: []                    # Tool names (not yet wired — see open issues).
    on_failure: halt             # halt | retry.
    max_retries: 0               # Attempts = 1 + max_retries.
```

---

## API Endpoints

Implemented on the **orchestrator** (port **3001** by default). Paths are identical when accessed through Next at port **3000** under `/api/*` (proxy).

| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/runs` | Body: `{ yaml: string }`. Returns initial RunState. |
| GET | `/api/runs` | List all runs. |
| GET | `/api/runs/:runId` | Get current RunState snapshot. |
| GET | `/api/runs/:runId/events` | SSE stream. Replays history then streams live. |
| GET | `/api/runs/:runId/events/history` | Full event log as JSON array. |
| GET | `/api/runs/:runId/gates` | List pending gate requests for this run. |
| POST | `/api/runs/:runId/gates/:jobId/approve` | Body: `{ editedOutput?: string }` |
| POST | `/api/runs/:runId/gates/:jobId/reject` | Body: `{ reason?: string }` |
| GET | `/health` | Health check (not under `/api`). |

---

## Event Types (SSE payload shape)

```typescript
interface RunEvent {
  eventId: string;
  runId: string;
  jobId?: string;        // present for job-scoped events
  type: EventType;
  timestamp: string;     // ISO 8601
  payload?: Record<string, unknown>;
}

type EventType =
  | "RUN_STARTED" | "RUN_COMPLETED" | "RUN_FAILED"
  | "JOB_STARTED" | "JOB_COMPLETED" | "JOB_FAILED"
  | "GATE_PENDING" | "GATE_APPROVED" | "GATE_REJECTED";
```

Key payloads:

- `JOB_COMPLETED` → `{ output, tokensUsed, costUsd }`
- `GATE_PENDING` → `{ proposedOutput }` (the UI shows this as a diff for the human to review)
- `JOB_FAILED` → `{ error }`

---

## Division of Responsibilities

| Owner | Responsibility |
|-------|------------------|
| **`@bronson/types`** | Zod + TS contracts imported by orchestrator and web |
| **`@bronson/orchestrator`** | YAML, DAG, CLōD, gates, REST, SSE, in-memory state |
| **`@bronson/web`** | Next UI, thin `/api/*` proxy, env-driven URLs for browser |

Rich DAG visualization, gate approval UI, billing dashboards, and tool integrations (e.g. Greptile) can extend **`@bronson/web`** without moving execution into Next serverless routes.

---

## Open Issues / What Needs Building Next

### 1. Tool Support (not wired yet)

The YAML schema has a `tools: []` field but the agent runner ignores it. Need to:

- Define tool implementations (at minimum: Greptile code search)
- Pass tool definitions to CLōD via `tools` param in `chat.completions.create`
- Handle `tool_calls` in the response and run tool execution before returning output

### 2. Streaming Agent Output

Currently, agent calls use non-streaming `chat.completions.create`. For the demo, streaming would make it feel much more alive — the UI could show live token output per job. Switch to `stream: true` and pipe chunks to SSE as `JOB_OUTPUT_CHUNK` events.

### 3. Gate State Persistence

Pending gates live only in-process memory. Server restart = lost gates. For hackathon this is fine, but if needed: serialize the pending gate requests to a file or SQLite and restore on boot.

### 4. Billing Dashboard Data

The event log already captures `tokensUsed` and `costUsd` per job in `JOB_COMPLETED` events. The frontend just needs to aggregate across all jobs in a run:

```
GET /api/runs/:runId/events/history
→ filter type === "JOB_COMPLETED"
→ sum payload.tokensUsed, payload.costUsd
```

### 5. Run Input Data

Currently, the `prompt` in YAML is static. Real pipelines need to inject runtime data (e.g. the actual PR diff for the PR review pipeline). Design options:

- Accept a `context` field in `POST /api/runs` body alongside `yaml`, prepend to wave-0 job prompts
- Or add a special `input_ref` job type that just holds the provided data as its output

### 6. CORS / Auth

Currently CORS is wide open (`cors()`). Before exposing to the internet, add origin allowlist and an `Authorization` header check on the API.

---

## Environment Variables

**Orchestrator** (`apps/orchestrator/.env` — see `apps/orchestrator/.env.example`):

```
PORT=3001
CLOD_API_KEY=<your key from https://app.clod.io>
CLOD_BASE_URL=https://api.clod.io/v1
```

**Web** (`apps/web/.env` — optional; see `apps/web/.env.example`):

```
ORCHESTRATOR_URL=http://127.0.0.1:3001
NEXT_PUBLIC_ORCHESTRATOR_URL=http://127.0.0.1:3001
```

---

## Quick Start

```bash
npm install
npm run build -w @bronson/types
cp apps/orchestrator/.env.example apps/orchestrator/.env
# Edit apps/orchestrator/.env — set CLOD_API_KEY
npm run dev
```

- Web: http://localhost:3000  
- Orchestrator: http://localhost:3001  

### Start a run (PowerShell)

Read the demo YAML into a JSON-safe string and POST:

```powershell
$yaml = Get-Content -Raw examples/pr-review-pipeline.yaml
$body = @{ yaml = $yaml } | ConvertTo-Json
Invoke-RestMethod -Uri http://localhost:3001/api/runs -Method POST -Body $body -ContentType "application/json"
```

### Start a run (bash / macOS / Linux)

```bash
curl -X POST http://localhost:3001/api/runs \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg y "$(cat examples/pr-review-pipeline.yaml)" '{yaml: $y}')"
```

---

## Monorepo tooling

Root scripts use **npm workspaces** and **concurrently** to run orchestrator + web in parallel. The optional `turbo` CLI is not required for scripts (some Windows setups fail to spawn its native binary); the folder layout matches common Turborepo conventions if you add it later.
