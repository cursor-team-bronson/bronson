"use client";

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { GateRequest, JobState, JobStatus, RunState, RunStatus } from "@bronson/types";
import { BookOpen, CalendarClock, ChevronDown, ExternalLink, Play, RefreshCw, Square } from "lucide-react";


function jobStepNeedsWork(status: JobStatus | undefined): boolean {
  if (status == null) return true;
  return status !== "completed" && status !== "skipped";
}
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import {
  BRONSON_WORKFLOW_SCHEDULE_KEY,
  dreamStateWorkflowYaml,
  essayWorkflowYaml,
  LAST_MODEL_RUN_ID_STORAGE_KEY,
  parseDag,
  readStoredWorkflowYaml,
  starterYaml,
  toOrchestratorWorkflowYaml,
  WORKFLOW_YAML_STORAGE_KEY,
} from "@/lib/workflow-yaml";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type StepStatus = "idle" | "running" | "ok" | "error";

/** Matches cron-style runners; manual = interactive Run only. */
type ScheduleCadence = "manual" | "hourly" | "daily" | "weekly";

function parseLocalTime(t: string): { hour: number; minute: number } {
  const [h, m] = t.split(":").map((x) => Number.parseInt(x, 10));
  const hour = Number.isFinite(h) ? Math.min(23, Math.max(0, h)) : 9;
  const minute = Number.isFinite(m) ? Math.min(59, Math.max(0, m)) : 0;
  return { hour, minute };
}

/** Cron expression for external runners (local wall-clock). Weekly = Sunday. */
function cronExpressionForSchedule(cadence: ScheduleCadence, timeLocal: string): string {
  const { hour, minute } = parseLocalTime(timeLocal);
  switch (cadence) {
    case "manual":
      return "—";
    case "hourly":
      return `${minute} * * * *`;
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekly":
      return `${minute} ${hour} * * 0`;
    default:
      return "—";
  }
}

