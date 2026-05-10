# Orchestrator: run state, DAG storage, and event typing

This note summarizes recent changes across `packages/types`, `apps/orchestrator/src/orchestrator/run-manager.ts`, `apps/orchestrator/src/index.ts`, and `apps/orchestrator/src/api/routes.ts`.

## `@bronson/types`

- **`SerializedDAGNode`** and **`SerializedDAG`** are shared types (`nodes` with `jobId`, `dependencies`, `dependents`, plus `executionWaves`).
- **`RunState`** includes optional **`dag?: SerializedDAG`** so runs returned from the API can carry the workflow topology.
- **`EventType`** includes **`JOB_RETRY_WARNING`** alongside lifecycle and gate events so retry warnings type-check in **`eventLog.append`** and elsewhere.

## `run-manager.ts`

### Single source of truth for the DAG

- On **`startRun`**, after resolving the DAG, the run manager sets **`dag: serializedDag`** on the **`RunState`** it stores and returns.
- **`getRunDag(runId)`** is **`getRun(runId)?.dag`** — a thin accessor when you only have an id (e.g. tests or other modules).
- The orchestrator imports **`SerializedDAG`** from **`@bronson/types`** (no duplicate local interface).

## `index.ts`

- Orchestrator entrypoint: dotenv resolution, **`assertClodConfigured`**, Express with **`/health`** and **`/api`**. Shared types live in **`@bronson/types`**.

## `routes.ts`

- **`GET /api/runs`** and **`GET /api/runs/:runId`** serialize **`RunState`**, so **`dag`** is included for runs created via **`startRun`** when you need the graph in the same payload.
- **`GET /api/runs/:runId/dag`** returns **`run.dag`**: 404 if the run is missing, 404 if **`dag`** is missing (should not happen for **`startRun`** runs).

## Quick reference

| Concern | Where it lives |
|--------|----------------|
| Canonical TS shapes (`RunState`, `SerializedDAG`, `EventType`) | **`@bronson/types`** |
| Run + jobs + DAG (runtime) | **`runs`** map → each **`RunState`** may include **`dag`** |
| DAG-only helper | **`getRunDag(runId)`** → **`getRun(runId)?.dag`** |
| Retry warning events | **`EventType`** includes **`JOB_RETRY_WARNING`** |

## Operational note

Rebuild or reinstall workspace types after pulling: **`npm run build -w @bronson/types`** (or root **`npm run build`**) so **`@bronson/orchestrator`** sees updated **`@bronson/types`** via the workspace **`file:`** link.
