import { Router, Request, Response } from "express";
import { normalizeWorkflowYamlInput, parseWorkflowString } from "../parser/yaml-parser.js";
import { startRun, getRun, listRuns, retryJobAndContinue } from "../orchestrator/run-manager.js";
import { gateManager } from "../gates/gate-manager.js";
import { eventLog } from "../event-log/event-log.js";
import { streamRunEvents } from "./sse.js";

export const router = Router();

router.post("/runs", async (req: Request, res: Response) => {
  try {
    const yamlStr = normalizeWorkflowYamlInput((req.body as { yaml?: unknown }).yaml);
    if (!yamlStr.trim()) {
      res.status(400).json({ error: "yaml field required" });
      return;
    }
    res.status(201).json(await startRun(parseWorkflowString(yamlStr), yamlStr));
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

router.get("/runs/:runId", (req, res) => {
  const run = getRun(req.params.runId);
  if (!run) { res.status(404).json({ error: "Run not found" }); return; }
  res.json(run);
});

// Dedicated DAG endpoint for frontend (same payload as `RunState.dag`)
router.get("/runs/:runId/dag", (req, res) => {
  const run = getRun(req.params.runId);
  if (!run) { res.status(404).json({ error: "Run not found" }); return; }
  if (!run.dag) { res.status(404).json({ error: "DAG not found for this run" }); return; }
  res.json(run.dag);
});

router.get("/runs/:runId/events", (req, res) => {
  const run = getRun(req.params.runId);
  if (!run) { res.status(404).json({ error: "Run not found" }); return; }
  streamRunEvents(res, req.params.runId);
});

router.get("/runs/:runId/events/history", (req, res) => {
  const run = getRun(req.params.runId);
  if (!run) { res.status(404).json({ error: "Run not found" }); return; }
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