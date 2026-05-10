"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  parseDag,
  starterYaml,
  WORKFLOW_YAML_STORAGE_KEY,
  type GraphResult,
} from "@/lib/workflow-yaml";

type StepStatus = "idle" | "running" | "review" | "ok" | "error";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function depsSatisfied(deps: string[], statusByStep: Record<string, StepStatus>) {
  return deps.every((d) => statusByStep[d] === "ok");
}

function stepRequiresHumanGate(graph: GraphResult, stepId: string): boolean {
  if (graph.stepTypes.get(stepId) === "human_gate") return true;
  const hg = graph.humanGateByNode.get(stepId);
  return Boolean(hg && hg.length > 0);
}

function gateReviewUpstreamIds(graph: GraphResult, stepId: string): string[] {
  const hg = graph.humanGateByNode.get(stepId);
  if (hg && hg.length > 0) return hg;
  return graph.depsByNode.get(stepId) ?? [];
}

function mockAgentDiff(upstreamStepIds: string[]): string {
  return upstreamStepIds
    .map((id, i) => {
      const seed = id.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
      return [
        `--- a/${id}/proposed.ts`,
        `+++ b/${id}/proposed.ts`,
        `@@ -0,0 +1,5 @@`,
        `+/**`,
        `+ * Draft from step "${id}" (simulated agent output)`,
        `+ */`,
        `+export const draft_${i + 1} = { confidence: ${((seed % 7) + 3) / 10}, label: "${id}" };`,
        `+export const patchToken = "${(seed % 9973).toString(16)}";`,
        ``,
      ].join("\n");
    })
    .join("\n");
}

function StatusLight({ status }: { status: StepStatus }) {
  const label =
    status === "idle"
      ? "Pending"
      : status === "running"
        ? "Running"
        : status === "review"
          ? "Awaiting approval"
          : status === "ok"
            ? "Completed"
            : "Error";

  const color =
    status === "idle"
      ? "bg-zinc-300 dark:bg-zinc-600"
      : status === "running"
        ? "bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.6)]"
        : status === "review"
          ? "bg-sky-500 shadow-[0_0_10px_rgba(14,165,233,0.45)]"
          : status === "ok"
            ? "bg-emerald-500"
            : "bg-red-500";

  return (
    <div className="flex items-center gap-2">
      <span className={`size-2.5 shrink-0 rounded-full ${color}`} title={label} aria-hidden />
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
    </div>
  );
}

type GateView = {
  stepId: string;
  upstreamStepIds: string[];
  diff: string;
};

