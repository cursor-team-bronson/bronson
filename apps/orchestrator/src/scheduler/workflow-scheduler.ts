import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeWorkflowYamlInput, parseWorkflowString } from "../parser/yaml-parser.js";
import { startRun } from "../orchestrator/run-manager.js";

export type ScheduleStatus = "pending" | "fired" | "cancelled" | "failed";

export type WorkflowScheduleRecord = {
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

type StoreFile = { schedules: WorkflowScheduleRecord[] };

const schedules = new Map<string, WorkflowScheduleRecord>();
let pollHandle: ReturnType<typeof setInterval> | undefined;
let tickInFlight = false;

function storePath(): string {
  const fromEnv = process.env.BRONSON_SCHEDULE_STORE?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(process.cwd(), "data", "workflow-schedules.json");
}

function loadSync(): void {
  const p = storePath();
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as StoreFile;
    if (!parsed?.schedules || !Array.isArray(parsed.schedules)) return;
    schedules.clear();
    for (const row of parsed.schedules) {
      if (row?.id && typeof row.yaml === "string") schedules.set(row.id, row);
    }
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") console.warn("[scheduler] Could not load schedule store:", e);
  }
}

function saveSync(): void {
  const p = storePath();
  const dir = path.dirname(p);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.error("[scheduler] Could not create data directory:", e);
    return;
  }
  const payload: StoreFile = { schedules: [...schedules.values()] };
  try {
    fs.writeFileSync(p, JSON.stringify(payload, null, 2), "utf8");
  } catch (e) {
    console.error("[scheduler] Could not persist schedule store (disk full, permissions, etc.):", e);
  }
}

export function listSchedules(): WorkflowScheduleRecord[] {
  return [...schedules.values()].sort((a, b) => Date.parse(a.runAt) - Date.parse(b.runAt));
}

export function addSchedule(input: { yaml?: unknown; runAt?: unknown; label?: unknown }): WorkflowScheduleRecord {
  const yamlStr = normalizeWorkflowYamlInput(input.yaml);
  if (!yamlStr.trim()) throw new Error("yaml field required");
  const runAtRaw = input.runAt;
  const runAtStr = typeof runAtRaw === "string" ? runAtRaw.trim() : "";
  const runAtMs = Date.parse(runAtStr);
  if (Number.isNaN(runAtMs)) throw new Error("runAt must be a valid ISO date string");
  const pastSkewMs = 5000;
  if (runAtMs < Date.now() - pastSkewMs) {
    throw new Error("runAt must be in the future (at least a few seconds from now)");
  }
  parseWorkflowString(yamlStr);
  const labelRaw = input.label;
  const label = typeof labelRaw === "string" ? labelRaw.trim() : "";
  const rec: WorkflowScheduleRecord = {
    id: randomUUID(),
    label,
    yaml: yamlStr,
    runAt: new Date(runAtMs).toISOString(),
    createdAt: new Date().toISOString(),
    status: "pending",
  };
  schedules.set(rec.id, rec);
  saveSync();
  return rec;
}

export function cancelSchedule(id: string): boolean {
  const s = schedules.get(id);
  if (!s || s.status !== "pending") return false;
  s.status = "cancelled";
  saveSync();
  return true;
}

async function fireDue(): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    const now = Date.now();
    const due = [...schedules.values()]
      .filter((s) => s.status === "pending" && Date.parse(s.runAt) <= now)
      .sort((a, b) => Date.parse(a.runAt) - Date.parse(b.runAt));
    for (const s of due) {
      if (s.status !== "pending") continue;
      try {
        const parsed = parseWorkflowString(s.yaml);
        if (s.status !== "pending") continue;
        const run = await startRun(parsed, s.yaml);
        if (s.status !== "pending") {
          console.warn(
            `[scheduler] Schedule ${s.id} was no longer pending after startRun (e.g. cancelled in flight); not marking fired`,
          );
          continue;
        }
        s.status = "fired";
        s.firedAt = new Date().toISOString();
        s.lastRunId = run.runId;
        delete s.lastError;
      } catch (e) {
        if (s.status !== "pending") {
          console.warn(
            `[scheduler] Schedule ${s.id} was no longer pending after startRun error; not marking failed`,
            e,
          );
          continue;
        }
        s.status = "failed";
        s.firedAt = new Date().toISOString();
        s.lastError = String(e);
      }
      saveSync();
    }
  } catch (e) {
    console.error("[scheduler] Unexpected error in fireDue:", e);
  } finally {
    tickInFlight = false;
  }
}

function parseIntervalMs(): number {
  const raw = process.env.BRONSON_SCHEDULE_POLL_MS?.trim();
  if (!raw) return 15_000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1000 ? n : 15_000;
}

export function startWorkflowScheduler(): void {
  loadSync();
  if (pollHandle) clearInterval(pollHandle);
  void fireDue();
  pollHandle = setInterval(() => {
    void fireDue();
  }, parseIntervalMs());
}
