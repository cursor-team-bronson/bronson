"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  essayWorkflowYaml,
  parseDag,
  starterYaml,
  WORKFLOW_YAML_STORAGE_KEY,
  yamlHelpExample,
} from "@/lib/workflow-yaml";

type DagNode = {
  id: string;
  dependencies: string[];
  humanGateFrom: string[];
  aiGateFrom: string[];
};
const DagPreview = dynamic<{ nodes: DagNode[] }>(() => import("@/app/dag-preview"), { ssr: false });

export default function DagPage() {
  const router = useRouter();
  const [yamlText, setYamlText] = useState(starterYaml);
  const [hydrated, setHydrated] = useState(false);
  const [yamlHelpOpen, setYamlHelpOpen] = useState(false);
  const yamlHelpCloseRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(WORKFLOW_YAML_STORAGE_KEY);
      if (saved) setYamlText(saved);
    } catch {
      /* ignore */
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(WORKFLOW_YAML_STORAGE_KEY, yamlText);
    } catch {
      /* ignore */
    }
  }, [yamlText, hydrated]);

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
    <main className="relative mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col gap-8 px-5 py-8 sm:px-8 lg:gap-10 lg:py-12">
      <header className="flex flex-col gap-4 border-b border-border pb-8 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <h1 className="font-heading text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Workflow editor
          </h1>
          <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
            Define steps in YAML, preview the DAG, and validate order before you submit. The same workflow is used on
            the model runner page.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              setYamlText(essayWorkflowYaml);
              try {
                localStorage.setItem(WORKFLOW_YAML_STORAGE_KEY, essayWorkflowYaml);
              } catch {
                /* ignore */
              }
            }}
          >
            Load essay test (3 cycles)
          </Button>
          <div
            className={`inline-flex w-fit shrink-0 items-center rounded-full border px-3 py-1 text-xs font-medium ${workflowStatusTone}`}
            role="status"
            aria-live="polite"
          >
            {workflowStatusLabel}
          </div>
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
            ? "Submit saves this YAML and opens the Model runner (/run) to execute against the orchestrator."
            : graph.parseError
              ? "Fix YAML to enable submit."
              : hasCycle
                ? "Resolve the cycle to enable submit."
                : graph.nodes.length === 0
                  ? "Define steps or jobs to submit."
                  : "Finish defining a valid DAG to submit."}
        </p>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => {
            try {
              localStorage.setItem(WORKFLOW_YAML_STORAGE_KEY, yamlText);
            } catch {
              /* ignore */
            }
            router.push("/run");
          }}
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
