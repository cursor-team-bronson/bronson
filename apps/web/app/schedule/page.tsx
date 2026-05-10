"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { readStoredWorkflowYaml, toOrchestratorWorkflowYaml } from "@/lib/workflow-yaml";

type ScheduleStatus = "pending" | "fired" | "cancelled" | "failed";

type WorkflowScheduleRecord = {
  id: string;
  label: string;
  yaml: string;
  runAt: string;
  createdAt: string;
  status: ScheduleStatus;
  firedAt?: string;
  lastRunId?: string;
  lastError?: string;
};

function toDatetimeLocalValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function statusClasses(s: ScheduleStatus): string {
  switch (s) {
    case "pending":
      return "bg-amber-500/15 text-amber-800 dark:text-amber-200";
    case "fired":
      return "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200";
    case "cancelled":
      return "bg-muted text-muted-foreground";
    case "failed":
      return "bg-destructive/15 text-destructive";
    default:
      return "bg-muted";
  }
}

export default function SchedulePage() {
  const [label, setLabel] = useState("");
  const [runAtLocal, setRunAtLocal] = useState("");
  const [yamlText, setYamlText] = useState("");
  const [schedules, setSchedules] = useState<WorkflowScheduleRecord[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch("/api/schedule");
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `${res.status}`);
      }
      const data = (await res.json()) as { schedules: WorkflowScheduleRecord[] };
      setSchedules(data.schedules ?? []);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    setYamlText(readStoredWorkflowYaml());
    const soon = new Date(Date.now() + 60 * 60 * 1000);
    setRunAtLocal(toDatetimeLocalValue(soon));
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 20_000);
    return () => clearInterval(id);
  }, [refresh]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const converted = toOrchestratorWorkflowYaml(yamlText);
    if (!converted.ok) {
      setFormError(converted.error);
      return;
    }
    const runAtIso = new Date(runAtLocal).toISOString();
    if (Number.isNaN(Date.parse(runAtIso))) {
      setFormError("Pick a valid date and time.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          yaml: converted.yaml,
          runAt: runAtIso,
          label: label.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `${res.status}`);
      }
      await refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function cancel(id: string) {
    setFormError(null);
    try {
      const res = await fetch(`/api/schedule/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `${res.status}`);
      }
      await refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <main className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col gap-8 px-5 py-8 sm:px-8 lg:py-12">
      <header className="flex flex-col gap-4 border-b border-border pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <h1 className="font-heading text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Workflow schedule
          </h1>
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Queue a workflow YAML to start at a chosen time. The orchestrator polls every few seconds (configurable with{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">BRONSON_SCHEDULE_POLL_MS</code>) and calls the same path as{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">POST /api/runs</code>. Schedules are stored under{" "}
            <code className="text-xs">apps/orchestrator/data/workflow-schedules.json</code> (or{" "}
            <code className="text-xs">BRONSON_SCHEDULE_STORE</code>).
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void refresh()}>
          Refresh list
        </Button>
      </header>

      {loadError ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <p className="font-medium">Could not load schedules</p>
          <p className="mt-2 font-mono text-xs">{loadError}</p>
        </div>
      ) : null}

      {formError ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <p className="font-medium">Request failed</p>
          <p className="mt-2 font-mono text-xs">{formError}</p>
        </div>
      ) : null}

      <div className="grid gap-8 lg:grid-cols-2">
        <Card className="border-border">
          <CardHeader className="border-b border-border pb-4">
            <h2 className="text-lg font-semibold text-foreground">New schedule</h2>
            <p className="text-sm text-muted-foreground">YAML uses the same conversion as the model runner (editor jobs → orchestrator steps).</p>
          </CardHeader>
          <CardContent className="pt-6">
            <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium text-foreground">Label (optional)</span>
                <input
                  className="rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="Nightly report"
                  autoComplete="off"
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium text-foreground">Run at (local time)</span>
                <input
                  type="datetime-local"
                  className="rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
                  value={runAtLocal}
                  onChange={(e) => setRunAtLocal(e.target.value)}
                  required
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium text-foreground">Workflow YAML</span>
                <textarea
                  className="min-h-[220px] resize-y rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs leading-relaxed outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
                  value={yamlText}
                  onChange={(e) => setYamlText(e.target.value)}
                  spellCheck={false}
                />
              </label>
              <Button type="submit" disabled={submitting}>
                {submitting ? "Saving…" : "Add to schedule"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card className="border-border">
          <CardHeader className="border-b border-border pb-4">
            <h2 className="text-lg font-semibold text-foreground">Scheduled runs</h2>
            <p className="text-sm text-muted-foreground">Pending items can be cancelled. After a run starts, open its JSON state or continue it from the model runner.</p>
          </CardHeader>
          <CardContent className="pt-6">
            {schedules.length === 0 ? (
              <p className="text-sm text-muted-foreground">No schedules yet.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {schedules.map((s) => (
                  <li
                    key={s.id}
                    className="rounded-xl border border-border bg-muted/20 p-4 text-sm"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusClasses(s.status)}`}>
                          {s.status}
                        </span>
                        {s.label ? <span className="font-medium text-foreground">{s.label}</span> : null}
                      </div>
                      {s.status === "pending" ? (
                        <Button type="button" variant="outline" size="sm" onClick={() => void cancel(s.id)}>
                          Cancel
                        </Button>
                      ) : null}
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      Run at: <span className="font-mono text-foreground">{new Date(s.runAt).toLocaleString()}</span>
                    </p>
                    {s.firedAt ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Fired: <span className="font-mono text-foreground">{new Date(s.firedAt).toLocaleString()}</span>
                      </p>
                    ) : null}
                    {s.lastRunId ? (
                      <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                        <a
                          href={`/api/runs/${encodeURIComponent(s.lastRunId)}`}
                          className="text-xs font-medium text-primary underline underline-offset-2"
                          target="_blank"
                          rel="noreferrer"
                        >
                          View run state (JSON)
                        </a>
                        <a
                          href="/run"
                          className="text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
                        >
                          Model runner
                        </a>
                      </p>
                    ) : null}
                    {s.lastError ? (
                      <p className="mt-2 break-all font-mono text-xs text-destructive">{s.lastError}</p>
                    ) : null}
                    <p className="mt-2 break-all font-mono text-[10px] text-muted-foreground/80" title={s.id}>
                      {s.id}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
