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
  const secret = process.env.ALLSCALE_API_SECRET;
  if (!secret) {
    console.error("AllScale webhook: ALLSCALE_API_SECRET is not set — rejecting all webhooks");
    return new Response("Webhook handler not configured", { status: 503 });
  }

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
      .createHmac("sha256", secret)
      .update(canonical)
      .digest("base64");

  const sigBuf = Buffer.from(sigHeader);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return new Response("Bad signature", { status: 401 });
  }

  const payload = JSON.parse(rawBody) as {
    order_id?: string;
    coin_symbol?: string;
    amount_coins?: string;
    tx_hash?: string;
    payment_status?: number;
    allscale_checkout_intent_id?: string;
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

  // order_id format: "<runId>::<jobId>::<timestamp>" (set in budget-tracker.ts)
  // Uses :: as separator so UUIDs and hyphenated jobIds parse correctly.
  const sep1 = orderId.indexOf("::");
  const sep2 = orderId.lastIndexOf("::");
  if (sep1 === -1 || sep1 === sep2) {
    console.error(`AllScale webhook: cannot parse order_id "${orderId}"`);
    return new Response("OK", { status: 200 });
  }
  const runId = orderId.slice(0, sep1);
  const jobId = orderId.slice(sep1 + 2, sep2);

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (process.env.INTERNAL_API_SECRET) {
      headers["X-Internal-Secret"] = process.env.INTERNAL_API_SECRET;
    }
    const res = await fetch(`${ORCHESTRATOR}/api/runs/${runId}/jobs/${jobId}/fund`, {
      method: "POST",
      headers,
      body: JSON.stringify({ amountUsd, intentId: payload.allscale_checkout_intent_id }),
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
