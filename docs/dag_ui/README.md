# DAG workflow UI (branch notes)

Small reference for the **workflow YAML editor + DAG preview** work on the `ui` branch (and related commits). Main implementation lives under **`apps/web`**.

## What shipped

1. **DAG editor route (`apps/web/app/dag/page.tsx`)** — `/dag` (home `/` redirects here)  
   - Split layout: **YAML editor** (left) and **live DAG preview** (right).  
   - Parses workflow YAML with **`js-yaml`**, builds a dependency graph from each step’s `id` and dependency fields.  
   - **Topological order** for the preview node list; **cycle detection** (DFS) blocks submit and blurs the preview with an overlay showing the cycle path.  
   - **Submit** stays disabled until YAML parses, the graph is non-empty, and there is no cycle.  
   - In-app **YAML help** dialog documents structure, dependencies, gates, and a short example.

2. **DAG preview (`apps/web/app/dag-preview.tsx`)**  
   - **Custom SVG** graph (not React Flow / not `@ebay/nice-dag-react` in the final form—`nice-dag-react` hit React dispatcher issues with Next; layout is hand-rolled SVG).  
   - **Top → bottom** layout: dependency depth is the vertical axis; siblings in the same layer are laid out horizontally and centered per row.  
   - **Edges**: cubic curves from the bottom center of a parent box to the top center of a child; **arrow markers** per edge kind.  
   - **ViewBox** is computed from node bounds + padding so strokes/markers are not clipped; **`preserveAspectRatio="xMidYMid meet"`** keeps the diagram centered and scaled inside the card.  
   - **Labels** use **`foreignObject`** + centered, truncated text so long step ids / `deps:` lines do not overflow the boxes.

3. **YAML conventions (preview + parser)**  
   - **`steps`**: array of objects with **`id`** (required for the graph).  
   - **Dependencies** (merged): `depends_on`, `deps`, `needs`, `requires` — string or list; unknown ids ignored.  
   - **`human_gate_after` / `ai_gate_after`**: must name deps that are already listed for that step.  
     - **AI gate**: direct edge from that dep → step is drawn in **sky** (`ai` edge style).  
     - **Human gate**: preview **inserts a synthetic “Human review” node** between that dep and the step (`human__<upstream>__<downstream>`); upstream → box is neutral; box → downstream step uses the **amber** (`human`) edge style. The logical YAML graph used for ordering/submit is unchanged—expansion is **preview-only**.

4. **Example workflow**  
   The default editor text demonstrates **fan-out** (`spawn-agent-swarm` → three `agent-*` steps), **merge**, **`ai_gate_after`** on each agent edge from the spawner, and **`human_gate_after`** on the final human release after merge.

## Key files

| Area | Path |
|------|------|
| Shared YAML + `parseDag` | `apps/web/lib/workflow-yaml.ts` |
| Top nav | `apps/web/components/app-nav.tsx` |
| DAG editor page | `apps/web/app/dag/page.tsx` |
| Simulated model runner | `apps/web/app/run/page.tsx` |
| SVG DAG | `apps/web/app/dag-preview.tsx` |
| Root redirect | `apps/web/app/page.tsx` → `/dag` |
| Client-only load of preview chunk | `next/dynamic` with `ssr: false` in `dag/page.tsx` |

## Dependencies (web)

- **`js-yaml`** (+ types) for YAML parsing in the browser.

## Follow-ups (optional)

- Wire **Submit** to a real API (e.g. orchestrator `/runs` or a new endpoint).  
- Draft YAML is synced via **`localStorage`** key `bronson.workflowYaml.v1` between `/dag` and `/run`.  
- If you revisit **nice-dag**, prefer **`@ebay/nice-dag-core`** with imperative `init` in a client-only boundary, or keep the current SVG for full control over layout and gates.
