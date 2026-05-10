"use client";

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, ChevronDown, ExternalLink, Play, RefreshCw, Square } from "lucide-react";
import type { JobState, JobStatus, RunState, RunStatus } from "@bronson/types";

function jobStepNeedsWork(status: JobStatus | undefined): boolean {
  if (status == null) return true;
  return status !== "completed" && status !== "skipped";
}
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import {
  essayWorkflowYaml,
  LAST_MODEL_RUN_ID_STORAGE_KEY,
  parseDag,
  readStoredWorkflowYaml,
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

function StepStatusBadge({ status }: { status: StepStatus }) {
  const label =
    status === "idle"
      ? "Pending"
      : status === "running"
        ? "Running"
        : status === "ok"
          ? "Done"
          : "Failed";

  if (status === "running") {
    return (
      <Badge
        variant="outline"
        className="h-6 gap-1.5 border-amber-500/40 bg-amber-500/10 px-2.5 font-medium text-amber-950 dark:text-amber-100"
      >
        <span className="relative flex size-2">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-amber-400 opacity-60" />
          <span className="relative inline-flex size-2 rounded-full bg-amber-500" />
        </span>
        {label}
      </Badge>
    );
  }

  if (status === "ok") {
    return (
      <Badge
        variant="outline"
        className="h-6 border-emerald-500/35 bg-emerald-500/10 px-2.5 font-medium text-emerald-950 dark:text-emerald-100"
      >
        {label}
      </Badge>
    );
  }

  const variant = status === "idle" ? "secondary" : ("destructive" as const);

  return (
    <Badge variant={variant} className="h-6 px-2.5 font-medium">
      {label}
    </Badge>
  );
}

function jobErrorsFromRun(run: RunState): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, j] of Object.entries(run.jobs)) {
    if (j.error?.trim()) out[id] = j.error.trim();
  }
  return out;
}

function parseIsoMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
}

/** Wall time for the job attempt: completed vs in-flight vs unknown. */
function durationForJob(job: JobState | undefined, nowMs: number): number | undefined {
  if (!job?.startedAt) return undefined;
  const start = parseIsoMs(job.startedAt);
  if (start == null) return undefined;
  const inFlight =
    job.status === "running" ||
    job.status === "gate_pending" ||
    job.status === "gate_approved";
  const endMs = job.completedAt != null ? parseIsoMs(job.completedAt) : inFlight ? nowMs : undefined;
  if (endMs == null) return undefined;
  const ms = endMs - start;
  return ms >= 0 ? ms : undefined;
}

