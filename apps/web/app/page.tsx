"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import yaml from "js-yaml";
import dynamic from "next/dynamic";

type DagNode = {
  id: string;
  dependencies: string[];
  /** Dependency ids whose edge into this node is a human gate (distinct arrow color). */
  humanGateFrom: string[];
  /** Dependency ids whose edge into this node is an AI gate (distinct arrow color). */
  aiGateFrom: string[];
};
const DagPreview = dynamic<{ nodes: DagNode[] }>(() => import("@/app/dag-preview"), { ssr: false });

const starterYaml = `name: fan-out-agents-workflow
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

type Step = {
  id: string;
  depends_on?: string[] | string;
  deps?: string[] | string;
  needs?: string[] | string;
  requires?: string[] | string;
  /** Mark edges from these deps into this step as human-gated (colored in the preview). */
  human_gate_after?: string[] | string;
  /** Mark edges from these deps into this step as AI-gated (colored in the preview). */
  ai_gate_after?: string[] | string;
};

type GraphResult = {
  nodes: string[];
  depsByNode: Map<string, string[]>;
  humanGateByNode: Map<string, string[]>;
  aiGateByNode: Map<string, string[]>;
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
        humanGateByNode: new Map(),
        aiGateByNode: new Map(),
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
      humanGateByNode,
      aiGateByNode,
      topoOrder: cyclePath ? [] : topo,
      cyclePath,
      parseError: null,
    };
  } catch (error) {
    return {
      nodes: [],
      depsByNode: new Map(),
      humanGateByNode: new Map(),
      aiGateByNode: new Map(),
      topoOrder: [],
      cyclePath: null,
      parseError: error instanceof Error ? error.message : "Invalid YAML.",
    };
  }
}

const yamlHelpExample = `name: parallel-agents
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

