"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarClock, ChevronDown } from "lucide-react";
import type { JobState, JobStatus, RunState, RunStatus } from "@bronson/types";

function jobStepNeedsWork(status: JobStatus | undefined): boolean {
  if (status == null) return true;
  return status !== "completed" && status !== "skipped";
}
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

interface BudgetAlert {
  jobId: string;
  spentUsd: number;
  limitUsd: number;
  checkoutUrl: string;
  intentId: string;
}

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
      <Card className="gap-0 py-0">
        <Collapsible defaultOpen={Boolean(jobError)} className="group">
          <div className="flex items-stretch gap-2 border-b border-border/60">
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="hover:bg-muted/30 flex min-w-0 flex-1 flex-col gap-3 px-4 py-4 text-left transition-colors sm:flex-row sm:items-center sm:justify-between sm:gap-4"
              >
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-mono text-sm font-semibold text-foreground">{stepId}</p>
                    <StatusLight status={status} />
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
                <ChevronDown className="text-muted-foreground size-4 shrink-0 self-end transition-transform duration-200 group-data-[state=open]:rotate-180 sm:self-center" />
              </button>
            </CollapsibleTrigger>
            {resumeCta || showStop ? (
              <div className="flex shrink-0 flex-col justify-center gap-2 pr-3">
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
            <CardContent className="border-border space-y-4 border-t pt-4 pb-4">
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
  const [yamlText, setYamlText] = useState(() => readStoredWorkflowYaml());
  const [statusByStep, setStatusByStep] = useState<Record<string, StepStatus>>({});
  const [isRunning, setIsRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  /** Last started run (for links + job errors from GET /api/runs/:id). */
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeRunStatus, setActiveRunStatus] = useState<RunStatus | null>(null);
  const [jobErrors, setJobErrors] = useState<Record<string, string>>({});
  /** Latest job payloads from GET /api/runs/:id (tokens, timing, output). */
  const [jobDetails, setJobDetails] = useState<Record<string, JobState>>({});
  const [budgetAlert, setBudgetAlert] = useState<BudgetAlert | null>(null);
  /** DAG wave order from last GET /api/runs/:id (matches persisted run; editor order can differ after refresh). */
  const [serverStepOrder, setServerStepOrder] = useState<string[] | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const abortRef = useRef(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  /** Skip clearing job details on the first `yamlText` effect so we can merge a persisted last run. */
  const skipYamlResetOnceRef = useRef(true);
  /** Fallback while SSE can drop (proxy timeouts); cleared when run reaches a terminal state or Stop. */
  /** Browser timer id (`window.setInterval`); typed as number to avoid Node DOM global conflicts in tsc. */
  const pollRef = useRef<number | null>(null);

  /** Preferred cadence for external schedulers; persisted under BRONSON_WORKFLOW_SCHEDULE_KEY. */
  const [scheduleCadence, setScheduleCadence] = useState<ScheduleCadence>("manual");
  /** Local time (HH:MM) for daily/weekly; hourly uses the minute field only. */
  const [scheduleTime, setScheduleTime] = useState("09:00");
  const [scheduleSavedAt, setScheduleSavedAt] = useState<string | null>(null);

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

  const firstIncompleteStepId = useMemo(() => {
    if (!activeRunId || activeRunStatus === "completed") return null;
    for (const stepId of stepOrderForResume) {
      if (jobStepNeedsWork(jobDetails[stepId]?.status)) return stepId;
    }
    return null;
  }, [activeRunId, activeRunStatus, stepOrderForResume, jobDetails]);

  useEffect(() => {
    const g = parseDag(yamlText);
    const next: Record<string, StepStatus> = {};
    for (const id of g.nodes) next[id] = "idle";
    setStatusByStep(next);
    if (skipYamlResetOnceRef.current) {
      skipYamlResetOnceRef.current = false;
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
  }, [yamlText]);

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
        const res = await fetch(`/api/runs/${activeRunId}/jobs/${encodeURIComponent(stepId)}/stop`, {
          method: "POST",
        });
        const body = await res.text().catch(() => "");
        if (!res.ok) {
          setRunError(`Stop job failed (${res.status}): ${body.slice(0, 240) || res.statusText}`);
          return;
        }
      } catch (e) {
        setRunError(e instanceof Error ? e.message : String(e));
        return;
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
  }, [clearPoll]);

  const requestKillRun = useCallback(async (): Promise<boolean> => {
    if (!activeRunId) {
      stop();
      setBudgetAlert(null);
      return true;
    }
    try {
      const res = await fetch(`/api/runs/${activeRunId}/stop`, { method: "POST" });
      const body = await res.text().catch(() => "");
      if (!res.ok) {
        setRunError(`Kill run failed (${res.status}): ${body.slice(0, 240) || res.statusText}`);
        return false;
      }
      setBudgetAlert(null);
      stop();
      return true;
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }, [activeRunId, stop]);

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
            payload?: {
              reason?: string;
              error?: string;
              spentUsd?: number;
              limitUsd?: number;
              checkoutUrl?: string;
              intentId?: string;
            };
          };
          if (
            evt.type === "JOB_STARTED" ||
            evt.type === "JOB_COMPLETED" ||
            evt.type === "JOB_FAILED" ||
            evt.type === "JOB_RETRY_WARNING" ||
            evt.type === "GATE_PENDING" ||
            evt.type === "GATE_APPROVED" ||
            evt.type === "GATE_REJECTED" ||
            evt.type === "BUDGET_EXCEEDED" ||
            evt.type === "BUDGET_FUNDED" ||
            evt.type === "JOB_RESUMED" ||
            evt.type === "RUN_RESUMED" ||
            evt.type === "RUN_COMPLETED" ||
            evt.type === "RUN_FAILED"
          ) {
            void syncFromServer();
          }
          if (evt.type === "BUDGET_EXCEEDED" && evt.payload?.checkoutUrl) {
            setBudgetAlert({
              jobId: evt.jobId ?? "unknown",
              spentUsd: evt.payload.spentUsd ?? 0,
              limitUsd: evt.payload.limitUsd ?? 0,
              checkoutUrl: evt.payload.checkoutUrl,
              intentId: evt.payload.intentId ?? "",
            });
          }
          if (evt.type === "BUDGET_FUNDED" || evt.type === "JOB_RESUMED") {
            setBudgetAlert((prev) =>
              prev && evt.jobId && prev.jobId === evt.jobId ? null : prev,
            );
          }
          if (evt.type === "RUN_COMPLETED" || evt.type === "RUN_FAILED") {
            setBudgetAlert(null);
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
    [clearPoll, fetchAndApplyRunState],
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
  }, [activeRunId, activeRunStatus, yamlText]);

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
        const cont = await fetch(`/api/runs/${encodeURIComponent(resumeRunId)}/continue`, {
          method: "POST",
        });
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
    <main className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col gap-8 px-5 py-8 sm:px-8 lg:py-12">
      <header className="flex flex-col gap-4 border-b border-border pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <h1 className="font-heading text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Model runner
          </h1>
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Posts this workflow to the Bronson orchestrator (<code className="rounded bg-muted px-1 py-0.5 text-xs">POST /api/runs</code>
            ), which runs jobs through CLōD in DAG waves. Use <strong className="font-medium text-foreground">Load essay test</strong> for the 3-cycle writer/reviewer
            flow (requires <code className="text-xs">TOOL_SHELL_CWD</code> and either <code className="text-xs">ALLOW_SHELL_TOOL=true</code> or{" "}
            <code className="text-xs">ALLOW_WORKSPACE_WRITE=true</code> — see <code className="text-xs">examples/essay-write-review-3cycles.yaml</code>). Or use{" "}
            <strong className="font-medium text-foreground">jobs:</strong> / <strong className="font-medium text-foreground">steps:</strong> from the DAG editor.
            Orchestrator on port 3001; set <code className="text-xs">ORCHESTRATOR_URL</code> for the web app if needed.
          </p>
        </div>
        <div className="flex min-w-0 flex-1 flex-col items-stretch gap-4 sm:max-w-xl sm:items-end">
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={loadEssayPreset} disabled={isRunning}>
              Load essay test (3 cycles)
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={loadDreamPreset} disabled={isRunning}>
              Load dream-state
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={loadFromStorage} disabled={isRunning}>
              Reload from editor
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={stop} disabled={!isRunning}>
              Stop listening
            </Button>
            <Button type="button" variant="destructive" size="sm" onClick={() => void requestKillRun()} disabled={!isRunning}>
              Kill Run
            </Button>
            <Button type="button" onClick={() => void run()} disabled={isRunning || (!runnable && !mayContinuePersistedRun)}>
              Run
            </Button>
          </div>
          <Card size="sm" className="w-full max-w-sm border-border bg-muted/15 shadow-sm">
            <CardHeader className="gap-1 pb-2">
              <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                <CalendarClock className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                Schedule
              </CardTitle>
              <CardDescription className="text-[11px] leading-snug">
                Stored locally as <code className="rounded bg-muted px-1 font-mono">{BRONSON_WORKFLOW_SCHEDULE_KEY}</code>. Point cron / CI at{" "}
                <code className="rounded bg-muted px-1 text-[11px]">POST /api/runs</code>.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 pt-0">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="workflow-schedule" className="text-xs">
                    Cadence
                  </Label>
                  <Select
                    value={scheduleCadence}
                    onValueChange={(v) => setScheduleCadence(v as ScheduleCadence)}
                    disabled={isRunning}
                  >
                    <SelectTrigger id="workflow-schedule" size="sm" className="w-full">
                      <SelectValue placeholder="Cadence" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="manual">Manual</SelectItem>
                      <SelectItem value="hourly">Hourly</SelectItem>
                      <SelectItem value="daily">Daily</SelectItem>
                      <SelectItem value="weekly">Weekly (Sun)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="workflow-schedule-time" className="text-xs">
                    Time
                  </Label>
                  <Input
                    id="workflow-schedule-time"
                    type="time"
                    value={scheduleTime}
                    onChange={(e) => setScheduleTime(e.target.value)}
                    disabled={isRunning || scheduleCadence === "manual"}
                    className="h-8 text-xs"
                  />
                </div>
              </div>
              {scheduleCadence !== "manual" && scheduleHint ? (
                <p className="text-[11px] text-muted-foreground">{scheduleHint}</p>
              ) : null}
              {scheduleCadence !== "manual" ? (
                <p className="font-mono text-[11px] text-muted-foreground">
                  cron <span className="text-foreground">{cronExpressionForSchedule(scheduleCadence, scheduleTime)}</span>
                </p>
              ) : null}
            </CardContent>
            <CardFooter className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
              <Button type="button" size="sm" onClick={persistSchedule} disabled={isRunning}>
                Save schedule
              </Button>
              {scheduleCadence !== "manual" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setScheduleCadence("manual");
                    setScheduleTime("09:00");
                    try {
                      localStorage.removeItem(BRONSON_WORKFLOW_SCHEDULE_KEY);
                      setScheduleSavedAt(null);
                    } catch {
                      /* ignore */
                    }
                  }}
                  disabled={isRunning}
                >
                  Clear
                </Button>
              ) : null}
              {scheduleCadence !== "manual" && scheduleSavedAt ? (
                <p className="w-full text-[11px] text-muted-foreground">
                  <span className="font-mono font-medium text-foreground">{scheduleCadence}</span> ·{" "}
                  <span className="font-mono">{scheduleTime}</span> · saved <span className="font-mono">{scheduleSavedAt}</span>
                </p>
              ) : null}
            </CardFooter>
          </Card>
        </div>
      </header>

      {runError ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <p className="font-medium">Run request failed</p>
          <p className="mt-2 font-mono text-xs">{runError}</p>
        </div>
      ) : null}

      {budgetAlert ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-lg overflow-hidden rounded-2xl border border-red-500/30 bg-white shadow-2xl dark:bg-zinc-900">
            <div className="bg-red-50 px-6 py-5 dark:bg-red-950/40">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/50">
                  <span className="text-xl">🛑</span>
                </div>
                <div>
                  <h2 className="text-lg font-bold text-red-900 dark:text-red-200">Spending Limit Reached</h2>
                  <p className="text-sm text-red-700 dark:text-red-400">
                    Agent paused — top up to continue
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-5 px-6 py-5">
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                Job <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs font-semibold text-foreground dark:bg-zinc-800">{budgetAlert.jobId}</code> has
                been <strong>automatically stopped</strong> after exceeding its budget.
                No further API calls will be made until funded.
              </p>

              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-red-50 p-4 dark:bg-red-950/30">
                  <p className="text-xs font-medium text-red-600 dark:text-red-400">Amount spent</p>
                  <p className="mt-1 text-2xl font-bold text-red-700 dark:text-red-300">${budgetAlert.spentUsd.toFixed(4)}</p>
                </div>
                <div className="rounded-xl bg-zinc-100 p-4 dark:bg-zinc-800">
                  <p className="text-xs font-medium text-muted-foreground">Budget limit</p>
                  <p className="mt-1 text-2xl font-bold text-foreground">${budgetAlert.limitUsd.toFixed(4)}</p>
                </div>
              </div>

              <div className="space-y-3">
                <a
                  href={budgetAlert.checkoutUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-3 text-sm font-bold text-white shadow-lg transition hover:bg-emerald-700 hover:shadow-xl"
                >
                  <span>💳</span> Top Up with USDC to Continue
                </a>

                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => void requestKillRun()}
                    className="flex-1 rounded-xl border border-red-300 bg-white px-4 py-2.5 text-sm font-semibold text-red-700 transition hover:bg-red-50 dark:border-red-800 dark:bg-zinc-800 dark:text-red-400 dark:hover:bg-red-950/30"
                  >
                    🛑 Kill Run
                  </button>
                  <button
                    onClick={() => setBudgetAlert(null)}
                    className="flex-1 rounded-xl border border-zinc-300 bg-white px-4 py-2.5 text-sm font-medium text-zinc-600 transition hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700"
                  >
                    Dismiss
                  </button>
                </div>
              </div>

              <p className="text-center text-xs text-muted-foreground">
                Pay via AllScale → on-chain confirmation → webhook fires → agent resumes automatically
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {activeRunId ? (
        <div className="rounded-xl border border-border bg-muted/30 p-4 text-sm">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="font-medium text-foreground">Last run</p>
              <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{activeRunId}</p>
              <p className="mt-2 text-xs text-muted-foreground">
                Orchestrator status:{" "}
                <span className="font-medium text-foreground">{activeRunStatus ?? "—"}</span>
              </p>
              <a
                className="mt-3 inline-flex text-xs font-medium text-primary underline underline-offset-2"
                href={`/api/runs/${activeRunId}/events/history`}
                target="_blank"
                rel="noreferrer"
              >
                Open full event log (JSON)
              </a>
            </div>
            {Object.keys(jobDetails).length > 0 && (
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-lg bg-background p-3 text-center ring-1 ring-border">
                  <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Total cost</p>
                  <p className="mt-1 text-lg font-bold text-emerald-600">
                    ${Object.values(jobDetails).reduce((s, j) => s + (j.costUsd ?? 0), 0).toFixed(4)}
                  </p>
                </div>
                <div className="rounded-lg bg-background p-3 text-center ring-1 ring-border">
                  <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Tokens</p>
                  <p className="mt-1 text-lg font-bold text-foreground">
                    {Object.values(jobDetails).reduce((s, j) => s + (j.tokensUsed ?? 0), 0).toLocaleString()}
                  </p>
                </div>
                <div className="rounded-lg bg-background p-3 text-center ring-1 ring-border">
                  <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Jobs</p>
                  <p className="mt-1 text-lg font-bold text-foreground">
                    <span className="text-emerald-600">{Object.values(jobDetails).filter(j => j.status === "completed").length}</span>
                    <span className="text-muted-foreground">/{Object.keys(jobDetails).length}</span>
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : null}

      {(Object.keys(jobErrors).length > 0 || activeRunStatus === "failed") && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm">
          <p className="font-medium text-destructive">
            {Object.keys(jobErrors).length > 0 ? "Job error details" : "Run ended as failed"}
          </p>
          {Object.keys(jobErrors).length === 0 && activeRunStatus === "failed" ? (
            <p className="mt-2 text-xs text-muted-foreground">
              No per-job message returned — use the event log link above or check the orchestrator terminal.
            </p>
          ) : (
            <ul className="mt-3 space-y-3">
              {Object.entries(jobErrors).map(([jid, msg]) => (
                <li key={jid}>
                  <span className="font-mono text-xs font-semibold text-foreground">{jid}</span>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-background/80 p-3 font-mono text-[11px] text-destructive ring-1 ring-destructive/20">
                    {msg}
                  </pre>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 border-t border-destructive/20 pt-4 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">Typical fixes</p>
            <ul className="mt-2 list-disc space-y-1 pl-4">
              <li>
                <code className="rounded bg-muted px-1">Refusing to start shell-capable job</code> /{" "}
                <code className="rounded bg-muted px-1">ALLOW_SHELL_TOOL</code>: set{" "}
                <code className="rounded bg-muted px-1">ALLOW_SHELL_TOOL=true</code> in{" "}
                <code className="rounded bg-muted px-1">apps/orchestrator/.env</code>, restart the orchestrator, and
                set <code className="rounded bg-muted px-1">TOOL_SHELL_CWD</code> to your essay workspace (preset uses{" "}
                <code className="rounded bg-muted px-1">essay-draft.txt</code> relative to that folder).
              </li>
              <li>
                CLōD HTTP 403/401: check <code className="rounded bg-muted px-1">CLOD_API_KEY</code>,{" "}
                <code className="rounded bg-muted px-1">CLOD_BASE_URL</code>, and{" "}
                <code className="rounded bg-muted px-1">DEFAULT_AGENT_MODEL</code> in{" "}
                <code className="rounded bg-muted px-1">apps/orchestrator/.env</code>.
              </li>
              <li>
                Essay preset: set <code className="rounded bg-muted px-1">TOOL_SHELL_CWD</code> and{" "}
                <code className="rounded bg-muted px-1">ALLOW_SHELL_TOOL=true</code> (or{" "}
                <code className="rounded bg-muted px-1">ALLOW_WORKSPACE_WRITE=true</code> without shell). Writers use{" "}
                <code className="rounded bg-muted px-1">workspace_write</code> — no shell quoting. For raw shell jobs, relax{" "}
                <code className="rounded bg-muted px-1">TOOL_SHELL_ALLOWLIST_REGEX</code> if commands are blocked.
              </li>
              <li>
                Orchestrator URL: default web proxy is port 3001; if the orchestrator bound another port, set web{" "}
                <code className="rounded bg-muted px-1">ORCHESTRATOR_URL</code> (see orchestrator startup log).
              </li>
              <li>
                Live UI updates use SSE plus a 4s poll until the run finishes — refresh if something looks stuck with long shell/tool loops (
                <code className="rounded bg-muted px-1">tool_rounds_max</code>).
              </li>
              <li>
                Dream-state: scans may need higher <code className="rounded bg-muted px-1">tool_rounds_max</code> on Windows;{" "}
                <code className="rounded bg-muted px-1">emit_artifacts</code> uses shell + Node stdin only (no{" "}
                <code className="rounded bg-muted px-1">workspace_write</code>). If{" "}
                <code className="rounded bg-muted px-1">ALLOW_WORKSPACE_WRITE=false</code>, other presets may still need{" "}
                <code className="rounded bg-muted px-1">true</code>.
              </li>
            </ul>
          </div>
        </div>
      )}

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
    </main>
  );
}