function formatDurationMs(ms: number | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

type ModelRunnerStepCardProps = {
  stepId: string;
  deps: string[];
  stepType: string | undefined;
  status: StepStatus;
  job: JobState | undefined;
  jobError: string | undefined;
  nowMs: number;
  activeRunId: string | null;
  onStopStep: (stepId: string) => void;
  /** First incomplete step in server DAG order — continue run or retry failed step. */
  resumeCta?: { label: string; disabled: boolean; onClick: () => void } | null;
};

function ModelRunnerStepCard({
  stepId,
  deps,
  stepType,
  status,
  job,
  jobError,
  nowMs,
  activeRunId,
  onStopStep,
  resumeCta,
}: ModelRunnerStepCardProps) {
  const tokens = job?.tokensUsed;
  const durationMs = durationForJob(job, nowMs);
  const tokenLabel = typeof tokens === "number" ? tokens.toLocaleString() : "—";
  const timeLabel = formatDurationMs(durationMs);
  const cost = job?.costUsd;
  const showStop =
    Boolean(activeRunId) &&
    (job?.status === "running" || (status === "running" && job === undefined));

  return (
    <li>
      <Card className="gap-0 overflow-hidden border-accent/40 py-0 shadow-sm ring-1 ring-accent/10 transition-shadow hover:border-accent/55 hover:shadow-md">
        <Collapsible defaultOpen={Boolean(jobError)} className="group">
          <div className="flex items-stretch gap-0 border-b border-accent/30 bg-accent/25">
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="hover:bg-accent/35 flex min-w-0 flex-1 flex-col gap-3 px-4 py-4 text-left transition-colors sm:flex-row sm:items-center sm:justify-between sm:gap-4"
              >
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-mono text-sm font-semibold tracking-tight text-foreground">{stepId}</p>
                    <StepStatusBadge status={status} />
                  </div>
                  {stepType ? (
                    <p className="text-xs text-muted-foreground">
                      type: <span className="font-mono text-foreground">{stepType}</span>
                    </p>
                  ) : null}
                  <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs tabular-nums text-muted-foreground">
                    <span>
                      <span className="font-medium text-foreground/80">Tokens</span>{" "}
                      <span className="font-mono text-foreground">{tokenLabel}</span>
                    </span>
                    <span>
                      <span className="font-medium text-foreground/80">Time</span>{" "}
                      <span className="font-mono text-foreground">{timeLabel}</span>
                    </span>
                  </div>
                </div>
                <ChevronDown className="text-muted-foreground/80 size-4 shrink-0 self-end transition-transform duration-300 ease-out group-data-[state=open]:rotate-180 sm:self-center" />
              </button>
            </CollapsibleTrigger>
            {resumeCta || showStop ? (
              <div className="flex shrink-0 flex-col justify-center gap-2 border-l border-accent/35 bg-accent/40 px-3 py-3 dark:bg-accent/30">
                {resumeCta ? (
                  <Button
                    type="button"
                    variant="default"
                    size="sm"
                    className="h-8 whitespace-nowrap"
                    disabled={resumeCta.disabled}
                    title="Continue this run from the first incomplete step (uses saved workflow + job outputs from the orchestrator database)"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      resumeCta.onClick();
                    }}
                  >
                    {resumeCta.label}
                  </Button>
                ) : null}
                {showStop ? (
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    className="h-8 whitespace-nowrap"
                    title="Stop the in-flight model request for this step (cancels the current CLōD HTTP call)"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onStopStep(stepId);
                    }}
                  >
                    Stop
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
          <CollapsibleContent>
            <CardContent className="space-y-4 border-t border-accent/25 bg-accent/15 pt-4 pb-5 dark:bg-accent/10">
              <p className="text-xs text-muted-foreground">
                depends on:{" "}
                <span className="font-mono text-foreground">{deps.length ? deps.join(", ") : "—"}</span>
              </p>
              {typeof cost === "number" ? (
                <p className="text-xs text-muted-foreground">
                  Est. cost:{" "}
                  <span className="font-mono text-foreground">
                    {cost < 0.0001 ? cost.toExponential(2) : `$${cost.toFixed(4)}`}
                  </span>
                </p>
              ) : null}
              {(job?.startedAt || job?.completedAt) && (
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {job.startedAt ? (
                    <>
                      started <span className="font-mono text-foreground/90">{job.startedAt}</span>
                    </>
                  ) : null}
                  {job.startedAt && job.completedAt ? " · " : null}
                  {job.completedAt ? (
                    <>
                      completed <span className="font-mono text-foreground/90">{job.completedAt}</span>
                    </>
                  ) : null}
                </p>
              )}
              {job?.output?.trim() ? (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-foreground">Output</p>
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/50 p-3 font-mono text-[11px] leading-relaxed text-foreground ring-1 ring-border">
                    {job.output.trim()}
                  </pre>
                </div>
              ) : null}
              {jobError ? (
                <div className="rounded-lg border border-destructive/35 bg-destructive/5 p-3">
                  <p className="text-xs font-medium text-destructive">Error</p>
                  <pre className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-destructive">
                    {jobError}
                  </pre>
                </div>
              ) : null}
            </CardContent>
          </CollapsibleContent>
        </Collapsible>
      </Card>
    </li>
  );
}

export default function RunPage() {
  /** Match SSR (no localStorage): hydrate from storage once on the client to avoid step-order mismatches. */
  const [yamlText, setYamlText] = useState(() => starterYaml);
  const [statusByStep, setStatusByStep] = useState<Record<string, StepStatus>>({});
  const [isRunning, setIsRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  /** Last started run (for links + job errors from GET /api/runs/:id). */
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeRunStatus, setActiveRunStatus] = useState<RunStatus | null>(null);
  const [jobErrors, setJobErrors] = useState<Record<string, string>>({});
  /** Latest job payloads from GET /api/runs/:id (tokens, timing, output). */
  const [jobDetails, setJobDetails] = useState<Record<string, JobState>>({});
  /** DAG wave order from last GET /api/runs/:id (matches persisted run; editor order can differ after refresh). */
  const [serverStepOrder, setServerStepOrder] = useState<string[] | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const abortRef = useRef(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  /** Skip clearing job details on the first `yamlText` effect so we can merge a persisted last run. */
  const skipYamlResetOnceRef = useRef(true);
  /** Next yaml change is the one-shot sync from localStorage after mount — do not clear run state. */
  const pendingStorageYamlRef = useRef(false);

  const loadFromStorage = useCallback(() => {
    try {
      const s = localStorage.getItem(WORKFLOW_YAML_STORAGE_KEY);
      if (s) setYamlText(s);
    } catch {
      /* ignore */
    }
  }, []);

  const loadEssayPreset = useCallback(() => {
    setYamlText(essayWorkflowYaml);
    setRunError(null);
    try {
      localStorage.setItem(WORKFLOW_YAML_STORAGE_KEY, essayWorkflowYaml);
    } catch {
      /* ignore */
    }
  }, []);

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
  const stepOrderForResume = serverStepOrder && serverStepOrder.length > 0 ? serverStepOrder : order;

  const firstIncompleteStepId = useMemo(() => {
    if (!activeRunId || activeRunStatus === "completed") return null;
    for (const stepId of stepOrderForResume) {
      if (jobStepNeedsWork(jobDetails[stepId]?.status)) return stepId;
    }
    return null;
  }, [activeRunId, activeRunStatus, stepOrderForResume, jobDetails]);

  useEffect(() => {
    startTransition(() => {
      const g = parseDag(yamlText);
      const next: Record<string, StepStatus> = {};
      for (const id of g.nodes) next[id] = "idle";
      setStatusByStep(next);
      if (skipYamlResetOnceRef.current) {
        skipYamlResetOnceRef.current = false;
        return;
      }
      if (pendingStorageYamlRef.current) {
        pendingStorageYamlRef.current = false;
        return;
      }
      setJobDetails({});
      setServerStepOrder(null);
      setActiveRunId(null);
      setActiveRunStatus(null);
      setJobErrors({});
      try {
        localStorage.removeItem(LAST_MODEL_RUN_ID_STORAGE_KEY);
      } catch {
        /* ignore */
      }
    });
  }, [yamlText]);

  useEffect(() => {
    startTransition(() => {
      pendingStorageYamlRef.current = true;
      setYamlText(readStoredWorkflowYaml());
    });
  }, []);

  useEffect(() => {
    if (!isRunning) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 300);
    return () => window.clearInterval(id);
  }, [isRunning]);

  const fetchAndApplyRunState = useCallback(async (rid: string): Promise<boolean> => {
    try {
      const res = await fetch(`/api/runs/${rid}`);
      if (!res.ok) return false;
      const runState = (await res.json()) as RunState;
      setActiveRunId(rid);
      setActiveRunStatus(runState.status);
      setJobErrors(jobErrorsFromRun(runState));
      setJobDetails({ ...runState.jobs });
      const waves = runState.dag?.executionWaves ?? [];
      setServerStepOrder(waves.length ? waves.flat() : null);
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
      return true;
    } catch {
      return false;
    }
  }, []);

  /** After reload: pull last run from API (orchestrator hydrates from Supabase when in-memory map is empty). */
  useEffect(() => {
    let cancelled = false;
    let rid = "";
    try {
      rid = localStorage.getItem(LAST_MODEL_RUN_ID_STORAGE_KEY)?.trim() ?? "";
    } catch {
      return;
    }
    if (!rid) return;
    void (async () => {
      const ok = await fetchAndApplyRunState(rid);
      if (cancelled) return;
      if (!ok) {
        try {
          localStorage.removeItem(LAST_MODEL_RUN_ID_STORAGE_KEY);
        } catch {
          /* ignore */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchAndApplyRunState]);

  const stopStep = useCallback(
    async (stepId: string) => {
      if (!activeRunId) return;
      try {
        await fetch(`/api/runs/${activeRunId}/jobs/${encodeURIComponent(stepId)}/stop`, { method: "POST" });
      } catch {
        /* ignore */
      }
      await fetchAndApplyRunState(activeRunId);
    },
    [activeRunId, fetchAndApplyRunState],
  );

  const stop = useCallback(() => {
    abortRef.current = true;
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setIsRunning(false);
  }, []);

  const beginWatchingRun = useCallback(
    (runId: string) => {
      const syncFromServer = async () => {
        if (abortRef.current) return;
        await fetchAndApplyRunState(runId);
      };

      void syncFromServer();
      if (abortRef.current) {
        setIsRunning(false);
        return;
      }

      eventSourceRef.current?.close();
      const es = new EventSource(`/api/runs/${runId}/events`);
      eventSourceRef.current = es;

      es.onmessage = (ev) => {
        if (abortRef.current) return;
        try {
          const evt = JSON.parse(ev.data) as {
            type: string;
            payload?: { reason?: string; error?: string };
          };
          if (
            evt.type === "JOB_STARTED" ||
            evt.type === "JOB_COMPLETED" ||
            evt.type === "JOB_FAILED" ||
            evt.type === "JOB_RETRY_WARNING" ||
            evt.type === "GATE_PENDING" ||
            evt.type === "GATE_APPROVED" ||
            evt.type === "GATE_REJECTED" ||
            evt.type === "RUN_RESUMED" ||
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
    },
    [fetchAndApplyRunState],
  );

  const resumeFromFirstIncomplete = useCallback(async () => {
    if (!activeRunId || !firstIncompleteStepId || isRunning) return;

    abortRef.current = false;
    setRunError(null);
    setIsRunning(true);

    try {
      const st = jobDetails[firstIncompleteStepId]?.status;
      if (st === "failed") {
        const res = await fetch(
          `/api/runs/${encodeURIComponent(activeRunId)}/jobs/${encodeURIComponent(firstIncompleteStepId)}/retry`,
          { method: "POST" },
        );
        if (!res.ok) {
          const errBody = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(errBody.error ?? `${res.status} ${res.statusText}`);
        }
      } else {
        const res = await fetch(`/api/runs/${encodeURIComponent(activeRunId)}/continue`, {
          method: "POST",
        });
        if (!res.ok) {
          const errBody = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(errBody.error ?? `${res.status} ${res.statusText}`);
        }
      }

      await fetchAndApplyRunState(activeRunId);
      try {
        localStorage.setItem(LAST_MODEL_RUN_ID_STORAGE_KEY, activeRunId);
      } catch {
        /* ignore */
      }
      beginWatchingRun(activeRunId);
    } catch (e) {
      setIsRunning(false);
      setRunError(e instanceof Error ? e.message : String(e));
    }
  }, [activeRunId, beginWatchingRun, fetchAndApplyRunState, firstIncompleteStepId, isRunning, jobDetails]);

  const mayContinuePersistedRun = useMemo(() => {
    if (activeRunId && activeRunStatus && activeRunStatus !== "completed") return true;
    try {
      return Boolean(localStorage.getItem(LAST_MODEL_RUN_ID_STORAGE_KEY)?.trim());
    } catch {
      return false;
    }
  }, [activeRunId, activeRunStatus]);

  const run = useCallback(async () => {
    if (isRunning) return;

    abortRef.current = false;
    setRunError(null);

    let resumeRunId: string | undefined;
    try {
      const s = localStorage.getItem(LAST_MODEL_RUN_ID_STORAGE_KEY)?.trim();
      if (s) resumeRunId = s;
    } catch {
      /* ignore */
    }

    setIsRunning(true);

    try {
      if (resumeRunId) {
        let cont: Response;
        try {
          cont = await fetch(`/api/runs/${encodeURIComponent(resumeRunId)}/continue`, {
            method: "POST",
          });
        } catch {
          try {
            localStorage.removeItem(LAST_MODEL_RUN_ID_STORAGE_KEY);
          } catch {
            /* ignore */
          }
          setIsRunning(false);
          setRunError(
            `Could not reach the server to resume run ${resumeRunId}. The saved run id was cleared. Check the orchestrator and ORCHESTRATOR_URL, then use Run to start fresh or paste a run id.`,
          );
          return;
        }
        if (cont.ok) {
          const started = (await cont.json()) as RunState;
          const runId = started.runId;
          setActiveRunId(runId);
          setActiveRunStatus(started.status);
          setJobErrors(jobErrorsFromRun(started));
          setJobDetails({ ...started.jobs });
          const waves = started.dag?.executionWaves ?? [];
          setServerStepOrder(waves.length ? waves.flat() : null);
          setStatusByStep((prev) => {
            const next = { ...prev };
            for (const [jid, j] of Object.entries(started.jobs)) {
              next[jid] = mapJobStatus(j.status);
            }
            return next;
          });
          try {
            localStorage.setItem(LAST_MODEL_RUN_ID_STORAGE_KEY, runId);
          } catch {
            /* ignore */
          }
          beginWatchingRun(runId);
          return;
        }

        try {
          localStorage.removeItem(LAST_MODEL_RUN_ID_STORAGE_KEY);
        } catch {
          /* ignore */
        }
        const errBody = (await cont.json().catch(() => ({}))) as { error?: string };
        setIsRunning(false);
        setRunError(
          errBody.error ??
            `Could not resume the saved run (${resumeRunId}). It may already be finished or the server rejected continue. The saved run id was cleared; fix the issue or start a new run with Run.`,
        );
        return;
      }

      if (!runnable) {
        setIsRunning(false);
        return;
      }

      const converted = toOrchestratorWorkflowYaml(yamlText);
      if (!converted.ok) {
        setRunError(converted.error);
        setIsRunning(false);
        return;
      }

      setJobErrors({});
      setJobDetails({});
      setActiveRunStatus(null);
      const idle: Record<string, StepStatus> = {};
      for (const id of graph.nodes) idle[id] = "idle";
      setStatusByStep(idle);

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
      const runId = started.runId;
      setActiveRunId(runId);
      setActiveRunStatus(started.status);
      setJobErrors(jobErrorsFromRun(started));
      setJobDetails({ ...started.jobs });
      const waves = started.dag?.executionWaves ?? [];
      setServerStepOrder(waves.length ? waves.flat() : null);
      setStatusByStep((prev) => {
        const next = { ...prev };
        for (const [jid, j] of Object.entries(started.jobs)) {
          next[jid] = mapJobStatus(j.status);
        }
        return next;
      });
      try {
        localStorage.setItem(LAST_MODEL_RUN_ID_STORAGE_KEY, runId);
      } catch {
        /* ignore */
      }
      beginWatchingRun(runId);
    } catch (e) {
      setIsRunning(false);
      setActiveRunId(null);
      setRunError(e instanceof Error ? e.message : String(e));
    }
  }, [beginWatchingRun, graph.nodes, isRunning, runnable, yamlText]);

  return (
    <main className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col gap-10 bg-gradient-to-b from-accent/25 via-background to-background px-4 py-10 sm:px-6 lg:px-8 lg:py-14">
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
              Bronson · CLōD DAG
            </Badge>
            <div>
              <h1 className="font-heading text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
                Model runner
              </h1>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                Ship YAML to{" "}
                <code className="rounded-md border border-accent/30 bg-accent/40 px-1.5 py-0.5 font-mono text-[11px] text-accent-foreground">
                  POST /api/runs
                </code>{" "}
                and watch jobs execute in waves. <span className="text-foreground/90">Essay preset</span> runs three writer/reviewer cycles
                (orchestrator needs <code className="font-mono text-[11px]">ALLOW_SHELL_TOOL</code> +{" "}
                <code className="font-mono text-[11px]">TOOL_SHELL_CWD</code>). Sync steps from the DAG editor or{" "}
                <code className="font-mono text-[11px]">examples/essay-write-review-3cycles.yaml</code>. Default orchestrator:{" "}
                <code className="font-mono text-[11px]">3001</code> — override with <code className="font-mono text-[11px]">ORCHESTRATOR_URL</code>.
              </p>
            </div>
          </div>
          <div className="flex flex-shrink-0 flex-wrap items-center gap-2 rounded-2xl border border-accent/50 bg-accent/45 p-2 shadow-inner ring-1 ring-accent/15 dark:bg-accent/20 dark:ring-accent/25">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="gap-1.5 border border-border/60 bg-background/90 shadow-sm"
              onClick={loadEssayPreset}
              disabled={isRunning}
            >
              <BookOpen className="size-3.5 opacity-80" aria-hidden />
              Essay preset
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5 border-border/70 bg-background/90 shadow-sm"
              onClick={loadFromStorage}
              disabled={isRunning}
            >
              <RefreshCw className="size-3.5 opacity-80" aria-hidden />
              Reload YAML
            </Button>
            <Separator orientation="vertical" className="hidden h-8 bg-accent-foreground/15 sm:block" />
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="gap-1.5 shadow-sm"
              onClick={stop}
              disabled={!isRunning}
            >
              <Square className="size-3.5 opacity-80" aria-hidden />
              Stop
            </Button>
            <Button
              type="button"
              size="sm"
              className="gap-1.5 shadow-md ring-2 ring-primary/15"
              onClick={() => void run()}
              disabled={isRunning || (!runnable && !mayContinuePersistedRun)}
            >
              <Play className="size-3.5 opacity-90" aria-hidden />
              Run
            </Button>
          </div>
        </div>
      </header>

      <div className="flex flex-col gap-6 rounded-2xl border border-accent/25 bg-accent/10 p-4 shadow-sm ring-1 ring-accent/10 sm:p-5 dark:bg-accent/5">
        {runError ? (
          <Alert variant="destructive">
            <AlertTitle>Run request failed</AlertTitle>
            <AlertDescription className="mt-1 font-mono text-xs leading-relaxed">{runError}</AlertDescription>
          </Alert>
        ) : null}

        {activeRunId ? (
          <Alert className="border-accent/50 bg-accent/35 shadow-sm ring-1 ring-accent/20 dark:bg-accent/25">
            <AlertTitle className="flex flex-wrap items-center gap-2">
              Active run
              {activeRunStatus ? (
                <Badge variant="secondary" className="font-mono text-[10px] uppercase tracking-wide">
                  {activeRunStatus}
                </Badge>
              ) : null}
            </AlertTitle>
            <AlertDescription className="mt-2 space-y-3">
              <p className="break-all font-mono text-xs text-muted-foreground">{activeRunId}</p>
              <Button variant="link" size="sm" className="h-auto p-0 text-xs font-medium" asChild>
                <a href={`/api/runs/${activeRunId}/events/history`} target="_blank" rel="noreferrer">
                  Event log (JSON)
                  <ExternalLink className="ml-1 size-3.5 opacity-70" aria-hidden />
                </a>
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        {(Object.keys(jobErrors).length > 0 || activeRunStatus === "failed") && (
          <Alert variant="destructive">
            <AlertTitle>{Object.keys(jobErrors).length > 0 ? "Job errors" : "Run failed"}</AlertTitle>
            <AlertDescription className="mt-2 space-y-4">
              {Object.keys(jobErrors).length === 0 && activeRunStatus === "failed" ? (
                <p className="text-xs text-destructive/90">
                  No per-job message returned — open the event log or check the orchestrator terminal.
                </p>
              ) : (
                <ul className="divide-y divide-destructive/15 space-y-0">
                  {Object.entries(jobErrors).map(([jid, msg]) => (
                    <li key={jid} className="pt-4 first:pt-0">
                      <Badge variant="outline" className="mb-2 font-mono text-xs">
                        {jid}
                      </Badge>
                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-destructive/25 bg-background/60 p-3 font-mono text-[11px] leading-relaxed text-destructive">
                        {msg}
                      </pre>
                    </li>
                  ))}
                </ul>
              )}
              <div className="rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-3">
                <p className="text-xs font-medium text-foreground">Typical fixes</p>
                <ul className="mt-2 list-disc space-y-1.5 pl-4 text-xs text-muted-foreground">
                  <li>
                    <code className="rounded bg-background/80 px-1">ALLOW_SHELL_TOOL=true</code> and{" "}
                    <code className="rounded bg-background/80 px-1">TOOL_SHELL_CWD</code> for essay shell writes.
                  </li>
                  <li>
                    CLōD <code className="rounded bg-background/80 px-1">403/401</code>:{" "}
                    <code className="rounded bg-background/80 px-1">CLOD_API_KEY</code>,{" "}
                    <code className="rounded bg-background/80 px-1">CLOD_BASE_URL</code>,{" "}
                    <code className="rounded bg-background/80 px-1">DEFAULT_AGENT_MODEL</code>.
                  </li>
                  <li>
                    Blocked commands: <code className="rounded bg-background/80 px-1">TOOL_SHELL_ALLOWLIST_REGEX</code> (dev only).
                  </li>
                  <li>
                    Web proxy: <code className="rounded bg-background/80 px-1">ORCHESTRATOR_URL</code> if not on port 3001.
                  </li>
                </ul>
              </div>
            </AlertDescription>
          </Alert>
        )}

        {graph.parseError ? (
          <Alert variant="destructive">
            <AlertTitle>Invalid workflow YAML</AlertTitle>
            <AlertDescription className="mt-1 font-mono text-xs">{graph.parseError}</AlertDescription>
          </Alert>
        ) : hasCycle ? (
          <Alert variant="destructive">
            <AlertTitle>Cycle in graph</AlertTitle>
            <AlertDescription className="mt-1 break-all font-mono text-xs">{graph.cyclePath?.join(" → ")}</AlertDescription>
          </Alert>
        ) : graph.nodes.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-accent/45 bg-accent/20 px-6 py-12 text-center ring-1 ring-accent/15">
            <p className="text-sm text-accent-foreground/90">No steps in this workflow. Add steps in the DAG editor.</p>
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-5 md:grid-cols-2">
          {order.map((stepId) => (
            <ModelRunnerStepCard
              key={stepId}
              stepId={stepId}
              deps={graph.depsByNode.get(stepId) ?? []}
              stepType={graph.stepTypes.get(stepId)}
              status={statusByStep[stepId] ?? "idle"}
              job={jobDetails[stepId]}
              jobError={jobErrors[stepId]}
              nowMs={nowMs}
              activeRunId={activeRunId}
              onStopStep={(id) => void stopStep(id)}
              resumeCta={
                activeRunId &&
                firstIncompleteStepId === stepId &&
                activeRunStatus !== "completed"
                  ? {
                      label: jobDetails[stepId]?.status === "failed" ? "Retry step" : "Resume run",
                      disabled: isRunning,
                      onClick: () => void resumeFromFirstIncomplete(),
                    }
                  : null
              }
            />
          ))}
        </ul>
      )}
      </div>
    </main>
  );
}
