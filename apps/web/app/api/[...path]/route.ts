import type { NextRequest } from "next/server";
import { Agent } from "undici";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Undici defaults ~300s body read — long essay runs kill SSE; disable timeouts for run event streams. */
const sseUpstreamAgent = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
  keepAliveTimeout: 600_000,
  keepAliveMaxTimeout: 600_000,
});

function orchestratorBase(): string {
  return (process.env.ORCHESTRATOR_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "");
}

/** Only the orchestrator run event stream — avoid disabling timeouts for unrelated .../events routes. */
function isRunEventsSse(req: NextRequest, pathSegments: string[]): boolean {
  return (
    req.method === "GET" &&
    pathSegments.length === 3 &&
    pathSegments[0] === "runs" &&
    pathSegments[2] === "events"
  );
}

async function proxy(req: NextRequest, pathSegments: string[]): Promise<Response> {
  const suffix = pathSegments.length ? pathSegments.join("/") : "";
  const base = orchestratorBase();
  const target = new URL(`${base}/api/${suffix}`);
  target.search = req.nextUrl.search;

  const headers = new Headers(req.headers);
  headers.delete("host");

  let body: BodyInit | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    body = await req.arrayBuffer();
  }

  const sse = isRunEventsSse(req, pathSegments);
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body,
      ...(sse ? { dispatcher: sseUpstreamAgent } : {}),
    });
  } catch (err) {
    const detail =
      err instanceof Error
        ? [err.message, err.cause instanceof Error ? err.cause.message : undefined]
            .filter(Boolean)
            .join(" — ")
        : String(err);
    return Response.json(
      {
        error: `Orchestrator unreachable at ${base} (${detail}). If the orchestrator printed a different port (e.g. after EADDRINUSE), set ORCHESTRATOR_URL in apps/web/.env.local to match.`,
      },
      { status: 502 },
    );
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}

type RouteCtx = { params: Promise<{ path?: string[] }> };

export async function GET(req: NextRequest, ctx: RouteCtx) {
  const { path = [] } = await ctx.params;
  return proxy(req, path);
}

export async function POST(req: NextRequest, ctx: RouteCtx) {
  const { path = [] } = await ctx.params;
  return proxy(req, path);
}

export async function PUT(req: NextRequest, ctx: RouteCtx) {
  const { path = [] } = await ctx.params;
  return proxy(req, path);
}

export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  const { path = [] } = await ctx.params;
  return proxy(req, path);
}

export async function DELETE(req: NextRequest, ctx: RouteCtx) {
  const { path = [] } = await ctx.params;
  return proxy(req, path);
}
