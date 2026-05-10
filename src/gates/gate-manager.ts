import { GateDecision, GateRequest } from "../types/index.js";

interface PendingGate {
  request: GateRequest;
  resolve: (d: GateDecision) => void;
  reject: (e: Error) => void;
}

class GateManager {
  private pending = new Map<string, PendingGate>();

  private key(runId: string, jobId: string) { return `${runId}::${jobId}`; }

  waitForApproval(request: GateRequest): Promise<GateDecision> {
    return new Promise((resolve, reject) =>
      this.pending.set(this.key(request.runId, request.jobId), { request, resolve, reject }));
  }

  approve(runId: string, jobId: string, editedOutput?: string) {
    const g = this.pending.get(this.key(runId, jobId));
    if (!g) throw new Error(`No pending gate for ${runId}::${jobId}`);
    this.pending.delete(this.key(runId, jobId));
    g.resolve({ approved: true, editedOutput });
  }

  reject(runId: string, jobId: string, reason?: string) {
    const g = this.pending.get(this.key(runId, jobId));
    if (!g) throw new Error(`No pending gate for ${runId}::${jobId}`);
    this.pending.delete(this.key(runId, jobId));
    g.resolve({ approved: false, reason });
  }

  listPending(runId: string) {
    return [...this.pending.values()].filter(g => g.request.runId === runId).map(g => g.request);
  }
}

export const gateManager = new GateManager();
