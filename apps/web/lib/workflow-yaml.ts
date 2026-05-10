import yaml from "js-yaml";

export const WORKFLOW_YAML_STORAGE_KEY = "bronson.workflowYaml.v1";

export const starterYaml = `name: fan-out-agents-workflow
steps:
  - id: plan-task
    type: llm
    prompt: Decompose the request into parallel workstreams.
  - id: spawn-agent-swarm
    type: fan_out
    depends_on: plan-task
    # One orchestrator step fans out to multiple specialist agents below.
  - id: agent-research
    type: agent
    role: research
    depends_on: spawn-agent-swarm
    ai_gate_after: spawn-agent-swarm
  - id: agent-implement
    type: agent
    role: implement
    depends_on: spawn-agent-swarm
    ai_gate_after: spawn-agent-swarm
  - id: agent-qa
    type: agent
    role: qa
    depends_on: spawn-agent-swarm
    ai_gate_after: spawn-agent-swarm
  - id: merge-agent-outputs
    type: llm
    depends_on:
      - agent-research
      - agent-implement
      - agent-qa
    prompt: Merge the three agent traces into one coherent deliverable.
  - id: human-release
    type: human_gate
    depends_on: merge-agent-outputs
    human_gate_after: merge-agent-outputs
`;

/**
 * Mirrors `examples/essay-write-review-3cycles.yaml` — run `node scripts/sync-essay-preset.mjs` after edits there (POC).
 * Uses String.raw so Windows paths stay single-backslash in the YAML text (avoid backticks inside the YAML).
 */
export const essayWorkflowYaml = String.raw`# Essay writer / reviewer — three cycles (six sequential jobs).
#
# Each job uses on_failure: retry so the DAG keeps going after a failure; downstream jobs then
# receive failure transcripts from upstream via context (see orchestrator run-manager + event log).
#
# Prerequisites (apps/orchestrator/.env):
#   ALLOW_SHELL_TOOL=true
#     (enables workspace_write by default — see ALLOW_WORKSPACE_WRITE below)
#   TOOL_SHELL_CWD=C:\Users\julie\bronson\examples\essay-workspace
#     (workspace root for workspace_write; must match paths you care about)
#
# Optional:
#   ALLOW_WORKSPACE_WRITE=false   — disable direct file writes while keeping shell (default: same as ALLOW_SHELL_TOOL)
#   TOOL_WORKSPACE_WRITE_MAX_BYTES=5000000
#
# Writers use tools: [workspace_write] so file contents are passed as tool JSON (no shell quoting).
# Reviewers only see prior jobs' LLM outputs (context), not the disk file automatically.
#
# Edit C:\Users\julie\bronson\examples\essay-workspace if you want a different folder;
# keep TOOL_SHELL_CWD in sync.

name: essay-write-review-3cycles

jobs:
  write_cycle_1:
    prompt: |
      You are the WRITER (cycle 1 of 3).

      Topic: "Why short feedback loops matter when building software."

      Rules:
      - Write a first draft of roughly 250–400 words, clear prose, no markdown headings required.
      - In your assistant message, include the full essay between these lines exactly:
        ###ESSAY_START###
        ...full essay text...
        ###ESSAY_END###
      - Call workspace_write exactly once:
        - path: essay-draft.txt
        - content: the essay body ONLY (characters between ###ESSAY_START### and ###ESSAY_END###, excluding the marker lines themselves).
      - Then reply with one assistant message containing only the word: done
      - Do not use the shell tool unless workspace_write fails (you should not need it).
    tools: [workspace_write]
    tool_rounds_max: 18
    gate: auto
    on_failure: retry
    context_budget: 12000

  review_cycle_1:
    prompt: |
      You are the REVIEWER (after cycle 1).

      Read the section ###ESSAY_START### ... ###ESSAY_END### from the writer output in context.

      If the upstream writer FAILED (see "### Upstream ... failed") or there is no ###ESSAY_START###
      block, respond only: "No essay draft to review." plus one line quoting the failure reason.
      Do not invent an essay or unrelated topic.

      Otherwise respond with:
      1) Summary (2–3 sentences)
      2) Strengths (bullet list)
      3) Issues / gaps (bullet list)
      4) Concrete edits the writer should apply in the next draft (numbered list)

      Do not use tools.
    depends_on: [write_cycle_1]
    gate: auto
    on_failure: retry
    context_budget: 12000

  write_cycle_2:
    prompt: |
      You are the WRITER (cycle 2 of 3).

      Topic (same): "Why short feedback loops matter when building software."

      Use the REVIEWER feedback in context from review_cycle_1. Revise the essay: address their
      concrete edits while keeping a coherent voice.

      Rules:
      - Output the full revised essay between ###ESSAY_START### and ###ESSAY_END###.
      - workspace_write once: path essay-draft.txt, content = essay body only (between markers, markers excluded).
      - Then reply with only: done
    tools: [workspace_write]
    tool_rounds_max: 18
    depends_on: [review_cycle_1]
    gate: auto
    on_failure: retry
    context_budget: 12000

  review_cycle_2:
    prompt: |
      You are the REVIEWER (after cycle 2).

      Read the latest essay between ###ESSAY_START### and ###ESSAY_END### in context.

      If the upstream writer FAILED or there is no ###ESSAY_START### block, respond only:
      "No essay draft to review." plus one line quoting the failure reason. Do not invent content.

      Otherwise same four sections as before (summary, strengths, issues, concrete edits for next draft).
      Be stricter about clarity and structure if earlier issues remain.

      Do not use tools.
    depends_on: [write_cycle_2]
    gate: auto
    on_failure: retry
    context_budget: 12000

  write_cycle_3:
    prompt: |
      You are the WRITER (cycle 3 of 3 — final revision).

      Topic (same). Apply review_cycle_2 feedback from context.

      Rules:
      - Final essay between ###ESSAY_START### and ###ESSAY_END###.
      - workspace_write once: path essay-draft.txt, content = essay body only.
      - Then reply with only: done
    tools: [workspace_write]
    tool_rounds_max: 18
    depends_on: [review_cycle_2]
    gate: auto
    on_failure: retry
    context_budget: 12000

  review_cycle_3:
    prompt: |
      You are the REVIEWER (final pass).

      Read the final essay from context (###ESSAY_START### ... ###ESSAY_END###).

      If the upstream writer FAILED or there is no essay in context, say so in one short paragraph — do not invent an essay.

      Otherwise give a brief acceptance-style summary: ready or not, top remaining nitpicks (if any),
      and one sentence overall verdict.

      Do not use tools.
    depends_on: [write_cycle_3]
    gate: auto
    on_failure: retry
    context_budget: 12000
`;

