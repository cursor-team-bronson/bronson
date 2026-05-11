# Bronson

Agentic workflow orchestrator: YAML-defined DAG pipelines, human gates, CLōD-backed agents. This repo is an **npm workspaces monorepo** (`apps/` + `packages/`).

## Layout

| Path | Role |
|------|------|
| [`apps/web`](apps/web) | Next.js UI (port **3000**) + thin `/api/*` proxy to the orchestrator |
| [`apps/orchestrator`](apps/orchestrator) | Long-lived Express API + SSE (**3001**) — execution state, gates, event log |
| [`packages/types`](packages/types) | Shared Zod schemas and TypeScript types (`@bronson/types`) |

Orchestrator REST/SSE live on the Express process; Next routes forward requests when you want same-origin `/api/*`. For SSE, browsers often connect directly to the orchestrator (`NEXT_PUBLIC_ORCHESTRATOR_URL`) because streaming proxies add complexity.

## Prerequisites

- Node.js 20+
- npm 10+ (workspaces)
- A [CLōD](https://clod.io) API key for agent runs

## Setup

```bash
npm install
npm run build -w @bronson/types
```

Environment files:

1. **Orchestrator** — Set `CLOD_API_KEY` in either the repo root `.env` or `apps/orchestrator/.env` (repo-root `.env` loads first; `apps/orchestrator/.env` overrides duplicate keys). Set **`DEFAULT_AGENT_MODEL`** (or `CLOD_DEFAULT_MODEL`) to your provider’s **exact** model string whenever jobs omit `model:` in YAML — for CLōD copy the id from their docs (e.g. **`DEFAULT_AGENT_MODEL="DeepSeek V3"`**, see `apps/orchestrator/.env.example`). You can start from `apps/orchestrator/.env.example`.
2. **Web (optional)** — `cp apps/web/.env.example apps/web/.env` if you change defaults (`ORCHESTRATOR_URL`, `NEXT_PUBLIC_ORCHESTRATOR_URL`).

## Development

Runs Next and Express together (types package is built once first):

```bash
npm run dev
```

- Web: [http://localhost:3000](http://localhost:3000)
- Orchestrator: [http://localhost:3001](http://localhost:3001) (`GET /health`, `/api/*`)

## Build / typecheck

```bash
npm run build
npm run typecheck
```

## Documentation

See [`docs/AGENT_CONTEXT.md`](docs/AGENT_CONTEXT.md) for architecture, YAML schema, API tables, and onboarding notes.

## Demo workflows

| Workflow | Features demonstrated | File |
|---|---|---|
| **Budget + AllScale** | Per-job `budget_usd` caps, AllScale USDC checkout, auto-resume on payment | [`examples/demo-finance-budget-gate.yaml`](examples/demo-finance-budget-gate.yaml) |
| **Essay (shell)** | Multi-cycle writer/reviewer with `workspace_write` tool | [`examples/essay-write-review-3cycles.yaml`](examples/essay-write-review-3cycles.yaml) |
| **PR review** | Basic DAG with `depends_on` | [`examples/pr-review-pipeline.yaml`](examples/pr-review-pipeline.yaml) |
| **Shell tools** | `ALLOW_SHELL_TOOL=true` + `TOOL_SHELL_CWD` setup | [`examples/with-shell-tool.yaml`](examples/with-shell-tool.yaml) |

### Budget gates (USDC)

Set `budget_usd: 0.50` in a job. When spend exceeds the cap:
1. Job suspends, UI shows AllScale checkout popup
2. User tops up USDC → on-chain confirmation → webhook fires
3. Job auto-resumes with funded budget

Requires: `ALLSCALE_API_KEY`, `ALLSCALE_API_SECRET`, `ALLSCALE_BASE_URL` in orchestrator `.env`.

### Kill switch (emergency stop)

- **UI**: "Kill Run" button (Model runner) — stops orchestrator run, marks failed
- **API**: `POST /runs/:id/stop`
- **Per-job abort**: `POST /runs/:id/jobs/:jobId/stop` — aborts active LLM HTTP call

Kill guards prevent stale events from appending after `RUN_FAILED`.

### Turborepo note

This repo uses **npm workspaces** and `concurrently` for parallel dev. The optional `turbo` CLI was not used in scripts because its native binary failed to run in some Windows environments; you can add Turborepo later without changing the folder layout.
