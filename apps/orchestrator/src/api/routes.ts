import { Router, Request, Response } from "express";
import { normalizeWorkflowYamlInput, parseWorkflowString } from "../parser/yaml-parser.js";
import {
  startRun,
  listRuns,
  retryJobAndContinue,
  ensureRunLoaded,
  continuePersistedRun,
} from "../orchestrator/run-manager.js";
import { stopJobRequest } from "../orchestrator/job-abort-registry.js";
import { startRun, getRun, listRuns, topUpJobBudget, cancelJobFunding } from "../orchestrator/run-manager.js";
import { gateManager } from "../gates/gate-manager.js";
import { eventLog } from "../event-log/event-log.js";
import { streamRunEvents } from "./sse.js";
import { isSupabaseConfigured } from "../persist/supabase-client.js";
import {
  getWorkflowWithSteps,
  hydrateRunFromDatabase,
  listWorkflowRunsFromDb,
  listWorkflowsFromDb,
} from "../persist/supabase-sync.js";
import { budgetTracker } from "../orchestrator/budget-tracker.js";
import { generateWorkflow } from "../meta-agent/yaml-generator.js";

export const router = Router();

router.post("/runs", async (req: Request, res: Response) => {
  try {
    const body = req.body as { yaml?: unknown; resumeRunId?: unknown };
    const resumeRaw = body.resumeRunId;
    const resumeRunId = typeof resumeRaw === "string" ? resumeRaw.trim() : "";
    if (resumeRunId) {
      const resumed = await continuePersistedRun(resumeRunId);
      if (resumed) {
        res.status(200).json(resumed);
        return;
      }
    }
    const yamlStr = normalizeWorkflowYamlInput(body.yaml);
    if (!yamlStr.trim()) {
      res.status(400).json({ error: "yaml field required (or invalid resumeRunId / nothing to resume)" });
      return;
    }
    const parsed = parseWorkflowString(yamlStr);
    res.status(201).json(await startRun(parsed, yamlStr));
  } catch (err) { res.status(400).json({ error: String(err) }); }
});

router.get("/runs", (_req, res) => res.json(listRuns()));

/** Continue a persisted run from Supabase snapshot (no editor YAML required). */
router.post("/runs/:runId/continue", async (req, res) => {
  try {
    const continued = await continuePersistedRun(req.params.runId);
    if (!continued) {
      res.status(404).json({ error: "Run not found, persistence disabled, or nothing to continue" });
      return;
    }
    res.status(200).json(continued);
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

/** Re-run one failed job using upstream outputs from DB, then continue dependents in-process. */
router.post("/runs/:runId/jobs/:jobId/retry", async (req, res) => {
  const result = await retryJobAndContinue(req.params.runId, req.params.jobId);
  if ("error" in result) {
    const msg = result.error;
    const status = msg.includes("not found") ? 404 : msg.includes("disabled") ? 503 : 400;
    res.status(status).json({ error: msg });
    return;
  }
  res.status(202).json({ ok: true, message: "Retry started in background" });
});

/** Abort the in-flight LLM HTTP request for this job (if the job is currently calling the model). */
router.post("/runs/:runId/jobs/:jobId/stop", async (req, res) => {
  const run = (await ensureRunLoaded(req.params.runId)) ?? undefined;
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  if (!run.jobs[req.params.jobId]) {
    res.status(404).json({ error: "Unknown job id" });
    return;
  }
  const aborted = stopJobRequest(req.params.runId, req.params.jobId);
  res.json({ ok: true, aborted });
});

router.get("/runs/:runId", async (req, res) => {
  const run = (await ensureRunLoaded(req.params.runId)) ?? undefined;
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  res.json(run);
});

// Dedicated DAG endpoint for frontend (same payload as `RunState.dag`)
router.get("/runs/:runId/dag", async (req, res) => {
  const run = (await ensureRunLoaded(req.params.runId)) ?? undefined;
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  if (!run.dag) {
    res.status(404).json({ error: "DAG not found for this run" });
    return;
  }
  res.json(run.dag);
});

router.get("/runs/:runId/events", async (req, res) => {
  const run = (await ensureRunLoaded(req.params.runId)) ?? undefined;
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  streamRunEvents(res, req.params.runId);
});

router.get("/runs/:runId/events/history", async (req, res) => {
  const run = (await ensureRunLoaded(req.params.runId)) ?? undefined;
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  res.json(eventLog.getEventsForRun(req.params.runId));
});

router.get("/runs/:runId/gates", (req, res) =>
  res.json(gateManager.listPending(req.params.runId)),
);

router.post("/runs/:runId/gates/:jobId/approve", (req, res) => {
  try {
    gateManager.approve(req.params.runId, req.params.jobId, (req.body as any).editedOutput);
    res.json({ ok: true });
  } catch (err) { res.status(404).json({ error: String(err) }); }
});

router.post("/runs/:runId/gates/:jobId/reject", (req, res) => {
  try { gateManager.reject(req.params.runId, req.params.jobId, (req.body as any).reason); res.json({ ok: true }); }
  catch (err) { res.status(404).json({ error: String(err) }); }
});

router.get("/catalog/workflows", async (_req, res) => {
  if (!isSupabaseConfigured()) {
    res.status(503).json({ error: "Supabase is not configured on this orchestrator" });
    return;
  }
  res.json(await listWorkflowsFromDb(50));
});

router.get("/catalog/workflows/:workflowId", async (req, res) => {
  if (!isSupabaseConfigured()) {
    res.status(503).json({ error: "Supabase is not configured on this orchestrator" });
    return;
  }
  const row = await getWorkflowWithSteps(req.params.workflowId);
  if (!row) { res.status(404).json({ error: "Workflow not found" }); return; }
  res.json(row);
});
router.get("/runs/:runId/budget/awaiting", (req, res) =>
  res.json(budgetTracker.listAwaiting(req.params.runId)),
);

router.post("/runs/:runId/jobs/:jobId/fund", (req, res) => {
  const internalSecret = process.env.INTERNAL_API_SECRET;
  if (internalSecret) {
    const provided = req.headers["x-internal-secret"];
    if (provided !== internalSecret) {
      res.status(403).json({ error: "Forbidden — invalid or missing X-Internal-Secret header" });
      return;
    }
  }
  try {
    const { amountUsd, intentId } = req.body as { amountUsd?: number; intentId?: string };
    if (typeof amountUsd !== "number" || amountUsd <= 0) {
      res.status(400).json({ error: "amountUsd (positive number) required" });
      return;
    }
    topUpJobBudget(req.params.runId, req.params.jobId, amountUsd, intentId);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: String(err) }); }
});

router.post("/runs/:runId/jobs/:jobId/cancel-funding", (req, res) => {
  try {
    cancelJobFunding(req.params.runId, req.params.jobId);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: String(err) }); }
});

router.post("/generate-workflow", async (req: Request, res: Response) => {
  const internalSecret = process.env.INTERNAL_API_SECRET;
  if (internalSecret) {
    const provided = req.headers["x-internal-secret"];
    if (provided !== internalSecret) {
      res.status(403).json({ error: "Forbidden — invalid or missing X-Internal-Secret header" });
      return;
    }
  }
  try {
    const { description } = req.body as { description?: string };
    if (!description?.trim()) {
      res.status(400).json({ error: "description field required" });
      return;
    }
    const result = await generateWorkflow(description.trim());
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