export const yamlHelpExample = `name: parallel-agents
steps:
  - id: orchestrate
    type: fan_out
  - id: agent-a
    depends_on: orchestrate
    ai_gate_after: orchestrate
  - id: agent-b
    depends_on: orchestrate
    ai_gate_after: orchestrate
  - id: join
    depends_on: [agent-a, agent-b]`;

export type Step = {
  id: string;
  type?: string;
  prompt?: string;
  model?: string;
  tools?: string[];
  tool_rounds_max?: number;
  depends_on?: string[] | string;
  deps?: string[] | string;
  needs?: string[] | string;
  requires?: string[] | string;
  human_gate_after?: string[] | string;
  ai_gate_after?: string[] | string;
  gate?: string;
};

export type GraphResult = {
  nodes: string[];
  depsByNode: Map<string, string[]>;
  humanGateByNode: Map<string, string[]>;
  aiGateByNode: Map<string, string[]>;
  stepTypes: Map<string, string>;
  topoOrder: string[];
  cyclePath: string[] | null;
  parseError: string | null;
};

function asArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

function topoFromDeps(nodes: string[], depsByNode: Map<string, string[]>): { topoOrder: string[]; cyclePath: string[] | null } {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const topo: string[] = [];
  let cyclePath: string[] | null = null;

  const dfs = (node: string, path: string[]) => {
    if (cyclePath) return;
    if (visiting.has(node)) {
      const start = path.indexOf(node);
      cyclePath = start >= 0 ? [...path.slice(start), node] : [node, node];
      return;
    }
    if (visited.has(node)) return;

    visiting.add(node);
    const nextPath = [...path, node];
    for (const dep of depsByNode.get(node) ?? []) {
      dfs(dep, nextPath);
    }
    visiting.delete(node);
    visited.add(node);
    topo.push(node);
  };

  for (const node of nodes) dfs(node, []);

  return { topoOrder: cyclePath ? [] : topo, cyclePath };
}