function mapJobStatus(s: JobStatus): StepStatus {
  switch (s) {
    case "completed":
      return "ok";
    case "failed":
      return "error";
    case "running":
    case "gate_pending":
    case "gate_approved":
    case "awaiting_funding":
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
  /** Fallback while SSE can drop (proxy timeouts); cleared when run reaches a terminal state or Stop. */
  /** Browser timer id (`window.setInterval`); typed as number to avoid Node DOM global conflicts in tsc. */
  const pollRef = useRef<number | null>(null);

  /** Preferred cadence for external schedulers; persisted under BRONSON_WORKFLOW_SCHEDULE_KEY. */
  const [scheduleCadence, setScheduleCadence] = useState<ScheduleCadence>("manual");
  /** Local time (HH:MM) for daily/weekly; hourly uses the minute field only. */
  const [scheduleTime, setScheduleTime] = useState("09:00");
  const [scheduleSavedAt, setScheduleSavedAt] = useState<string | null>(null);

  /** Orchestrator human gate — opens modal so we POST /gates/.../approve|reject (otherwise the run blocks forever). */
  const [humanGate, setHumanGate] = useState<null | { runId: string; jobId: string; proposedOutput: string; context: string }>(
    null,
  );
  const [gateEditedOutput, setGateEditedOutput] = useState("");
  const [gateRejectReason, setGateRejectReason] = useState("");
  const [gateBusy, setGateBusy] = useState(false);
  const [gateActionError, setGateActionError] = useState<string | null>(null);

  const scheduleHint = useMemo(() => {
    switch (scheduleCadence) {
      case "manual":
        return null;
      case "hourly":
        return "At :MM every hour (minute from the clock below).";
      case "daily":
        return "Every day at this local time.";
      case "weekly":
        return "Every Sunday at this local time.";
      default:
        return null;
    }
  }, [scheduleCadence]);

  const clearPoll = useCallback(() => {
    if (pollRef.current != null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => () => clearPoll(), [clearPoll]);

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

  const loadDreamPreset = useCallback(() => {
    setYamlText(dreamStateWorkflowYaml);
    setRunError(null);
    try {
      localStorage.setItem(WORKFLOW_YAML_STORAGE_KEY, dreamStateWorkflowYaml);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadFromStorage();
  }, [loadFromStorage]);

  useEffect(() => {
    try {
      let raw = localStorage.getItem(BRONSON_WORKFLOW_SCHEDULE_KEY);
      if (!raw) raw = localStorage.getItem("bronson.scheduleDemo.v1");
      if (!raw) return;
      const o = JSON.parse(raw) as { cadence?: string; savedAt?: string; timeLocal?: string };
      const c = o.cadence;
      if (c === "hourly" || c === "daily" || c === "weekly") setScheduleCadence(c);
      else if (c === "off" || c === "manual") setScheduleCadence("manual");
      if (typeof o.savedAt === "string") setScheduleSavedAt(o.savedAt);
      if (typeof o.timeLocal === "string" && /^\d{1,2}:\d{2}$/.test(o.timeLocal)) setScheduleTime(o.timeLocal);
    } catch {
      /* ignore */
    }
  }, []);

  const persistSchedule = useCallback(() => {
    try {
      if (scheduleCadence === "manual") {
        localStorage.removeItem(BRONSON_WORKFLOW_SCHEDULE_KEY);
        setScheduleSavedAt(null);
        return;
      }
      const payload = {
        cadence: scheduleCadence,
        timeLocal: scheduleTime,
        savedAt: new Date().toISOString(),
        preview: yamlText.slice(0, 200),
      };
      localStorage.setItem(BRONSON_WORKFLOW_SCHEDULE_KEY, JSON.stringify(payload));
      setScheduleSavedAt(payload.savedAt);
    } catch {
      /* ignore */
    }
  }, [scheduleCadence, scheduleTime, yamlText]);

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

  /** Human gates need approve/reject via /gates — not "Resume run". */
  const gatePendingBlocking = useMemo(
    () => Object.values(jobDetails).some((j) => j?.status === "gate_pending"),
    [jobDetails],
  );

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

  const fetchAndApplyRunState = useCallback(async (rid: string): Promise<RunState | null> => {
    try {
      const res = await fetch(`/api/runs/${rid}`);
      if (!res.ok) return null;
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
      return runState;
    } catch {
      return null;
    }
  }, []);

  const refreshHumanGateFromServer = useCallback(async (rid: string) => {
    try {
      const res = await fetch(`/api/runs/${encodeURIComponent(rid)}/gates`);
      if (!res.ok) return;
      const list = (await res.json()) as GateRequest[];
      if (list.length === 0) {
        setHumanGate((cur) => (cur?.runId === rid ? null : cur));
        return;
      }
      const g = list[0];
      setHumanGate({ runId: g.runId, jobId: g.jobId, proposedOutput: g.proposedOutput, context: g.context });
      setGateEditedOutput(g.proposedOutput);
      setGateActionError(null);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!activeRunId) return;
    const want =
      activeRunStatus === "gate_pending" ||
      Object.values(jobDetails).some((j) => j?.status === "gate_pending");
    if (!want) {
      startTransition(() => setHumanGate(null));
      return;
    }
    startTransition(() => {
      void refreshHumanGateFromServer(activeRunId);
    });
    const id = window.setInterval(() => {
      startTransition(() => {
        void refreshHumanGateFromServer(activeRunId);
      });
    }, 1600);
    return () => clearInterval(id);
  }, [activeRunId, activeRunStatus, jobDetails, refreshHumanGateFromServer]);

  const submitGateApprove = useCallback(async () => {
    if (!humanGate) return;
    setGateBusy(true);
    setGateActionError(null);
    try {
      const same = gateEditedOutput.trim() === humanGate.proposedOutput.trim();
      const res = await fetch(
        `/api/runs/${encodeURIComponent(humanGate.runId)}/gates/${encodeURIComponent(humanGate.jobId)}/approve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(same ? {} : { editedOutput: gateEditedOutput }),
        },
      );
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? `${res.status} ${res.statusText}`);
      }
      setHumanGate(null);
      await fetchAndApplyRunState(humanGate.runId);
    } catch (e) {
      setGateActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setGateBusy(false);
    }
  }, [fetchAndApplyRunState, gateEditedOutput, humanGate]);

  const submitGateReject = useCallback(async () => {
    if (!humanGate) return;
    setGateBusy(true);
    setGateActionError(null);
    try {
      const res = await fetch(
        `/api/runs/${encodeURIComponent(humanGate.runId)}/gates/${encodeURIComponent(humanGate.jobId)}/reject`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: gateRejectReason.trim() || undefined }),
        },
      );
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? `${res.status} ${res.statusText}`);
      }
      setHumanGate(null);
      setGateRejectReason("");
      await fetchAndApplyRunState(humanGate.runId);
    } catch (e) {
      setGateActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setGateBusy(false);
    }
  }, [fetchAndApplyRunState, gateRejectReason, humanGate]);

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
      const runState = await fetchAndApplyRunState(rid);
      if (cancelled) return;
      if (!runState) {
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
    clearPoll();
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setIsRunning(false);
    setHumanGate(null);
    setGateActionError(null);
  }, [clearPoll]);

  const beginWatchingRun = useCallback(
    (runId: string) => {
      const syncFromServer = async () => {
        if (abortRef.current) return;
        const runState = await fetchAndApplyRunState(runId);
        if (runState?.status === "completed" || runState?.status === "failed") {
          clearPoll();
        }
      };

      void syncFromServer();
      if (abortRef.current) {
        setIsRunning(false);
        return;
      }

      clearPoll();
      pollRef.current = window.setInterval(() => void syncFromServer(), 4000) as number;

      eventSourceRef.current?.close();
      const es = new EventSource(`/api/runs/${runId}/events`);
      eventSourceRef.current = es;

      es.onmessage = (ev) => {
        if (abortRef.current) return;
        try {
          const evt = JSON.parse(ev.data) as {
            type: string;
            jobId?: string;
            payload?: { reason?: string; error?: string; proposedOutput?: string };
          };
          if (evt.type === "GATE_PENDING" && typeof evt.jobId === "string") {
            const pr = evt.payload?.proposedOutput;
            if (typeof pr === "string") {
              setHumanGate({ runId, jobId: evt.jobId, proposedOutput: pr, context: "" });
              setGateEditedOutput(pr);
              void refreshHumanGateFromServer(runId);
            }
          }
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
            clearPoll();
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
      };
    },
    [clearPoll, fetchAndApplyRunState, refreshHumanGateFromServer],
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
          <div className="flex w-full min-w-0 flex-col gap-4 lg:max-w-xl lg:items-end">
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
                variant="secondary"
                size="sm"
                className="gap-1.5 border border-border/60 bg-background/90 shadow-sm"
                onClick={loadDreamPreset}
                disabled={isRunning}
              >
                <BookOpen className="size-3.5 opacity-80" aria-hidden />
                Dream-state
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
                    <code className="rounded bg-background/80 px-1">Refusing to start shell-capable job</code> /{" "}
                    <code className="rounded bg-background/80 px-1">ALLOW_SHELL_TOOL</code>: set{" "}
                    <code className="rounded bg-background/80 px-1">ALLOW_SHELL_TOOL=true</code> in{" "}
                    <code className="rounded bg-background/80 px-1">apps/orchestrator/.env</code>, restart the orchestrator, and set{" "}
                    <code className="rounded bg-background/80 px-1">TOOL_SHELL_CWD</code> to your essay workspace (preset uses{" "}
                    <code className="rounded bg-background/80 px-1">essay-draft.txt</code> relative to that folder).
                  </li>
                  <li>
                    CLōD HTTP 403/401: check <code className="rounded bg-background/80 px-1">CLOD_API_KEY</code>,{" "}
                    <code className="rounded bg-background/80 px-1">CLOD_BASE_URL</code>, and{" "}
                    <code className="rounded bg-background/80 px-1">DEFAULT_AGENT_MODEL</code> in{" "}
                    <code className="rounded bg-background/80 px-1">apps/orchestrator/.env</code>.
                  </li>
                  <li>
                    Essay preset: set <code className="rounded bg-background/80 px-1">TOOL_SHELL_CWD</code> and{" "}
                    <code className="rounded bg-background/80 px-1">ALLOW_SHELL_TOOL=true</code> (or{" "}
                    <code className="rounded bg-background/80 px-1">ALLOW_WORKSPACE_WRITE=true</code> without shell). Writers use{" "}
                    <code className="rounded bg-background/80 px-1">workspace_write</code> — no shell quoting. For raw shell jobs, relax{" "}
                    <code className="rounded bg-background/80 px-1">TOOL_SHELL_ALLOWLIST_REGEX</code> if commands are blocked.
                  </li>
                  <li>
                    Web proxy: <code className="rounded bg-background/80 px-1">ORCHESTRATOR_URL</code> if the orchestrator is not on port 3001.
                  </li>
                  <li>
                    Live UI uses SSE plus a 4s poll until the run finishes — raise{" "}
                    <code className="rounded bg-background/80 px-1">tool_rounds_max</code> for long shell/tool loops.
                  </li>
                  <li>
                    Dream-state: scans may need higher <code className="rounded bg-background/80 px-1">tool_rounds_max</code> on Windows;{" "}
                    <code className="rounded bg-background/80 px-1">emit_artifacts</code> uses shell + Node stdin only (no{" "}
                    <code className="rounded bg-background/80 px-1">workspace_write</code>). If{" "}
                    <code className="rounded bg-background/80 px-1">ALLOW_WORKSPACE_WRITE=false</code>, other presets may still need{" "}
                    <code className="rounded bg-background/80 px-1">true</code>.
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
                !gatePendingBlocking &&
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

      {humanGate ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6" role="presentation">
          <div className="absolute inset-0 bg-black/55 backdrop-blur-[1px]" aria-hidden />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="human-gate-title"
            className="relative z-10 flex max-h-[min(640px,calc(100vh-3rem))] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-amber-500/35 bg-card shadow-2xl ring-1 ring-amber-500/20"
          >
            <div className="border-b border-border bg-amber-500/10 px-5 py-4 dark:bg-amber-500/15">
              <h2 id="human-gate-title" className="font-heading text-lg font-semibold text-foreground">
                Human review required
              </h2>
              <p className="mt-1 font-mono text-xs text-muted-foreground">
                Job <span className="text-foreground">{humanGate.jobId}</span> — approve or reject to continue the
                run.
              </p>
            </div>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
              <div>
                <p className="text-xs font-medium text-muted-foreground">Proposed output (edit if needed, then Approve)</p>
                <textarea
                  className="mt-2 min-h-[200px] w-full resize-y rounded-xl border border-input bg-muted/40 p-3 font-mono text-xs leading-relaxed text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  value={gateEditedOutput}
                  onChange={(e) => setGateEditedOutput(e.target.value)}
                  spellCheck={false}
                  aria-label="Proposed output to approve"
                />
              </div>
              {humanGate.context.trim() ? (
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Upstream context</p>
                  <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/30 p-3 font-mono text-[11px] text-foreground">
                    {humanGate.context}
                  </pre>
                </div>
              ) : null}
              <div>
                <p className="text-xs font-medium text-muted-foreground">Reject reason (optional)</p>
                <input
                  type="text"
                  className="mt-2 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  value={gateRejectReason}
                  onChange={(e) => setGateRejectReason(e.target.value)}
                  placeholder="e.g. tone is wrong — try again"
                />
              </div>
              {gateActionError ? (
                <p className="text-sm text-destructive" role="alert">
                  {gateActionError}
                </p>
              ) : null}
            </div>
            <div className="flex flex-shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border bg-muted/20 px-5 py-4">
              <Button type="button" variant="outline" disabled={gateBusy} onClick={() => void submitGateReject()}>
                Reject
              </Button>
              <Button type="button" disabled={gateBusy} onClick={() => void submitGateApprove()}>
                {gateBusy ? "Submitting…" : "Approve"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