export default function RunPage() {
  const [yamlText, setYamlText] = useState(starterYaml);
  const [statusByStep, setStatusByStep] = useState<Record<string, StepStatus>>({});
  const [isRunning, setIsRunning] = useState(false);
  const [runningStepId, setRunningStepId] = useState<string | null>(null);
  const [gateView, setGateView] = useState<GateView | null>(null);
  const abortRef = useRef(false);
  const singleStepBusyRef = useRef(false);
  const gateResolveRef = useRef<((approved: boolean) => void) | null>(null);

  const loadFromStorage = useCallback(() => {
    try {
      const s = localStorage.getItem(WORKFLOW_YAML_STORAGE_KEY);
      if (s) setYamlText(s);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadFromStorage();
  }, [loadFromStorage]);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") loadFromStorage();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [loadFromStorage]);

  const graph = useMemo(() => parseDag(yamlText), [yamlText]);
  const hasCycle = Boolean(graph.cyclePath);
  const runnable = !graph.parseError && !hasCycle && graph.nodes.length > 0;
  const order = graph.topoOrder.length > 0 ? graph.topoOrder : graph.nodes;

  useEffect(() => {
    const next: Record<string, StepStatus> = {};
    for (const id of graph.nodes) next[id] = "idle";
    setStatusByStep(next);
  }, [yamlText, graph.nodes]);

  const resolveGate = useCallback((approved: boolean) => {
    const r = gateResolveRef.current;
    gateResolveRef.current = null;
    setGateView(null);
    r?.(approved);
  }, []);

  const waitForHumanGate = useCallback(
    (stepId: string, upstreamStepIds: string[]) => {
      const diff = mockAgentDiff(upstreamStepIds);
      setGateView({ stepId, upstreamStepIds, diff });
      return new Promise<boolean>((resolve) => {
        gateResolveRef.current = resolve;
      });
    },
    [],
  );

  const stop = useCallback(() => {
    abortRef.current = true;
    const r = gateResolveRef.current;
    if (r) {
      gateResolveRef.current = null;
      setGateView(null);
      r(false);
    }
  }, []);

  const executeStepBody = useCallback(
    async (stepId: string, graphRef: GraphResult): Promise<boolean> => {
      if (abortRef.current) return false;

      if (stepRequiresHumanGate(graphRef, stepId)) {
        setStatusByStep((prev) => ({ ...prev, [stepId]: "running" }));
        await sleep(280 + Math.floor(Math.random() * 220));
        if (abortRef.current) {
          setStatusByStep((prev) => ({ ...prev, [stepId]: "idle" }));
          return false;
        }
        setStatusByStep((prev) => ({ ...prev, [stepId]: "review" }));
        const upstream = gateReviewUpstreamIds(graphRef, stepId);
        const approved = await waitForHumanGate(stepId, upstream);
        if (!approved) {
          setStatusByStep((prev) => ({
            ...prev,
            [stepId]: abortRef.current ? "idle" : "error",
          }));
          return false;
        }
        setStatusByStep((prev) => ({ ...prev, [stepId]: "ok" }));
        return true;
      }

      setStatusByStep((prev) => ({ ...prev, [stepId]: "running" }));
      await sleep(550 + Math.floor(Math.random() * 450));
      if (abortRef.current) {
        setStatusByStep((prev) => ({ ...prev, [stepId]: "idle" }));
        return false;
      }
      const failed = Math.random() < 0.1;
      setStatusByStep((prev) => ({ ...prev, [stepId]: failed ? "error" : "ok" }));
      return !failed;
    },
    [waitForHumanGate],
  );

  const runSingleStep = useCallback(
    async (stepId: string) => {
      if (isRunning || singleStepBusyRef.current) return;
      const deps = graph.depsByNode.get(stepId) ?? [];
      const st = statusByStep[stepId] ?? "idle";
      if (!depsSatisfied(deps, statusByStep)) return;
      const hasProgress = graph.nodes.some((id) => statusByStep[id] === "ok");
      if (st === "error") {
        /* retry */
      } else if (st === "idle" && hasProgress) {
        /* continue manually after partial run */
      } else {
        return;
      }

      singleStepBusyRef.current = true;
      setRunningStepId(stepId);
      try {
        await executeStepBody(stepId, graph);
      } finally {
        singleStepBusyRef.current = false;
        setRunningStepId(null);
      }
    },
    [executeStepBody, graph, isRunning, statusByStep],
  );

  const run = useCallback(async () => {
    if (!runnable || isRunning || runningStepId) return;
    abortRef.current = false;
    setIsRunning(true);
    const idle: Record<string, StepStatus> = {};
    for (const id of graph.nodes) idle[id] = "idle";
    setStatusByStep(idle);

    for (const stepId of order) {
      if (abortRef.current) {
        setStatusByStep((prev) => {
          const copy = { ...prev };
          for (const id of graph.nodes) {
            if (copy[id] === "idle" || copy[id] === "running" || copy[id] === "review") copy[id] = "idle";
          }
          return copy;
        });
        break;
      }

      const ok = await executeStepBody(stepId, graph);
      if (!ok) break;
    }

    setIsRunning(false);
    abortRef.current = false;
  }, [executeStepBody, graph, isRunning, order, runnable, runningStepId]);

  return (
    <main className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col gap-8 px-5 py-8 sm:px-8 lg:py-12">
      {gateView ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) resolveGate(false);
          }}
        >
          <DialogContent
            showCloseButton={false}
            className="flex h-[min(36rem,88vh)] max-h-[88vh] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
            onPointerDownOutside={(e) => e.preventDefault()}
            onEscapeKeyDown={(e) => {
              e.preventDefault();
              resolveGate(false);
            }}
          >
            <DialogHeader className="shrink-0 space-y-2 border-b border-border px-6 py-4">
              <DialogTitle>Human gate — review agent changes</DialogTitle>
              <DialogDescription>
                Step <span className="font-mono text-foreground">{gateView.stepId}</span>
                {gateView.upstreamStepIds.length ? (
                  <>
                    {" "}
                    · upstream:{" "}
                    <span className="font-mono text-foreground">
                      {gateView.upstreamStepIds.join(", ")}
                    </span>
                  </>
                ) : null}
              </DialogDescription>
            </DialogHeader>
            <div className="min-h-0 flex-1 px-6 py-3">
              <div className="h-72 max-h-[min(20rem,50vh)] overflow-y-auto overflow-x-auto overscroll-contain sm:h-80">
                <pre className="pr-4 font-mono text-xs leading-relaxed whitespace-pre text-foreground">
                  {gateView.diff}
                </pre>
              </div>
            </div>
            <DialogFooter className="shrink-0 gap-2 border-t border-border px-6 py-4 sm:justify-end">
              <Button type="button" variant="outline" onClick={() => resolveGate(false)}>
                Deny
              </Button>
              <Button type="button" onClick={() => resolveGate(true)}>
                Approve
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      <header className="flex flex-col gap-4 border-b border-border pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <h1 className="font-heading text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Model runner
          </h1>
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Steps run in <strong className="font-medium text-foreground">topological order</strong> (simulated).{" "}
            <strong className="font-medium text-foreground">Human gate</strong> steps open a dialog with a mock diff;
            choose Approve or Deny. Other steps can still fail randomly (~10%). Use{" "}
            <strong className="font-medium text-foreground">Retry step</strong> /{" "}
            <strong className="font-medium text-foreground">Run step</strong> after a partial run.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={loadFromStorage} disabled={isRunning || Boolean(runningStepId)}>
            Reload from editor
          </Button>
          <Button type="button" variant="destructive" size="sm" onClick={stop} disabled={!isRunning && !gateView}>
            Stop
          </Button>
          <Button type="button" onClick={run} disabled={!runnable || isRunning || Boolean(runningStepId)}>
            Run
          </Button>
        </div>
      </header>

      {graph.parseError ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <p className="font-medium">Invalid workflow YAML</p>
          <p className="mt-2 font-mono text-xs">{graph.parseError}</p>
        </div>
      ) : hasCycle ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <p className="font-medium">Cycle in graph — fix the DAG editor before running.</p>
          <p className="mt-2 break-all font-mono text-xs">{graph.cyclePath?.join(" → ")}</p>
        </div>
      ) : graph.nodes.length === 0 ? (
        <p className="text-sm text-muted-foreground">No steps defined. Add steps in the DAG editor.</p>
      ) : (
        <ol className="mx-auto flex w-full max-w-3xl list-none flex-col gap-3">
          {order.map((stepId, index) => {
            const deps = graph.depsByNode.get(stepId) ?? [];
            const type = graph.stepTypes.get(stepId);
            const status = statusByStep[stepId] ?? "idle";
            const upstreamOk = depsSatisfied(deps, statusByStep);
            const hasProgress = graph.nodes.some((id) => statusByStep[id] === "ok");
            const canRunIndividually =
              upstreamOk &&
              !isRunning &&
              !runningStepId &&
              (status === "error" || (status === "idle" && hasProgress));
            const stepBusy = runningStepId === stepId;
            const showBlockedHint =
              status === "error" && !upstreamOk && !isRunning && !runningStepId;
            const needsGate = stepRequiresHumanGate(graph, stepId);

            return (
              <li
                key={stepId}
                className="flex gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm ring-1 ring-black/5 dark:ring-white/10"
              >
                <div
                  className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted font-mono text-xs font-semibold text-muted-foreground"
                  aria-hidden
                >
                  {index + 1}
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-mono text-sm font-semibold text-foreground">{stepId}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        {type ? (
                          <p className="text-xs text-muted-foreground">
                            type: <span className="font-mono text-foreground">{type}</span>
                          </p>
                        ) : null}
                        {needsGate ? (
                          <span className="rounded-md bg-sky-500/15 px-2 py-0.5 text-xs font-medium text-sky-700 dark:text-sky-300">
                            Human gate
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <StatusLight status={stepBusy ? "running" : status} />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    depends on:{" "}
                    <span className="font-mono text-foreground">{deps.length ? deps.join(", ") : "—"}</span>
                  </p>
                  {canRunIndividually ? (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="self-start"
                      onClick={() => void runSingleStep(stepId)}
                    >
                      {status === "error" ? "Retry step" : "Run step"}
                    </Button>
                  ) : null}
                  {showBlockedHint ? (
                    <p className="text-xs text-muted-foreground">Retry unavailable until all dependency steps succeed.</p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </main>
  );
}
