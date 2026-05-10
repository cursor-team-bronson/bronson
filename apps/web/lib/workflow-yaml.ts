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
  depends_on?: string[] | string;
  deps?: string[] | string;
  needs?: string[] | string;
  requires?: string[] | string;
  human_gate_after?: string[] | string;
  ai_gate_after?: string[] | string;
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

/** Declaration index for stable ordering among mutually independent steps. */
function declarationIndex(nodes: string[]): Map<string, number> {
  return new Map(nodes.map((id, i) => [id, i]));
}

/**
 * Kahn-style topological order: each wave is all currently runnable steps (in-degree 0),
 * sorted by YAML declaration order, then the next wave. Matches orchestrator execution waves
 * flattened left-to-right.
 */
/**
 * Returns a topological order, or `null` if the graph has a cycle or stuck state
 * (no runnable node while work remains — must not spin forever).
 */
function kahnTopologicalOrder(nodes: string[], depsByNode: Map<string, string[]>): string[] | null {
  const decl = declarationIndex(nodes);
  const dependents = new Map<string, string[]>();
  for (const id of nodes) dependents.set(id, []);
  for (const id of nodes) {
    for (const d of depsByNode.get(id) ?? []) {
      dependents.get(d)!.push(id);
    }
  }
  const inDegree = new Map<string, number>();
  for (const id of nodes) inDegree.set(id, (depsByNode.get(id) ?? []).length);

  const remaining = new Set(nodes);
  const order: string[] = [];
  const byDecl = (a: string, b: string) => (decl.get(a)! - decl.get(b)!);

  while (remaining.size > 0) {
    const wave = [...remaining]
      .filter((id) => inDegree.get(id)! === 0)
      .sort(byDecl);
    if (wave.length === 0) {
      return null;
    }
    for (const id of wave) {
      order.push(id);
      remaining.delete(id);
    }
    for (const id of wave) {
      for (const m of dependents.get(id) ?? []) {
        inDegree.set(m, inDegree.get(m)! - 1);
      }
    }
  }
  return order;
}

function findCyclePath(nodes: string[], depsByNode: Map<string, string[]>): string[] | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();
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
  };

  for (const node of nodes) dfs(node, []);
  return cyclePath;
}

export function parseDag(text: string): GraphResult {
  try {
    const parsed = yaml.load(text) as { steps?: Step[] } | undefined;
    if (!parsed || !Array.isArray(parsed.steps)) {
      return {
        nodes: [],
        depsByNode: new Map(),
        humanGateByNode: new Map(),
        aiGateByNode: new Map(),
        stepTypes: new Map(),
        topoOrder: [],
        cyclePath: null,
        parseError: "Expected a YAML object with a `steps` array.",
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

    let cyclePath = findCyclePath(nodes, depsByNode);
    let topoOrder: string[] = [];
    if (!cyclePath) {
      const kahn = kahnTopologicalOrder(nodes, depsByNode);
      if (kahn === null) {
        cyclePath = ["(dependency cycle — could not flatten graph)"];
      } else {
        topoOrder = kahn;
      }
    }

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