export default function Home() {
  const [yamlText, setYamlText] = useState(starterYaml);
  const [yamlHelpOpen, setYamlHelpOpen] = useState(false);
  const yamlHelpCloseRef = useRef<HTMLButtonElement | null>(null);

  const graph = useMemo(() => parseDag(yamlText), [yamlText]);
  const hasCycle = Boolean(graph.cyclePath);
  const canSubmit = !graph.parseError && !hasCycle && graph.nodes.length > 0;
  const displayNodes = graph.topoOrder.length > 0 ? graph.topoOrder : graph.nodes;
  const dagNodes = useMemo(
    () =>
      displayNodes.map((nodeId) => ({
        id: nodeId,
        dependencies: graph.depsByNode.get(nodeId) ?? [],
        humanGateFrom: graph.humanGateByNode.get(nodeId) ?? [],
        aiGateFrom: graph.aiGateByNode.get(nodeId) ?? [],
      })),
    [displayNodes, graph.depsByNode, graph.humanGateByNode, graph.aiGateByNode]
  );

  const workflowStatusLabel = graph.parseError
    ? "Invalid YAML"
    : hasCycle
      ? "Cycle in graph"
      : graph.nodes.length === 0
        ? "No steps yet"
        : canSubmit
          ? "Ready to run"
          : "Incomplete";

  const workflowStatusTone = graph.parseError
    ? "bg-destructive/15 text-destructive border-destructive/25"
    : hasCycle
      ? "bg-destructive/15 text-destructive border-destructive/25"
      : graph.nodes.length === 0
        ? "bg-muted text-muted-foreground border-border"
        : canSubmit
          ? "bg-primary/12 text-primary border-primary/25"
          : "bg-muted text-muted-foreground border-border";

  useEffect(() => {
    if (!yamlHelpOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setYamlHelpOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    queueMicrotask(() => yamlHelpCloseRef.current?.focus());

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [yamlHelpOpen]);

  return (
    <main className="relative mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-8 px-5 py-8 sm:px-8 lg:gap-10 lg:py-12">
      <header className="flex flex-col gap-4 border-b border-border pb-8 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">Bronson</p>
          <h1 className="font-heading text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Workflow editor
          </h1>
          <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
            Define steps in YAML, preview the DAG, and validate order before you submit.
          </p>
        </div>
        <div
          className={`inline-flex w-fit shrink-0 items-center rounded-full border px-3 py-1 text-xs font-medium ${workflowStatusTone}`}
          role="status"
          aria-live="polite"
        >
          {workflowStatusLabel}
        </div>
      </header>

      <div className="grid flex-1 grid-cols-1 gap-6 lg:grid-cols-2 lg:gap-8">
        <section className="flex min-h-[70vh] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm ring-1 ring-black/5 dark:ring-white/10">
          <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div>
              <h2 className="text-sm font-semibold text-foreground">Workflow YAML</h2>
              <p className="mt-1 text-xs text-muted-foreground">Steps and dependencies drive the preview.</p>
            </div>
            <button
              type="button"
              aria-label="Open YAML reference"
              aria-expanded={yamlHelpOpen}
              aria-controls="yaml-help-dialog"
              onClick={() => setYamlHelpOpen(true)}
              title="YAML help"
              className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-muted/80 text-sm font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              ?
            </button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col p-4 sm:p-5">
            <textarea
              aria-label="YAML editor"
              value={yamlText}
              onChange={(event) => setYamlText(event.target.value)}
              spellCheck={false}
              className="min-h-[60vh] w-full flex-1 resize-none rounded-xl border border-input bg-muted/40 p-4 font-mono text-sm leading-6 text-foreground outline-none transition-shadow placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/40 dark:bg-muted/25"
              placeholder={`name: workflow-name\nsteps:\n  - id: step-one`}
            />
          </div>
        </section>

        <section className="relative flex min-h-[70vh] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm ring-1 ring-black/5 dark:ring-white/10">
          <div className="border-b border-border px-5 py-4">
            <h2 className="text-sm font-semibold text-foreground">DAG preview</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Visualization updates as your YAML parses. Cycles block submission.
            </p>
          </div>
          <div className="relative flex min-h-0 flex-1 flex-col p-4 sm:p-5">
            <div className={hasCycle ? "pointer-events-none select-none blur-sm" : ""}>
              {graph.parseError ? (
                <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
                  <p className="font-medium">Could not parse workflow</p>
                  <p className="mt-2 font-mono text-xs leading-relaxed opacity-95">{graph.parseError}</p>
                </div>
              ) : graph.nodes.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No steps yet. Add a <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">steps</code>{" "}
                  array with entries that include an{" "}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">id</code>.
                </p>
              ) : (
                <div className="flex min-h-[58vh] flex-col gap-4">
                  <p className="text-sm text-muted-foreground">
                    Resolved order:{" "}
                    <span className="break-all font-mono text-xs text-foreground sm:text-sm">
                      {displayNodes.join(" → ")}
                    </span>
                  </p>
                  <div className="relative flex min-h-[48vh] flex-1 items-center justify-center overflow-hidden rounded-xl border border-border bg-muted/30 p-2 dark:bg-muted/20">
                    <DagPreview nodes={dagNodes} />
                  </div>
                </div>
              )}
            </div>
            {hasCycle && (
              <div className="pointer-events-none absolute inset-5 flex items-center justify-center rounded-xl bg-background/55 p-4 backdrop-blur-[2px]">
                <div className="pointer-events-auto max-w-md rounded-xl border border-destructive/35 bg-card/95 p-5 text-sm text-destructive shadow-lg backdrop-blur-sm">
                  <p className="font-semibold text-foreground">Cycle detected</p>
                  <p className="mt-2 break-all font-mono text-xs leading-relaxed">
                    {graph.cyclePath?.join(" → ")}
                  </p>
                  <p className="mt-3 text-xs text-muted-foreground">
                    Break the loop by changing <code className="font-mono text-foreground">depends_on</code> so no
                    step eventually depends on itself.
                  </p>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>

      <footer className="flex flex-col gap-3 border-t border-border pt-8 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">
          {canSubmit
            ? "Workflow is valid and acyclic."
            : graph.parseError
              ? "Fix YAML to enable submit."
              : hasCycle
                ? "Resolve the cycle to enable submit."
                : graph.nodes.length === 0
                  ? "Define at least one step to submit."
                  : "Finish defining a valid DAG to submit."}
        </p>
        <button
          type="button"
          disabled={!canSubmit}
          className="inline-flex items-center justify-center rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm transition-opacity hover:opacity-95 disabled:pointer-events-none disabled:opacity-45"
        >
          Submit workflow
        </button>
      </footer>

      {yamlHelpOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
          role="presentation"
        >
          <button
            type="button"
            aria-label="Close YAML help"
            className="absolute inset-0 bg-black/50 backdrop-blur-[1px]"
            onClick={() => setYamlHelpOpen(false)}
          />
          <div
            role="dialog"
            id="yaml-help-dialog"
            aria-modal="true"
            aria-labelledby="yaml-help-title"
            className="relative z-10 flex max-h-[min(560px,calc(100vh-4rem))] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xl"
          >
            <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-5 py-4">
              <div>
                <h2 id="yaml-help-title" className="font-heading text-lg font-semibold text-foreground">
                  YAML reference
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">How Bronson reads your workflow file.</p>
              </div>
              <button
                ref={yamlHelpCloseRef}
                type="button"
                onClick={() => setYamlHelpOpen(false)}
                className="rounded-lg border border-border bg-muted/60 px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
              >
                Close
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 text-sm leading-relaxed">
              <div>
                <p className="font-medium text-foreground">Structure</p>
                <ul className="mt-2 list-disc space-y-1 pl-4 text-muted-foreground">
                  <li>
                    Top-level <code className="font-mono text-foreground">name</code> is optional metadata.
                  </li>
                  <li>
                    A <code className="font-mono text-foreground">steps</code> array is required.
                  </li>
                  <li>
                    Every step needs a unique{" "}
                    <code className="font-mono text-foreground">id</code> string.
                  </li>
                  <li>
                    Fan-out: several steps can share the same{" "}
                    <code className="font-mono text-foreground">depends_on</code> (for example one orchestrator step
                    spawning multiple parallel agents).
                  </li>
                </ul>
              </div>
              <div>
                <p className="font-medium text-foreground">Dependencies</p>
                <p className="mt-2 text-muted-foreground">
                  Point to other step <code className="font-mono text-foreground">id</code> values using one of{" "}
                  <code className="font-mono text-foreground">depends_on</code>,{" "}
                  <code className="font-mono text-foreground">deps</code>,{" "}
                  <code className="font-mono text-foreground">needs</code>, or{" "}
                  <code className="font-mono text-foreground">requires</code>.
                  Use a single string or a list. Unknown ids are ignored for the graph.
                </p>
              </div>
              <div>
                <p className="font-medium text-foreground">Human / AI gates</p>
                <p className="mt-2 text-muted-foreground">
                  On a step that already depends on another step, set{" "}
                  <code className="font-mono text-foreground">human_gate_after</code> or{" "}
                  <code className="font-mono text-foreground">ai_gate_after</code> to one or more of those dependency
                  ids. Human gates insert a <strong className="font-medium text-foreground">Human review</strong> box
                  between that dependency and this step; the arrow from that box to this step is amber. AI gates keep
                  a direct edge, drawn in sky blue.
                </p>
              </div>
              <div>
                <p className="font-medium text-foreground">Example</p>
                <pre className="mt-2 overflow-x-auto rounded-xl border border-border bg-muted/50 p-4 font-mono text-xs text-foreground">
                  {yamlHelpExample}
                </pre>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
