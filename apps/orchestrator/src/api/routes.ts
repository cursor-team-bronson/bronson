import { Router, Request, Response } from "express";
import { normalizeWorkflowYamlInput, parseWorkflowString } from "../parser/yaml-parser.js";
import { startRun, getRun, listRuns, topUpJobBudget, cancelJobFunding } from "../orchestrator/run-manager.js";
import { gateManager } from "../gates/gate-manager.js";
import { eventLog } from "../event-log/event-log.js";
import { streamRunEvents } from "./sse.js";
import { budgetTracker } from "../orchestrator/budget-tracker.js";
import { generateWorkflow } from "../meta-agent/yaml-generator.js";

export const router = Router();

router.post("/runs", async (req: Request, res: Response) => {
  try {
    const yamlStr = normalizeWorkflowYamlInput((req.body as { yaml?: unknown }).yaml);
    if (!yamlStr.trim()) {
      res.status(400).json({ error: "yaml field required" });
      return;
    }
    res.status(201).json(await startRun(parseWorkflowString(yamlStr)));
  } catch (err) { res.status(400).json({ error: String(err) }); }
});

router.get("/runs", (_req, res) => res.json(listRuns()));

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
    const { amountUsd } = req.body as { amountUsd?: number };
    if (typeof amountUsd !== "number" || amountUsd <= 0) {
      res.status(400).json({ error: "amountUsd (positive number) required" });
      return;
    }
    topUpJobBudget(req.params.runId, req.params.jobId, amountUsd);
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
