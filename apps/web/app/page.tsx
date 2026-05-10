import type { Metadata } from "next";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Bronson POC",
  description: "Monorepo smoke test — web + orchestrator",
};

async function getOrchestratorHealth(base: string): Promise<{ ok?: boolean; error?: string }> {
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/health`, { cache: "no-store" });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return await res.json();
  } catch (e) {
    return { error: String(e) };
  }
}

export default async function Home() {
  const orchUrl =
    process.env.NEXT_PUBLIC_ORCHESTRATOR_URL ?? "http://127.0.0.1:3001";
  const health = await getOrchestratorHealth(orchUrl);

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">Bronson monorepo POC</h1>
      <p className="text-zinc-600 dark:text-zinc-400">
        Next.js on port 3000; Express orchestrator on 3001. Shared types live in{" "}
        <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-sm dark:bg-zinc-800">
          @bronson/types
        </code>
        .
      </p>
      <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="mb-2 font-medium">Orchestrator health</h2>
        <p className="font-mono text-sm text-zinc-700 dark:text-zinc-300">
          GET {orchUrl}/health
        </p>
        <pre className="mt-2 overflow-x-auto rounded bg-zinc-50 p-3 text-sm dark:bg-zinc-950">
          {JSON.stringify(health, null, 2)}
        </pre>
      </section>
      <section className="text-sm text-zinc-600 dark:text-zinc-400">
        <p className="font-medium text-zinc-900 dark:text-zinc-100">Thin proxy</p>
        <p className="mt-1">
          Same-origin API:{" "}
          <code className="rounded bg-zinc-100 px-1 font-mono dark:bg-zinc-800">
            /api/runs
          </code>{" "}
          forwards to the orchestrator via{" "}
          <code className="rounded bg-zinc-100 px-1 font-mono dark:bg-zinc-800">
            ORCHESTRATOR_URL
          </code>
          .
        </p>
      </section>
    </main>
  );
}
