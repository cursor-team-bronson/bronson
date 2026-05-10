import { WorkflowConfig } from "../types/index.js";

export interface DAGNode {
  jobId: string; dependencies: string[]; dependents: string[];
}
export interface ResolvedDAG {
  nodes: Map<string, DAGNode>; executionWaves: string[][];
}

export function resolveDAG(config: WorkflowConfig): ResolvedDAG {
  const nodes = new Map<string, DAGNode>();
  for (const jobId of Object.keys(config.jobs)) {
    const deps = config.jobs[jobId].depends_on ?? [];
    for (const dep of deps) {
      if (!config.jobs[dep]) throw new Error(`Job "${jobId}" depends on unknown job "${dep}"`);
    }
    nodes.set(jobId, { jobId, dependencies: deps, dependents: [] });
  }
  for (const [jobId, node] of nodes)
    for (const dep of node.dependencies) nodes.get(dep)!.dependents.push(jobId);
  detectCycles(nodes);
  return { nodes, executionWaves: buildExecutionWaves(nodes) };
}

function detectCycles(nodes: Map<string, DAGNode>): void {
  const visited = new Set<string>(), inStack = new Set<string>();
  function dfs(jobId: string) {
    visited.add(jobId); inStack.add(jobId);
    for (const d of nodes.get(jobId)!.dependents) {
      if (!visited.has(d)) dfs(d);
      else if (inStack.has(d)) throw new Error(`Cycle detected involving "${d}"`);
    }
    inStack.delete(jobId);
  }
  for (const jobId of nodes.keys()) if (!visited.has(jobId)) dfs(jobId);
}

function buildExecutionWaves(nodes: Map<string, DAGNode>): string[][] {
  const inDegree = new Map([...nodes].map(([id, n]) => [id, n.dependencies.length]));
  const waves: string[][] = [], remaining = new Set(nodes.keys());
  while (remaining.size > 0) {
    const wave = [...remaining].filter(id => inDegree.get(id) === 0);
    if (!wave.length) throw new Error("Unexpected cycle — cannot resolve execution order");
    waves.push(wave);
    for (const jobId of wave) {
      remaining.delete(jobId);
      for (const d of nodes.get(jobId)!.dependents)
        inDegree.set(d, inDegree.get(d)! - 1);
    }
  }
  return waves;
}
