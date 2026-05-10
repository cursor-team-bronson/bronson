"use client";

import { useMemo, useState } from "react";
import yaml from "js-yaml";
import dynamic from "next/dynamic";

type DagNode = { id: string; dependencies: string[] };
const DagPreview = dynamic<{ nodes: DagNode[] }>(() => import("@/app/dag-preview"), { ssr: false });

const starterYaml = `name: sample-workflow
steps:
  - id: fetch-data
    type: http
    method: GET
    url: https://example.com/api/data
  - id: validate
    type: script
    depends_on: fetch-data
  - id: summarize
    type: llm
    depends_on:
      - fetch-data
      - validate
    prompt: |
      Summarize the fetched response in 5 bullet points.
`;

type Step = {
  id: string;
  depends_on?: string[] | string;
  deps?: string[] | string;
  needs?: string[] | string;
  requires?: string[] | string;
};

type GraphResult = {
  nodes: string[];
  depsByNode: Map<string, string[]>;
  topoOrder: string[];
  cyclePath: string[] | null;
  parseError: string | null;
};

function asArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

function parseDag(text: string): GraphResult {
  try {
    const parsed = yaml.load(text) as { steps?: Step[] } | undefined;
    if (!parsed || !Array.isArray(parsed.steps)) {
      return {
        nodes: [],
        depsByNode: new Map(),
        topoOrder: [],
        cyclePath: null,
        parseError: "Expected a YAML object with a `steps` array.",
      };
    }

    const nodes = parsed.steps
      .map((step) => step.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);

    const nodeSet = new Set(nodes);
    const depsByNode = new Map<string, string[]>();
    for (const step of parsed.steps) {
      if (!step.id) continue;
      const deps = [
        ...asArray(step.depends_on),
        ...asArray(step.deps),
        ...asArray(step.needs),
        ...asArray(step.requires),
      ].filter((dep) => nodeSet.has(dep));
      depsByNode.set(step.id, Array.from(new Set(deps)));
    }

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

    return {
      nodes,
      depsByNode,
      topoOrder: cyclePath ? [] : topo,
      cyclePath,
      parseError: null,
    };
  } catch (error) {
    return {
      nodes: [],
      depsByNode: new Map(),
      topoOrder: [],
      cyclePath: null,
      parseError: error instanceof Error ? error.message : "Invalid YAML.",
    };
  }
}

export default function Home() {
  const [yamlText, setYamlText] = useState(starterYaml);

  const graph = useMemo(() => parseDag(yamlText), [yamlText]);
  const hasCycle = Boolean(graph.cyclePath);
  const canSubmit = !graph.parseError && !hasCycle && graph.nodes.length > 0;
  const displayNodes = graph.topoOrder.length > 0 ? graph.topoOrder : graph.nodes;
  const dagNodes = useMemo(
    () =>
      displayNodes.map((nodeId) => ({
        id: nodeId,
        dependencies: graph.depsByNode.get(nodeId) ?? [],
      })),
    [displayNodes, graph.depsByNode]
  );

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-4 p-6">
      <h1 className="text-xl font-semibold tracking-tight">Workflow DAG Editor</h1>
      <div className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="flex min-h-[70vh] flex-col rounded-md border border-zinc-300 bg-white p-3 dark:border-zinc-700 dark:bg-zinc-900">
          <p className="mb-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">YAML</p>
          <textarea
            aria-label="YAML editor"
            value={yamlText}
            onChange={(event) => setYamlText(event.target.value)}
            spellCheck={false}
            className="min-h-[64vh] w-full flex-1 resize-none rounded-md border border-zinc-300 bg-zinc-50 p-4 font-mono text-sm leading-6 text-zinc-900 outline-none ring-blue-500 focus:ring-2 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
          />
        </section>

        <section className="relative min-h-[70vh] rounded-md border border-zinc-300 bg-white p-3 dark:border-zinc-700 dark:bg-zinc-900">
          <p className="mb-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">DAG Preview</p>
          <div className={hasCycle ? "pointer-events-none blur-sm" : ""}>
            {graph.parseError ? (
              <p className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
                Parse error: {graph.parseError}
              </p>
            ) : graph.nodes.length === 0 ? (
              <p className="text-sm text-zinc-600 dark:text-zinc-400">No nodes found. Add steps with `id` fields.</p>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                  Resolved order:{" "}
                  <span className="font-mono text-zinc-900 dark:text-zinc-100">{displayNodes.join(" → ")}</span>
                </p>
                <div
                  className="relative min-h-[58vh] overflow-hidden rounded-md border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950"
                >
                  <DagPreview nodes={dagNodes} />
                </div>
              </div>
            )}
          </div>
          {hasCycle && (
            <div className="absolute inset-0 flex items-center justify-center rounded-md bg-red-950/15 p-4">
              <div className="max-w-md rounded-md border border-red-300 bg-white/95 p-4 text-sm text-red-700 shadow dark:border-red-900 dark:bg-zinc-900/95 dark:text-red-300">
                <p className="font-semibold">Cycle detected</p>
                <p className="mt-1 font-mono">{graph.cyclePath?.join(" → ")}</p>
              </div>
            </div>
          )}
        </section>
      </div>
      <button
        type="button"
        disabled={!canSubmit}
        className="mt-2 self-end rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
      >
        Submit
      </button>
    </main>
  );
}
