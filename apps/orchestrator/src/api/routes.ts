import { Router, Request, Response } from "express";
import { normalizeWorkflowYamlInput, parseWorkflowString } from "../parser/yaml-parser.js";
import {
  startRun,
  listRuns,
  retryJobAndContinue,
  ensureRunLoaded,
  tryResumeRun,
} from "../orchestrator/run-manager.js";
import { stopJobRequest } from "../orchestrator/job-abort-registry.js";
import { gateManager } from "../gates/gate-manager.js";
import { eventLog } from "../event-log/event-log.js";
import { streamRunEvents } from "./sse.js";

export const router = Router();

router.post("/runs", async (req: Request, res: Response) => {
  try {
    const body = req.body as { yaml?: unknown; resumeRunId?: unknown };
    const yamlStr = normalizeWorkflowYamlInput(body.yaml);
    if (!yamlStr.trim()) {
      res.status(400).json({ error: "yaml field required" });
      return;
    }
    const parsed = parseWorkflowString(yamlStr);
    const resumeRaw = body.resumeRunId;
    const resumeRunId = typeof resumeRaw === "string" ? resumeRaw.trim() : "";
    if (resumeRunId) {
      const resumed = await tryResumeRun(resumeRunId, parsed, yamlStr);
      if (resumed) {
        res.status(200).json(resumed);
        return;
      }
    }
    res.status(201).json(await startRun(parsed, yamlStr));
  } catch (err) { res.status(400).json({ error: String(err) }); }
});

router.get("/runs", (_req, res) => res.json(listRuns()));

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

router.get("/runs/:runId/gates", (req, res) => res.json(gateManager.listPending(req.params.runId)));

router.post("/runs/:runId/gates/:jobId/approve", (req, res) => {
  try { gateManager.approve(req.params.runId, req.params.jobId, (req.body as any).editedOutput); res.json({ ok: true }); }
  catch (err) { res.status(404).json({ error: String(err) }); }
});

router.post("/runs/:runId/gates/:jobId/reject", (req, res) => {
  try { gateManager.reject(req.params.runId, req.params.jobId, (req.body as any).reason); res.json({ ok: true }); }
  catch (err) { res.status(404).json({ error: String(err) }); }
});