import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function orchestratorBase(): string {
  return (process.env.ORCHESTRATOR_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "");
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

  let upstream: Response;
  try {
    upstream = await fetch(target, { method: req.method, headers, body });
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