export function parseDag(text: string): GraphResult {
  try {
    const parsed = yaml.load(text) as { name?: string; steps?: Step[]; jobs?: Record<string, unknown> } | undefined;

    /** Orchestrator-native workflows (`jobs:`) — same graph semantics as `steps:`. */
    if (parsed?.jobs && typeof parsed.jobs === "object" && !Array.isArray(parsed.jobs)) {
      const jobs = parsed.jobs as Record<
        string,
        { depends_on?: string[]; gate?: string; prompt?: unknown }
      >;
      const nodes = Object.keys(jobs).filter((id) => id.length > 0);
      const nodeSet = new Set(nodes);
      const depsByNode = new Map<string, string[]>();
      const stepTypes = new Map<string, string>();

      for (const id of nodes) {
        const raw = jobs[id]?.depends_on;
        const deps = Array.isArray(raw)
          ? raw.filter((d): d is string => typeof d === "string" && nodeSet.has(d))
          : [];
        depsByNode.set(id, Array.from(new Set(deps)));
        const g = jobs[id]?.gate;
        stepTypes.set(id, g === "human" ? "human_gate" : "llm");
      }

      const { topoOrder, cyclePath } = topoFromDeps(nodes, depsByNode);

      return {
        nodes,
        depsByNode,
        humanGateByNode: new Map(),
        aiGateByNode: new Map(),
        stepTypes,
        topoOrder,
        cyclePath,
        parseError: null,
      };
    }

    if (!parsed || !Array.isArray(parsed.steps)) {
      return {
        nodes: [],
        depsByNode: new Map(),
        humanGateByNode: new Map(),
        aiGateByNode: new Map(),
        stepTypes: new Map(),
        topoOrder: [],
        cyclePath: null,
        parseError: "Expected `steps:` (DAG editor) or `jobs:` (orchestrator / CLōD) in the YAML root.",
      };
    }

    const nodes = parsed.steps
      .map((step) => step.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);

    const stepTypes = new Map<string, string>();
    for (const step of parsed.steps) {
      if (step.id && typeof step.type === "string") stepTypes.set(step.id, step.type);
    }

    const nodeSet = new Set(nodes);
    const depsByNode = new Map<string, string[]>();
    const humanGateByNode = new Map<string, string[]>();
    const aiGateByNode = new Map<string, string[]>();
    for (const step of parsed.steps) {
      if (!step.id) continue;
      const deps = [
        ...asArray(step.depends_on),
        ...asArray(step.deps),
        ...asArray(step.needs),
        ...asArray(step.requires),
      ].filter((dep) => nodeSet.has(dep));
      depsByNode.set(step.id, Array.from(new Set(deps)));

      const humanGates = asArray(step.human_gate_after).filter((dep) => nodeSet.has(dep) && deps.includes(dep));
      const aiGates = asArray(step.ai_gate_after).filter((dep) => nodeSet.has(dep) && deps.includes(dep));
      if (humanGates.length > 0) humanGateByNode.set(step.id, Array.from(new Set(humanGates)));
      if (aiGates.length > 0) aiGateByNode.set(step.id, Array.from(new Set(aiGates)));
    }

    const { topoOrder, cyclePath } = topoFromDeps(nodes, depsByNode);

    return {
      nodes,
      depsByNode,
      humanGateByNode,
      aiGateByNode,
      stepTypes,
      topoOrder,
      cyclePath,
      parseError: null,
    };
  } catch (error) {
    return {
      nodes: [],
      depsByNode: new Map(),
      humanGateByNode: new Map(),
      aiGateByNode: new Map(),
      stepTypes: new Map(),
      topoOrder: [],
      cyclePath: null,
      parseError: error instanceof Error ? error.message : "Invalid YAML.",
    };
  }
}

function defaultStepPrompt(step: Step): string {
  const id = step.id;
  const t = step.type ?? "step";
  return `Complete step "${id}" (${t}). Reply with a short plain-text summary of what you did.`;
}

export type OrchestratorYamlResult =
  | { ok: true; yaml: string }
  | { ok: false; error: string };

/**
 * Produce YAML accepted by `POST /api/runs` (orchestrator `name` + `jobs`).
 * Passes through `jobs:` workflows; converts DAG-editor `steps:` to `jobs`.
 */
export function toOrchestratorWorkflowYaml(text: string): OrchestratorYamlResult {
  try {
    const parsed = yaml.load(text.replace(/^\uFEFF/, "")) as Record<string, unknown> | undefined;
    if (!parsed || typeof parsed !== "object") {
      return { ok: false, error: "Invalid YAML root." };
    }

    if ("jobs" in parsed && parsed.jobs && typeof parsed.jobs === "object" && !Array.isArray(parsed.jobs)) {
      const dump = yaml.dump(parsed, { lineWidth: -1, noRefs: true, quotingType: '"' });
      return { ok: true, yaml: dump };
    }

    const steps = parsed.steps;
    if (!Array.isArray(steps)) {
      return {
        ok: false,
        error: "Use `jobs:` (orchestrator) or `steps:` (DAG editor). See examples/hello-world-ticker.yaml.",
      };
    }

    const name = typeof parsed.name === "string" ? parsed.name : "workflow";

    const stepList = steps as Step[];
    const nodes = stepList.map((s) => s.id).filter((id): id is string => typeof id === "string" && id.length > 0);
    const nodeSet = new Set(nodes);

    const depsById = new Map<string, string[]>();
    for (const step of stepList) {
      if (!step.id) continue;
      const deps = [
        ...asArray(step.depends_on),
        ...asArray(step.deps),
        ...asArray(step.needs),
        ...asArray(step.requires),
      ].filter((dep) => nodeSet.has(dep));
      depsById.set(step.id, Array.from(new Set(deps)));
    }

    const jobs: Record<string, Record<string, unknown>> = {};

    for (const step of stepList) {
      if (!step.id) continue;
      const prompt =
        typeof step.prompt === "string" && step.prompt.trim()
          ? step.prompt
          : defaultStepPrompt(step);

      const gate =
        step.type === "human_gate" || step.gate === "human"
          ? "human"
          : "auto";

      const job: Record<string, unknown> = {
        prompt,
        depends_on: depsById.get(step.id) ?? [],
        gate,
      };

      if (typeof step.model === "string" && step.model.trim()) job.model = step.model.trim();
      if (Array.isArray(step.tools) && step.tools.length) job.tools = step.tools;
      if (typeof step.tool_rounds_max === "number") job.tool_rounds_max = step.tool_rounds_max;

      jobs[step.id] = job;
    }

    const dump = yaml.dump({ name, jobs }, { lineWidth: -1, noRefs: true, quotingType: '"' });
    return { ok: true, yaml: dump };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
