import crypto from "crypto";

const BASE_URL = (process.env.ALLSCALE_BASE_URL ?? "").replace(/\/$/, "");
const API_KEY = process.env.ALLSCALE_API_KEY ?? "";
const API_SECRET = process.env.ALLSCALE_API_SECRET ?? "";

async function buildHeaders(
  method: string,
  path: string,
  query = "",
  body = "",
): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID();

  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  const canonical = [method, path, query, timestamp, nonce, bodyHash].join("\n");

  const signature = crypto
    .createHmac("sha256", API_SECRET)
    .update(canonical)
    .digest("base64");

  return {
    "X-API-Key": API_KEY,
    "X-Timestamp": timestamp,
    "X-Nonce": nonce,
    "X-Signature": `v1=${signature}`,
    "Content-Type": "application/json",
  };
}

export async function ping(): Promise<unknown> {
  const path = "/v1/test/ping";
  const headers = await buildHeaders("GET", path);
  const res = await fetch(`${BASE_URL}${path}`, { headers });
  return res.json();
}

export interface CheckoutIntent {
  checkout_url: string;
  intent_id: string;
  amount_usdc: string;
}

export async function createCheckoutIntent(params: {
  amountUsdc: number;
  orderId: string;
  description: string;
  redirectUrl?: string;
}): Promise<CheckoutIntent> {
  const path = "/v1/checkout_intents/";
  const amountCents = Math.round(params.amountUsdc * 100);

  const body = JSON.stringify({
    stable_coin: 2,
    amount_cents: amountCents,
    order_id: params.orderId,
    order_description: params.description,
    redirect_url:
      params.redirectUrl ??
      `${process.env.NEXT_PUBLIC_URL ?? "http://localhost:3000"}/runs/${params.orderId}`,
    extra: { source: "bronson_agent_pipeline" },
  });

  const headers = await buildHeaders("POST", path, "", body);
  const res = await fetch(`${BASE_URL}${path}`, { method: "POST", headers, body });
  const data = await res.json() as {
    code: number;
    error?: { message?: string };
    payload: { checkout_url: string; allscale_checkout_intent_id: string; amount_coins: string };
  };

  if (data.code !== 0) {
    throw new Error(`AllScale error: ${data.error?.message ?? JSON.stringify(data)}`);
  }

  return {
    checkout_url: data.payload.checkout_url,
    intent_id: data.payload.allscale_checkout_intent_id,
    amount_usdc: data.payload.amount_coins,
  };
}

export async function getCheckoutStatus(intentId: string): Promise<number> {
  const path = `/v1/checkout_intents/${intentId}/status`;
  const headers = await buildHeaders("GET", path);
  const res = await fetch(`${BASE_URL}${path}`, { headers });
  const data = await res.json() as { payload: number };
  return data.payload;
}

export const CHECKOUT_STATUS = {
  FAILED: -1,
  REJECTED: -2,
  UNDERPAID: -3,
  CANCELED: -4,
  TIMEOUT: -5,
  CREATED: 1,
  VIEWED: 2,
  ON_CHAIN: 10,
  CONFIRMED: 20,
} as const;

export function statusLabel(status: number): string {
  const labels: Record<string, string> = {
    "-1": "Failed",
    "-2": "Rejected",
    "-3": "Underpaid",
    "-4": "Canceled",
    "-5": "Timed out",
    "1": "Awaiting payment",
    "2": "Checkout opened",
    "10": "On-chain — confirming",
    "20": "Confirmed ✓",
  };
  return labels[status.toString()] ?? "Unknown";
}

export function assertAllScaleConfigured(): void {
  if (!process.env.ALLSCALE_API_KEY?.trim() || !process.env.ALLSCALE_API_SECRET?.trim()) {
    throw new Error("ALLSCALE_API_KEY and ALLSCALE_API_SECRET must be set");
  }
}
