# Bronson — Agent Context & Plan Summary

Use this document to onboard a new agent to the project. It covers the project goal, current repo state, architecture decisions, division of responsibilities, and open issues.

---

## Project Overview

**Bronson** is an agentic workflow orchestrator built for a Cursor Hackathon. It lets users define multi-agent pipelines in YAML, execute them as a DAG with concurrent fan-out, pause on human-in-the-loop approval gates before destructive steps, and track token/cost usage per job.

**Stack:** Two separate repos
- `bronson` — Express/TypeScript orchestrator backend (this repo)
- Frontend repo (separate) — Next.js UI for DAG visualization, gate approval, and billing dashboard

**Agent integration:** CLōD (https://clod.io) — OpenAI-compatible API, used as the LLM layer for all agent calls. Multiple models available (deepseek-v3 for cheap steps, stronger models for gate-review summarization).

---

## Current Repo State (`bronson`)

All files are written and committed locally. The full source tree:

```
src/
  types/index.ts              — Zod schemas + all shared TypeScript types
  parser/yaml-parser.ts       — Parse & validate workflow YAML strings/files
  parser/dag-resolver.ts      — Topological sort, cycle detection, wave building
  event-log/event-log.ts      — Append-only in-memory event log with pub/sub
  agent-runner/clod-client.ts — CLōD via OpenAI SDK, fires agent calls
  agent-runner/context-router.ts — Trims upstream outputs to token budget
  gates/gate-manager.ts       — Human gate pause/resume via promise map
  orchestrator/run-manager.ts — Wave-based parallel executor with retry/backoff
  api/routes.ts               — All REST endpoints
  api/sse.ts                  — SSE stream with past-event replay on connect
  index.ts                    — Express entry point (port 3001)
examples/
  pr-review-pipeline.yaml     — Demo: analyze → suggest → [human gate] → apply
```

---

## Architecture Decisions

### Execution Model
Jobs are grouped into **execution waves** (topological sort). All jobs in a wave run concurrently via `Promise.all`. A wave only starts after all jobs in the prior wave complete. This means:
- Zero-dependency jobs all run in wave 0 (full parallelism)
- Each dependent job waits only as long as its slowest dependency

### Human Gates
When a job has `gate: human`, the orchestrator:
1. Runs the agent and gets `proposedOutput`
2. Emits a `GATE_PENDING` event (SSE pushes this to the UI)
3. Suspends that branch by awaiting a Promise stored in `GateManager`
4. The UI calls `POST /api/runs/:runId/gates/:jobId/approve` (or `/reject`)
5. The resolve callback fires, run continues with the (optionally edited) output

**Key:** The Promise map is in-process. If the server restarts, pending gates are lost. This is fine for the hackathon but needs persistence for production.

### Event Log
In-memory append-only array. All state changes are recorded as typed events. The SSE endpoint replays the full run history on connect so the frontend doesn't miss anything from before subscribing.

### Context Passing
Upstream job outputs are passed to downstream jobs as a formatted string block. The `context_budget` field caps how many tokens of upstream context are injected (rough approximation: 4 chars/token). This prevents multi-stage pipelines from blowing up context windows.

### CLōD Integration
Uses the OpenAI SDK pointed at CLōD's base URL. Each job specifies its own `model`. No streaming yet — single `chat.completions.create` call per job.

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
| GET | `/health` | Health check. |

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
|-------|---------------|
| **This repo (Bronson)** | YAML parsing, DAG execution, agent calls via CLōD, human gate logic, REST API, SSE events |
| **Other repo (Action)** | WebSocket or SSE consumer in Next.js, DAG visualization, gate approval UI, billing dashboard, any tool integrations (Greptile search, etc.) |
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

```
PORT=3001
CLOD_API_KEY=<your key from https://app.clod.io>
CLOD_BASE_URL=https://api.clod.io/v1
```

---

## Quick Start

```bash
cp .env.example .env
# set CLOD_API_KEY
npm install
npm run dev
# server on http://localhost:3001
```

Test with the demo pipeline:
```bash
curl -X POST http://localhost:3001/api/runs \
  -H "Content-Type: application/json" \
  -d "{\"yaml\": \"$(cat examples/pr-review-pipeline.yaml | sed 's/"/\\"/g' | tr -d '\n')\"}"
```
