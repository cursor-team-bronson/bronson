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

## Demo workflow

Example pipeline: [`examples/pr-review-pipeline.yaml`](examples/pr-review-pipeline.yaml).

Shell / CLōD tools POC: [`examples/with-shell-tool.yaml`](examples/with-shell-tool.yaml) — set **`ALLOW_SHELL_TOOL=true`** in the orchestrator environment (see [`apps/orchestrator/.env.example`](apps/orchestrator/.env.example)); details in [`docs/AGENT_CONTEXT.md`](docs/AGENT_CONTEXT.md).

Write a local proof file via shell: [`examples/shell-write-local.yaml`](examples/shell-write-local.yaml) + run [`examples/post-shell-test.ps1`](examples/post-shell-test.ps1) (set **`TOOL_SHELL_CWD`** to your repo `examples` folder so `bronson-shell-proof.txt` appears there).

### Turborepo note

This repo uses **npm workspaces** and `concurrently` for parallel dev. The optional `turbo` CLI was not used in scripts because its native binary failed to run in some Windows environments; you can add Turborepo later without changing the folder layout.
