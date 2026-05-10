"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JobStatus, RunState } from "@bronson/types";
import { Button } from "@/components/ui/button";
import {
  parseDag,
  starterYaml,
  toOrchestratorWorkflowYaml,
  WORKFLOW_YAML_STORAGE_KEY,
} from "@/lib/workflow-yaml";

type StepStatus = "idle" | "running" | "ok" | "error";

function mapJobStatus(s: JobStatus): StepStatus {
  switch (s) {
    case "completed":
      return "ok";
    case "failed":
      return "error";
    case "running":
    case "gate_pending":
    case "gate_approved":
      return "running";
    case "skipped":
    case "pending":
    default:
      return "idle";
  }
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
  const [runError, setRunError] = useState<string | null>(null);
  const abortRef = useRef(false);
  const eventSourceRef = useRef<EventSource | null>(null);

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
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setIsRunning(false);
  }, []);

  const run = useCallback(async () => {
    if (!runnable || isRunning) return;

    const converted = toOrchestratorWorkflowYaml(yamlText);
    if (!converted.ok) {
      setRunError(converted.error);
      return;
    }

    abortRef.current = false;
    setRunError(null);
    setIsRunning(true);

    const idle: Record<string, StepStatus> = {};
    for (const id of graph.nodes) idle[id] = "idle";
    setStatusByStep(idle);

    let runId: string;
    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yaml: converted.yaml }),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errBody.error ?? `${res.status} ${res.statusText}`);
      }
      const started = (await res.json()) as RunState;
      runId = started.runId;
    } catch (e) {
      setIsRunning(false);
      setRunError(e instanceof Error ? e.message : String(e));
      return;
    }

    const syncFromServer = async () => {
      if (abortRef.current) return;
      try {
        const res = await fetch(`/api/runs/${runId}`);
        if (!res.ok) return;
        const runState = (await res.json()) as RunState;
        setStatusByStep((prev) => {
          const next = { ...prev };
          for (const [jid, j] of Object.entries(runState.jobs)) {
            next[jid] = mapJobStatus(j.status);
          }
          return next;
        });
        if (runState.status === "completed" || runState.status === "failed") {
          setIsRunning(false);
          eventSourceRef.current?.close();
          eventSourceRef.current = null;
        }
      } catch {
        /* ignore */
      }
    };

    await syncFromServer();

    if (abortRef.current) {
      setIsRunning(false);
      return;
    }

    const es = new EventSource(`/api/runs/${runId}/events`);
    eventSourceRef.current = es;

    es.onmessage = (ev) => {
      if (abortRef.current) return;
      try {
        const evt = JSON.parse(ev.data) as { type: string };
        if (
          evt.type === "JOB_STARTED" ||
          evt.type === "JOB_COMPLETED" ||
          evt.type === "JOB_FAILED" ||
          evt.type === "JOB_RETRY_WARNING" ||
          evt.type === "GATE_PENDING" ||
          evt.type === "GATE_APPROVED" ||
          evt.type === "GATE_REJECTED" ||
          evt.type === "RUN_COMPLETED" ||
          evt.type === "RUN_FAILED"
        ) {
          void syncFromServer();
        }
        if (evt.type === "RUN_COMPLETED" || evt.type === "RUN_FAILED") {
          es.close();
          if (eventSourceRef.current === es) eventSourceRef.current = null;
          setIsRunning(false);
        }
      } catch {
        /* ignore */
      }
    };

    es.onerror = () => {
      es.close();
      if (eventSourceRef.current === es) eventSourceRef.current = null;
      if (!abortRef.current) void syncFromServer();
      setIsRunning(false);
    };
  }, [graph.nodes, isRunning, runnable, yamlText]);

  return (
    <main className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col gap-8 px-5 py-8 sm:px-8 lg:py-12">
      <header className="flex flex-col gap-4 border-b border-border pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <h1 className="font-heading text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Model runner
          </h1>
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Posts this workflow to the Bronson orchestrator (<code className="rounded bg-muted px-1 py-0.5 text-xs">POST /api/runs</code>
            ), which runs jobs through CLōD in DAG waves. Use YAML with <strong className="font-medium text-foreground">jobs:</strong>{" "}
            (see <code className="text-xs">examples/hello-world-ticker.yaml</code>) or <strong className="font-medium text-foreground">steps:</strong> from the DAG
            editor (converted automatically). Keep the orchestrator on port 3001 or set <code className="text-xs">ORCHESTRATOR_URL</code>.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={loadFromStorage} disabled={isRunning}>
            Reload from editor
          </Button>
          <Button type="button" variant="destructive" size="sm" onClick={stop} disabled={!isRunning}>
            Stop listening
          </Button>
          <Button type="button" onClick={run} disabled={!runnable || isRunning}>
            Run
          </Button>
        </div>
      </header>

      {runError ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <p className="font-medium">Run request failed</p>
          <p className="mt-2 font-mono text-xs">{runError}</p>
        </div>
      ) : null}

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
                  <StatusLight status={status} />
                </div>
                <p className="text-xs text-muted-foreground">
                  depends on:{" "}
                  <span className="font-mono text-foreground">{deps.length ? deps.join(", ") : "—"}</span>
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
