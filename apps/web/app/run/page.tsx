"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { parseDag, starterYaml, WORKFLOW_YAML_STORAGE_KEY } from "@/lib/workflow-yaml";

type StepStatus = "idle" | "running" | "ok" | "error";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function depsSatisfied(deps: string[], statusByStep: Record<string, StepStatus>) {
  return deps.every((d) => statusByStep[d] === "ok");
}

function StatusLight({ status }: { status: StepStatus }) {
  const label =
    status === "idle"
      ? "Pending"
      : status === "running"
        ? "Running"
        : status === "ok"
          ? "Completed"
          : "Error";

  const color =
    status === "idle"
      ? "bg-zinc-300 dark:bg-zinc-600"
      : status === "running"
        ? "bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.6)]"
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

export default function RunPage() {
  const [yamlText, setYamlText] = useState(starterYaml);
  const [statusByStep, setStatusByStep] = useState<Record<string, StepStatus>>({});
  const [isRunning, setIsRunning] = useState(false);
  const [runningStepId, setRunningStepId] = useState<string | null>(null);
  const abortRef = useRef(false);
  const singleStepBusyRef = useRef(false);

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

  const stop = useCallback(() => {
    abortRef.current = true;
  }, []);

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
      setStatusByStep((prev) => ({ ...prev, [stepId]: "running" }));
      try {
        await sleep(550 + Math.floor(Math.random() * 450));
        const failed = Math.random() < 0.1;
        setStatusByStep((prev) => ({ ...prev, [stepId]: failed ? "error" : "ok" }));
      } finally {
        singleStepBusyRef.current = false;
        setRunningStepId(null);
      }
    },
    [graph.depsByNode, graph.nodes, isRunning, statusByStep],
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
            if (copy[id] === "idle" || copy[id] === "running") copy[id] = "idle";
          }
          return copy;
        });
        break;
      }

      setStatusByStep((prev) => ({ ...prev, [stepId]: "running" }));
      await sleep(550 + Math.floor(Math.random() * 450));

      if (abortRef.current) {
        setStatusByStep((prev) => ({ ...prev, [stepId]: "idle" }));
        break;
      }

      const failed = Math.random() < 0.1;
      setStatusByStep((prev) => ({ ...prev, [stepId]: failed ? "error" : "ok" }));
      if (failed) break;
    }

    setIsRunning(false);
    abortRef.current = false;
  }, [graph.nodes, isRunning, order, runnable, runningStepId]);

  return (
    <main className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col gap-8 px-5 py-8 sm:px-8 lg:py-12">
      <header className="flex flex-col gap-4 border-b border-border pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <h1 className="font-heading text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Model runner
          </h1>
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Runs the workflow from the DAG editor in <strong className="font-medium text-foreground">topological order</strong>{" "}
            (simulated steps for now). Edit YAML on the DAG page, then use <strong className="font-medium text-foreground">Reload</strong>{" "}
            or switch tabs to refresh. About 10% of steps randomly fail; use <strong className="font-medium text-foreground">Retry step</strong>{" "}
            when a step errors (or <strong className="font-medium text-foreground">Run step</strong> to advance idle steps once upstream steps have completed).
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={loadFromStorage} disabled={isRunning || Boolean(runningStepId)}>
            Reload from editor
          </Button>
          <Button type="button" variant="destructive" size="sm" onClick={stop} disabled={!isRunning}>
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
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {order.map((stepId) => {
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

            return (
              <li
                key={stepId}
                className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm ring-1 ring-black/5 dark:ring-white/10"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono text-sm font-semibold text-foreground">{stepId}</p>
                    {type ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        type: <span className="font-mono text-foreground">{type}</span>
                      </p>
                    ) : null}
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
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
