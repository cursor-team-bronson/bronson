import crypto from "crypto";

export const runtime = "nodejs";

const ORCHESTRATOR = (process.env.ORCHESTRATOR_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "");
const CONFIRMED = 20;

/**
 * AllScale webhook — fires when a USDC payment is confirmed on-chain.
 *
 * Expected headers (from AllScale docs):
 *   X-Webhook-Id, X-Webhook-Timestamp, X-Webhook-Nonce, X-Webhook-Signature
 *
 * Body payload shape (relevant fields):
 *   { order_id, coin_symbol, amount_coins, tx_hash, payment_status }
 *
 * We verify the signature, then forward a fund signal to the orchestrator
 * so the halted job can resume.
 */
export async function POST(req: Request): Promise<Response> {
  const rawBody = await req.text();

  const webhookId = req.headers.get("X-Webhook-Id") ?? "";
  const timestamp = req.headers.get("X-Webhook-Timestamp") ?? "";
  const nonce = req.headers.get("X-Webhook-Nonce") ?? "";
  const sigHeader = req.headers.get("X-Webhook-Signature") ?? "";

  // Reject stale webhooks (>5 min clock drift)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 300) {
    return new Response("Timestamp expired", { status: 401 });
  }

  // Verify HMAC signature
  const bodyHash = crypto.createHash("sha256").update(Buffer.from(rawBody)).digest("hex");
  const canonical = [
    "allscale:webhook:v1",
    "POST",
    "/api/webhooks/allscale",
    "",
    webhookId,
    timestamp,
    nonce,
    bodyHash,
  ].join("\n");

  const expected =
    "v1=" +
    crypto
      .createHmac("sha256", process.env.ALLSCALE_API_SECRET ?? "")
      .update(canonical)
      .digest("base64");

  if (sigHeader !== expected) {
    return new Response("Bad signature", { status: 401 });
  }

  const payload = JSON.parse(rawBody) as {
    order_id?: string;
    coin_symbol?: string;
    amount_coins?: string;
    tx_hash?: string;
    payment_status?: number;
  };

  // Only act on confirmed USDC payments
  if (payload.payment_status !== CONFIRMED || payload.coin_symbol !== "USDC") {
    return new Response("OK", { status: 200 });
  }

  const orderId = payload.order_id ?? "";
  const amountUsd = parseFloat(payload.amount_coins ?? "0");

  if (!orderId || amountUsd <= 0) {
    return new Response("OK", { status: 200 });
  }

  // order_id format: "<runId>-<jobId>-<timestamp>" (set in budget-tracker.ts)
  // Extract runId and jobId — everything before the last "-<timestamp>" suffix
  const parts = orderId.split("-");
  if (parts.length < 3) {
    console.error(`AllScale webhook: cannot parse order_id "${orderId}"`);
    return new Response("OK", { status: 200 });
  }

  // Last segment is the epoch ms timestamp, second-to-last is jobId, everything before is runId
  const jobId = parts[parts.length - 2];
  const runId = parts.slice(0, parts.length - 2).join("-");

  try {
    const res = await fetch(`${ORCHESTRATOR}/api/runs/${runId}/jobs/${jobId}/fund`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountUsd }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`AllScale webhook: orchestrator fund call failed: ${res.status} ${body}`);
    } else {
      console.log(`AllScale webhook: funded job ${jobId} in run ${runId} with $${amountUsd} USDC`);
    }
  } catch (err) {
    console.error(`AllScale webhook: orchestrator unreachable: ${err}`);
  }

  return new Response("OK", { status: 200 });
}
