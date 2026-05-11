"use client";

import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { ArrowRight, BookOpen, CircleHelp } from "lucide-react";
import { useRouter } from "next/navigation";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  dreamStateWorkflowYaml,
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
    startTransition(() => {
      try {
        const saved = localStorage.getItem(WORKFLOW_YAML_STORAGE_KEY);
        if (saved) setYamlText(saved);
      } catch {
        /* ignore */
      }
      setHydrated(true);
    });
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

  const workflowStatusBadgeVariant = graph.parseError
    ? "destructive"
    : hasCycle
      ? "destructive"
      : graph.nodes.length === 0
        ? "secondary"
        : canSubmit
          ? "default"
          : "outline";

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
    <main className="relative mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col gap-10 bg-gradient-to-b from-accent/25 via-background to-background px-4 py-10 sm:px-6 lg:px-8 lg:py-14">
      <header className="relative overflow-hidden rounded-2xl border border-accent/45 bg-gradient-to-br from-card via-accent/30 to-muted/20 pl-5 pr-6 py-8 shadow-sm ring-1 ring-accent/20 sm:px-8 sm:pl-8">
        <div
          className="pointer-events-none absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-primary via-primary/70 to-accent"
          aria-hidden
        />
        <div className="pointer-events-none absolute -right-20 -top-20 size-64 rounded-full bg-primary/[0.07] blur-3xl" aria-hidden />
        <div className="relative flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl space-y-4">
            <Badge
              variant="outline"
              className="h-7 rounded-full border-accent/50 bg-accent/50 px-3 font-normal text-accent-foreground"
            >
              Bronson · DAG editor
            </Badge>
            <div>
              <h1 className="font-heading text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
                Workflow editor
              </h1>
              <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
                Author YAML, validate topology, then submit — the same file powers{" "}
                <code className="rounded-md border border-accent/30 bg-accent/40 px-1.5 py-0.5 font-mono text-[11px] text-accent-foreground">
                  /run
                </code>
                .
              </p>
            </div>
          </div>
          <div className="flex flex-shrink-0 flex-wrap items-center gap-2 rounded-2xl border border-accent/50 bg-accent/45 p-2 shadow-inner ring-1 ring-accent/15 dark:bg-accent/20 dark:ring-accent/25">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="gap-1.5 border border-border/60 bg-background/90 shadow-sm"
              onClick={() => {
                setYamlText(essayWorkflowYaml);
                try {
                  localStorage.setItem(WORKFLOW_YAML_STORAGE_KEY, essayWorkflowYaml);
                } catch {
                  /* ignore */
                }
              }}
            >
              <BookOpen className="size-3.5 opacity-80" aria-hidden />
              Essay preset
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="gap-1.5 border border-border/60 bg-background/90 shadow-sm"
              onClick={() => {
                setYamlText(dreamStateWorkflowYaml);
                try {
                  localStorage.setItem(WORKFLOW_YAML_STORAGE_KEY, dreamStateWorkflowYaml);
                } catch {
                  /* ignore */
                }
              }}
            >
              <BookOpen className="size-3.5 opacity-80" aria-hidden />
              Dream-state
            </Button>
            <Separator orientation="vertical" className="hidden h-8 bg-accent-foreground/15 sm:block" />
            <Badge
              variant={workflowStatusBadgeVariant}
              className="h-8 shrink-0 px-3 text-xs font-medium"
              role="status"
              aria-live="polite"
            >
              {workflowStatusLabel}
            </Badge>
          </div>
        </div>
      </header>

      <div className="grid flex-1 grid-cols-1 gap-5 rounded-2xl border border-accent/25 bg-accent/10 p-4 shadow-sm ring-1 ring-accent/10 sm:gap-6 sm:p-5 lg:grid-cols-2 dark:bg-accent/5">
        <section className="flex min-h-[70vh] flex-col overflow-hidden rounded-2xl border border-accent/40 bg-card py-0 shadow-sm ring-1 ring-accent/10">
          <div className="flex items-start justify-between gap-3 border-b border-accent/30 bg-accent/25 px-5 py-4">
            <div>
              <h2 className="text-sm font-semibold text-foreground">Workflow YAML</h2>
              <p className="mt-1 text-xs text-muted-foreground">Steps and dependencies drive the preview.</p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label="Open YAML reference"
              aria-expanded={yamlHelpOpen}
              aria-controls="yaml-help-dialog"
              onClick={() => setYamlHelpOpen(true)}
              title="YAML help"
              className="shrink-0 border-accent/40 bg-background/90 shadow-sm"
            >
              <CircleHelp className="size-4 text-muted-foreground" aria-hidden />
            </Button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col bg-accent/5 p-4 sm:p-5 dark:bg-accent/[0.04]">
            <textarea
              aria-label="YAML editor"
              value={yamlText}
              onChange={(event) => setYamlText(event.target.value)}
              spellCheck={false}
              className="min-h-[60vh] w-full flex-1 resize-none rounded-xl border border-accent/35 bg-background/80 p-4 font-mono text-sm leading-6 text-foreground shadow-inner outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground focus:border-primary/50 focus:ring-2 focus:ring-primary/20 dark:bg-background/60"
              placeholder={`name: workflow-name\nsteps:\n  - id: step-one`}
            />
          </div>
        </section>

        <section className="relative flex min-h-[70vh] flex-col overflow-hidden rounded-2xl border border-accent/40 bg-card py-0 shadow-sm ring-1 ring-accent/10">
          <div className="border-b border-accent/30 bg-accent/25 px-5 py-4">
            <h2 className="text-sm font-semibold text-foreground">DAG preview</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Visualization updates as your YAML parses. Cycles block submission.
            </p>
          </div>
          <div className="relative flex min-h-0 flex-1 flex-col bg-accent/5 p-4 sm:p-5 dark:bg-accent/[0.04]">
            <div className={hasCycle ? "pointer-events-none select-none blur-sm" : ""}>
              {graph.parseError ? (
                <Alert variant="destructive">
                  <AlertTitle>Could not parse workflow</AlertTitle>
                  <AlertDescription className="mt-1 font-mono text-xs leading-relaxed">{graph.parseError}</AlertDescription>
                </Alert>
              ) : graph.nodes.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-accent/45 bg-accent/15 px-5 py-10 text-center ring-1 ring-accent/10">
                  <p className="text-sm text-accent-foreground/90">
                    No steps yet. Add a{" "}
                    <code className="rounded border border-accent/30 bg-accent/40 px-1 py-0.5 font-mono text-xs">
                      steps
                    </code>{" "}
                    array with entries that include an{" "}
                    <code className="rounded border border-accent/30 bg-accent/40 px-1 py-0.5 font-mono text-xs">
                      id
                    </code>
                    .
                  </p>
                </div>
              ) : (
                <div className="flex min-h-[58vh] flex-col gap-4">
                  <p className="text-sm text-muted-foreground">
                    Resolved order:{" "}
                    <span className="break-all font-mono text-xs text-foreground sm:text-sm">
                      {displayNodes.join(" → ")}
                    </span>
                  </p>
                  <div className="relative flex min-h-[48vh] flex-1 items-center justify-center overflow-hidden rounded-xl border border-accent/35 bg-accent/20 p-2 ring-1 ring-accent/10 dark:bg-accent/15">
                    <DagPreview nodes={dagNodes} />
                  </div>
                </div>
              )}
            </div>
            {hasCycle && (
              <div className="pointer-events-none absolute inset-5 flex items-center justify-center rounded-xl bg-background/55 p-4 backdrop-blur-[2px]">
                <Alert variant="destructive" className="pointer-events-auto max-w-md shadow-lg backdrop-blur-sm">
                  <AlertTitle>Cycle detected</AlertTitle>
                  <AlertDescription className="mt-2 space-y-3">
                    <p className="break-all font-mono text-xs leading-relaxed">{graph.cyclePath?.join(" → ")}</p>
                    <p className="text-xs text-muted-foreground">
                      Break the loop by changing <code className="font-mono text-foreground">depends_on</code> so no
                      step eventually depends on itself.
                    </p>
                  </AlertDescription>
                </Alert>
              </div>
            )}
          </div>
        </section>
      </div>

      <footer className="flex flex-col gap-4 rounded-2xl border border-accent/35 bg-accent/20 px-5 py-5 shadow-sm ring-1 ring-accent/15 sm:flex-row sm:items-center sm:justify-between dark:bg-accent/15">
        <p className="max-w-prose text-xs leading-relaxed text-accent-foreground/90">
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
        <Button
          type="button"
          size="sm"
          disabled={!canSubmit}
          className="gap-1.5 self-start shadow-md ring-2 ring-primary/15 sm:self-auto"
          onClick={() => {
            try {
              localStorage.setItem(WORKFLOW_YAML_STORAGE_KEY, yamlText);
            } catch {
              /* ignore */
            }
            router.push("/run");
          }}
        >
          Submit workflow
          <ArrowRight className="size-3.5 opacity-90" aria-hidden />
        </Button>
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
            className="relative z-10 flex max-h-[min(560px,calc(100vh-4rem))] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-accent/45 bg-card shadow-xl ring-1 ring-accent/20"
          >
            <div className="flex shrink-0 items-start justify-between gap-3 border-b border-accent/30 bg-accent/20 px-5 py-4 dark:bg-accent/15">
              <div>
                <h2 id="yaml-help-title" className="font-heading text-lg font-semibold text-foreground">
                  YAML reference
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">How Bronson reads your workflow file.</p>
              </div>
              <Button
                ref={yamlHelpCloseRef}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setYamlHelpOpen(false)}
                className="border-accent/40 bg-background/90 shadow-sm"
              >
                Close
              </Button>
            </div>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-accent/5 px-5 py-4 text-sm leading-relaxed dark:bg-accent/[0.04]">
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
                <p className="font-medium text-foreground">Budget caps</p>
                <p className="mt-2 text-muted-foreground">
                  Set <code className="font-mono text-foreground">budget_usd</code> on a step to cap its LLM
                  spend. When the budget is exceeded the job pauses and an AllScale USDC
                  checkout link is created. The job resumes automatically once paid.
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
                <pre className="mt-2 overflow-x-auto rounded-xl border border-accent/35 bg-accent/15 p-4 font-mono text-xs text-foreground ring-1 ring-accent/10 dark:bg-accent/10">
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
