import yaml from "js-yaml";

export const WORKFLOW_YAML_STORAGE_KEY = "bronson.workflowYaml.v1";

/** Browser-local preferred cadence for external cron / CI runners (POST /api/runs). */
export const BRONSON_WORKFLOW_SCHEDULE_KEY = "bronson.workflowSchedule.v1";

/** Last orchestrator run id — used to refetch job outputs after reload when persistence is on. */
export const LAST_MODEL_RUN_ID_STORAGE_KEY = "bronson.modelRunner.lastRunId.v1";

export function readStoredWorkflowYaml(): string {
  try {
    const s = localStorage.getItem(WORKFLOW_YAML_STORAGE_KEY);
    if (s?.trim()) return s;
  } catch {
    /* ignore */
  }
  return starterYaml;
}

export const starterYaml = `name: fan-out-agents-workflow
steps:
  - id: plan-task
    type: llm
    prompt: Decompose the request into parallel workstreams.
  - id: spawn-agent-swarm
    type: fan_out
    depends_on: plan-task
    # One orchestrator step fans out to multiple specialist agents below.
  - id: agent-research
    type: agent
    role: research
    depends_on: spawn-agent-swarm
    ai_gate_after: spawn-agent-swarm
  - id: agent-implement
    type: agent
    role: implement
    depends_on: spawn-agent-swarm
    ai_gate_after: spawn-agent-swarm
  - id: agent-qa
    type: agent
    role: qa
    depends_on: spawn-agent-swarm
    ai_gate_after: spawn-agent-swarm
  - id: merge-agent-outputs
    type: llm
    depends_on:
      - agent-research
      - agent-implement
      - agent-qa
    prompt: Merge the three agent traces into one coherent deliverable.
  - id: human-release
    type: human_gate
    depends_on: merge-agent-outputs
    human_gate_after: merge-agent-outputs
`;

/**
 * Mirrors `examples/essay-write-review-3cycles.yaml` — run `node scripts/sync-essay-preset.mjs` after edits there (POC).
 * Uses String.raw so Windows paths stay single-backslash in the YAML text (avoid backticks inside the YAML).
 */
export const essayWorkflowYaml = String.raw`# Essay writer / reviewer — three cycles (six sequential jobs).
#
# Each job sets on_failure: retry so the DAG continues the wave (dependents still run and see upstream
# failure context). That is separate from max_retries (default 0): add max_retries: N only if you want
# the same job re-invoked after failure.
#
# Prerequisites (apps/orchestrator/.env):
#   ALLOW_SHELL_TOOL=true
#     (enables workspace_write by default — see ALLOW_WORKSPACE_WRITE below)
#   TOOL_SHELL_CWD=<repo>/examples/essay-workspace
#     (workspace root for workspace_write; writers use essay-draft.txt relative to this cwd)
#
# Optional:
#   ALLOW_WORKSPACE_WRITE=false   — disable direct file writes while keeping shell (default: same as ALLOW_SHELL_TOOL)
#   TOOL_WORKSPACE_WRITE_MAX_BYTES=5000000
#
# Writers use tools: [workspace_write] so file contents are passed as tool JSON (no shell quoting).
# Reviewers only see prior jobs' LLM outputs (context), not the disk file automatically.
#
# Models below are per-job for multi-model testing; strings must match your CLōD project catalog exactly.
# (DeepSeek V3.2 → write 1, Gemma 3N → review 1, DeepSeek V3.2 → write 2, Llama 3.3 Turbo → review 2,
# DeepSeek V4 Pro → write 3, Meta Llama 3.3 70B → final review.)
#
# Change TOOL_SHELL_CWD if you use a different workspace; keep paths relative to that cwd.

name: essay-write-review-3cycles

jobs:
  write_cycle_1:
    model: DeepSeek V3.2
    prompt: |
      You are the WRITER (cycle 1 of 3).

      Topic: "Why short feedback loops matter when building software."

      Rules:
      - Write a first draft of roughly 250–400 words, clear prose, no markdown headings required.
      - In your assistant message, include the full essay between these lines exactly:
        ###ESSAY_START###
        ...full essay text...
        ###ESSAY_END###
      - Call workspace_write exactly once:
        - path: essay-draft.txt
        - content: the essay body ONLY (characters between ###ESSAY_START### and ###ESSAY_END###, excluding the marker lines themselves).
      - Then reply with one assistant message containing only the word: done
      - Do not use the shell tool unless workspace_write fails (you should not need it).
    tools: [workspace_write]
    tool_rounds_max: 18
    gate: auto
    on_failure: retry
    context_budget: 12000

  review_cycle_1:
    model: Gemma 3N E4B IT
    prompt: |
      You are the REVIEWER (after cycle 1).

      Read the section ###ESSAY_START### ... ###ESSAY_END### from the writer output in context.

      If the upstream writer FAILED (see "### Upstream ... failed") or there is no ###ESSAY_START###
      block, respond only: "No essay draft to review." plus one line quoting the failure reason.
      Do not invent an essay or unrelated topic.

      Otherwise respond with:
      1) Summary (2–3 sentences)
      2) Strengths (bullet list)
      3) Issues / gaps (bullet list)
      4) Concrete edits the writer should apply in the next draft (numbered list)

      Do not use tools.
    depends_on: [write_cycle_1]
    gate: auto
    on_failure: retry
    # Gemma 3N has a 32k context window — keep upstream injection moderate.
    context_budget: 8000

  write_cycle_2:
    model: DeepSeek V3.2
    prompt: |
      You are the WRITER (cycle 2 of 3).

      Topic (same): "Why short feedback loops matter when building software."

      Use the REVIEWER feedback in context from review_cycle_1. Revise the essay: address their
      concrete edits while keeping a coherent voice.

      Rules:
      - Output the full revised essay between ###ESSAY_START### and ###ESSAY_END###.
      - workspace_write once: path essay-draft.txt, content = essay body only (between markers, markers excluded).
      - Then reply with only: done
    tools: [workspace_write]
    tool_rounds_max: 18
    depends_on: [review_cycle_1]
    gate: auto
    on_failure: retry
    context_budget: 12000

  review_cycle_2:
    model: Llama 3.3 70B Instruct Turbo
    prompt: |
      You are the REVIEWER (after cycle 2).

      Read the latest essay between ###ESSAY_START### and ###ESSAY_END### in context.

      If the upstream writer FAILED or there is no ###ESSAY_START### block, respond only:
      "No essay draft to review." plus one line quoting the failure reason. Do not invent content.

      Otherwise same four sections as before (summary, strengths, issues, concrete edits for next draft).
      Be stricter about clarity and structure if earlier issues remain.

      Do not use tools.
    depends_on: [write_cycle_2]
    gate: auto
    on_failure: retry
    context_budget: 12000

  write_cycle_3:
    model: DeepSeek V4 Pro
    prompt: |
      You are the WRITER (cycle 3 of 3 — final revision).

      Topic (same). Apply review_cycle_2 feedback from context.

      Rules:
      - Final essay between ###ESSAY_START### and ###ESSAY_END###.
      - workspace_write once: path essay-draft.txt, content = essay body only.
      - Then reply with only: done
    tools: [workspace_write]
    tool_rounds_max: 18
    depends_on: [review_cycle_2]
    gate: auto
    on_failure: retry
    context_budget: 12000

  review_cycle_3:
    model: Meta Llama 3.3 70B Instruct
    prompt: |
      You are the REVIEWER (final pass).

      Read the final essay from context (###ESSAY_START### ... ###ESSAY_END###).

      If the upstream writer FAILED or there is no essay in context, say so in one short paragraph — do not invent an essay.

      Otherwise give a brief acceptance-style summary: ready or not, top remaining nitpicks (if any),
      and one sentence overall verdict.

      Do not use tools.
    depends_on: [write_cycle_3]
    gate: auto
    on_failure: retry
    context_budget: 12000
`;

/**
 * Mirrors `examples/dream-state.yaml` — run `node scripts/sync-dream-preset.mjs` after edits there.
 */
export const dreamStateWorkflowYaml = String.raw`# dream-state — async memory consolidation & self-improvement (no human gate)
#
# Runs after you finish working: scans memory + git + docs, reconciles into one canonical
# memory doc, drafts NEW Bronson workflows the repo could run later to keep improving —
# all non-destructive (never overwrites CLAUDE.md / source memory by default).
#
# Ontology:
#   Memory store   → CLAUDE.md / .cursor/memory.md (read-only input for this DAG)
#   Session signal → git log / diffs / commits
#   Dream job      → this DAG (async, autonomous)
#   Output store   → .dream/memory-output.md + .dream/proposed/*.yaml (promote manually)
#
# Prerequisites (apps/orchestrator/.env):
#   ALLOW_SHELL_TOOL=true
#   TOOL_SHELL_CWD=<absolute path to the Bronson REPOSITORY ROOT>
#     (the folder that contains README.md, apps/, packages/ — NOT examples/essay-workspace alone).
#   TOOL_SHELL_ALLOWLIST_REGEX=.*
#   emit_artifacts uses workspace_write (requires ALLOW_WORKSPACE_WRITE unset or true when shell is on).
#
# Shell runs with the host default shell (often cmd.exe on Windows). If Unix utilities fail, use
# PowerShell one-liners (see scan prompts). Reload the web “dream-state” preset after edits; stale YAML
# in browser storage can still define human_review — this file does not.
# Models must match your CLōD catalog ids exactly. Scan/emit jobs use DeepSeek V3.2 (same tier as analyze);
# if that alias is unavailable, change each model: field or set DEFAULT_AGENT_MODEL and omit model per job.
#
# on_failure: retry = continue the DAG (dependents receive failure context); max_retries = re-run this job.

name: dream-state

jobs:
  # ─── Wave 0: orient (parallel) ─────────────────────────────────────────────

  scan_memory:
    prompt: |
      You are reading the existing project memory store for this software repository (e.g. Bronson).

      If the shell cwd appears to be only examples/essay-workspace (or any single example folder), output one line:
      WARNING_WRONG_CWD — set TOOL_SHELL_CWD to the repo root (parent of apps/), then still try reads below.

      Use the shell tool. Try POSIX-style reads first; if the host is Windows and commands fail,
      use PowerShell equivalents:

        cat CLAUDE.md  OR  powershell -NoProfile -Command "Get-Content CLAUDE.md -Raw -ErrorAction SilentlyContinue"
        cat .cursor/memory.md  OR  powershell -NoProfile -Command "Get-Content .cursor/memory.md -Raw -ErrorAction SilentlyContinue"
        cat .ai/memory.md  OR  powershell -NoProfile -Command "Get-Content .ai/memory.md -Raw -ErrorAction SilentlyContinue"

      If none exist, list markdown under the repo (POSIX or PowerShell):

        find . -maxdepth 3 -name "*.md" ... | head -20
        OR
        powershell -NoProfile -Command "Get-ChildItem -Recurse -Filter *.md -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch 'node_modules|\\.git' } | Select-Object -First 25 -ExpandProperty FullName"

      Collect everything you find and output it verbatim, labeled by filename.
      If absolutely nothing exists, output exactly: NO_MEMORY_FOUND
    tools: [shell]
    tool_rounds_max: 24
    gate: auto
    on_failure: retry
    context_budget: 6000
    model: DeepSeek V3.2

  scan_git_history:
    prompt: |
      You are mining recent git history for project insights.

      Use the shell tool to run these three commands and collect their output:

        git log --oneline --no-merges -50
        git diff HEAD~10..HEAD --stat
        git log --format="%s%n%b" --no-merges -20

      Output the raw results verbatim, clearly labeled per command.
      If git is unavailable or the repo has fewer commits than requested,
      output whatever is returned and note the limitation.
      If git is entirely absent, output: NO_GIT_HISTORY
    tools: [shell]
    tool_rounds_max: 16
    gate: auto
    on_failure: retry
    context_budget: 6000
    model: DeepSeek V3.2

  scan_project_docs:
    prompt: |
      You are collecting project documentation and directory context for this repo.

      If listing shows only essay-workspace or a narrow examples subtree, output WARNING_WRONG_CWD first —
      TOOL_SHELL_CWD should be the monorepo root containing README.md and apps/.

      Use the shell tool. Prefer POSIX; on Windows if ls/find/cat fail, use PowerShell:

        ls -la   OR   powershell -NoProfile -Command "Get-ChildItem -Force"
        find . -maxdepth 3 -name "*.md" ...   OR   powershell -NoProfile -Command "Get-ChildItem -Recurse -Depth 3 -Filter *.md | Where-Object { $_.FullName -notmatch 'node_modules|\\.git' } | Select-Object -ExpandProperty FullName"
        cat README.md   OR   powershell -NoProfile -Command "Get-Content README.md -Raw -ErrorAction SilentlyContinue"
        If docs/ exists, read *.md there similarly.

      Output all results verbatim, labeled by command.
      Skip any file that does not exist without erroring.
    tools: [shell]
    tool_rounds_max: 24
    gate: auto
    on_failure: retry
    context_budget: 6000
    model: DeepSeek V3.2

  # ─── Wave 1: analyze (parallel) ───────────────────────────────────────────

  analyze_code_structure:
    prompt: |
      You are analyzing the CODE STRUCTURE knowledge plane for Bronson memory consolidation.

      The workflow filename "dream-state" is an internal codename — describe THIS repository only.

      Using the git history and project docs injected as context, extract:
        1. Active modules, packages, and their responsibilities
        2. Key data flows and entry points identified from commit messages
        3. Recent structural changes: renames, additions, deletions
        4. Patterns or architectural conventions visible from the git log

      Format your output as a concise structured list of facts.
      Tag each fact [HIGH] or [LOW]. Omit speculation. If context is missing or only shell errors, say so [LOW] — do not invent modules.
      Target ≤ 400 words.
    depends_on: [scan_git_history, scan_project_docs]
    gate: auto
    on_failure: retry
    context_budget: 8000
    model: DeepSeek V3.2

  analyze_product_intent:
    prompt: |
      You are analyzing the PRODUCT INTENT knowledge plane for this software repository.

      CRITICAL: Ignore the workflow codename "dream-state". Do NOT describe sleep apps, dream journals,
      therapy, or human dream recall unless README/memory files explicitly say that. Bronson is an
      agent/workflow orchestrator unless sources say otherwise.

      If scan_memory or docs failed (JOB FAILED, HTTP errors, empty context, only shell errors), respond
      with a short "Insufficient evidence" section listing unknowns [LOW] — do NOT fabricate product scope.

      Using the existing memory store and project docs injected as context, extract:
        1. What the project is (one sentence)
        2. Who it is for and the core use case
        3. Non-negotiable constraints or design principles
        4. Explicit goals mentioned in README or memory files
        5. Known limitations or anti-goals explicitly stated

      Format your output as a concise structured list of facts.
      Tag each fact [HIGH] or [LOW]. Target ≤ 400 words.
    depends_on: [scan_memory, scan_project_docs]
    gate: auto
    on_failure: retry
    context_budget: 8000
    model: DeepSeek V3.2

  analyze_conventions:
    prompt: |
      You are analyzing the OPERATIONAL CONVENTIONS knowledge plane.

      Only cite conventions evidenced in context (memory, git, or scans). If scan_memory failed, rely on
      git and prior completed outputs only; label gaps [LOW].

      Using the existing memory and git history injected as context, extract:
        1. Coding conventions and style rules
        2. Test patterns and coverage expectations
        3. Build, run, and deployment instructions that work
        4. Frequently used tools, scripts, CLI commands
        5. Explicit "never do X" / "always do Y" rules

      Tag each fact [HIGH] or [LOW]. Flag contradictions with ⚠. Target ≤ 400 words.
    depends_on: [scan_memory, scan_git_history]
    gate: auto
    on_failure: retry
    context_budget: 8000
    model: DeepSeek V3.2

  # ─── Wave 2: consolidate ─────────────────────────────────────────────────

  consolidate:
    prompt: |
      You are the memory consolidation engine for the Bronson repository. Synthesize the three
      knowledge-plane analyses from context into ONE canonical Markdown memory document.

      The workflow name "dream-state" is NOT product scope — do not describe dream-tracking apps,
      journaling products, or therapy tools unless sources explicitly state them.

      Rules — apply in order:
        DEDUPLICATE  Same fact in multiple planes → keep once in the best section.
        RECONCILE    Contradictions → keep [HIGH]; note ⚠ previously stated: <old>.
        PRUNE        Drop uncorroborated [LOW] unless it matters for safety.
        SURFACE      Strong agreement across planes but missing from old memory → ✨ New.
        PRESERVE     Keep original [HIGH] unless contradicted by current evidence.

      Required sections:

        # Project Overview
        # Code Structure
        # Conventions & Tooling
        # Active Decisions & Open Questions
        # Changelog

      Changelog: what changed vs prior memory (added / removed / reconciled).

      Write for a developer cold-starting the repo. This run is fully automated — produce a
      publication-ready draft; the user may promote to CLAUDE.md later.
    depends_on: [analyze_code_structure, analyze_product_intent, analyze_conventions]
    gate: auto
    on_failure: retry
    context_budget: 12000
    model: DeepSeek V4 Pro

  # ─── Wave 3: propose next Bronson workflows (self-improve loop) ───────────

  draft_agent_workflows:
    prompt: |
      You design NEW Bronson orchestrator workflows so this project can keep improving itself.

      Bronson YAML shape (must be valid structure):
        name: <workflow_name>
        jobs:
          <job_id>:
            prompt: |
              ...
            depends_on: [...]
            gate: auto
            model: <exact CLōD model id>
            tools: [] or [shell] or [workspace_write] or both
            context_budget: <int>
            tool_rounds_max: <int>
            on_failure: retry

      From context you have: consolidated memory + analyses + scans.

      Produce exactly TWO workflow proposals tailored to THIS repo:

        1) memory_hygiene — periodic cleanup / dedupe of memory docs, sync skills
        2) capability_build — concrete automation (tests, orchestrator, docs)

      Output format (required — emit step parses these markers):

        <<<YAML_MEMORY_HYGIENE>>>
        name: memory_hygiene
        jobs:
          ...
        <<<END_YAML_MEMORY_HYGIENE>>>

        <<<YAML_CAPABILITY>>>
        name: capability_build
        jobs:
          ...
        <<<END_YAML_CAPABILITY>>>

      Before each block, 3–5 bullet rationale. Each YAML: snake_case job ids, gate: auto only,
      no human gates, non-destructive. Prefer shell or workspace_write per job. Models must be valid CLōD ids.

      No markdown fences around YAML — raw YAML only inside the markers.

      Your final assistant message MUST contain the <<<YAML_*>>> marker blocks as visible text (not tool-only).
      If upstream draft context is empty, still emit minimal placeholder YAML inside each marker explaining why.

      For capability_build, include YAML comments showing how automation could POST this workflow to the
      orchestrator (POST /api/runs with JSON body containing the workflow YAML) and mention the web UI
      schedule preference key bronson.workflowSchedule.v1 for runners that POST on a cadence.

      Do NOT end after one introductory sentence. The bulk of your reply MUST be the two marker blocks with
      real YAML bodies (at least name, jobs, and one job each). Prose before markers should be under 80 words.
    depends_on: [consolidate]
    gate: auto
    on_failure: retry
    max_retries: 2
    context_budget: 14000
    model: DeepSeek V4 Pro

  # ─── Wave 4: write artifacts to disk (still never touches source memory) ───

  emit_artifacts:
    prompt: |
      Use the workspace_write tool only (no shell). Each call: path = relative under TOOL_SHELL_CWD,
      content = full UTF-8 file body. Parent directories are created automatically.

      Context contains:
        - consolidate → canonical Markdown memory (full body)
        - draft_agent_workflows → text that may include <<<YAML_MEMORY_HYGIENE>>> … <<<END_YAML_MEMORY_HYGIENE>>>
          and <<<YAML_CAPABILITY>>> … <<<END_YAML_CAPABILITY>>>

      Never modify CLAUDE.md, .cursor/memory.md, or existing memory sources.

      Steps:
        1) workspace_write path .dream/memory-output.md — exact consolidate Markdown only.

        2) From draft_agent_workflows text, extract YAML between MEMORY_HYGIENE markers (if present).
           workspace_write path .dream/proposed/memory-hygiene.yaml

        3) Extract YAML between CAPABILITY markers; workspace_write path .dream/proposed/capability-build.yaml

        4) workspace_write path .dream/proposed/README.md (8–12 lines): artifacts, POST /api/runs,
           bronson.workflowSchedule.v1, promote from examples/.

      If markers are missing, workspace_write .dream/proposed/draft-raw.txt with full draft_agent_workflows text.

      End your final assistant message with exactly:
        DREAM COMPLETE — artifacts under .dream/
    depends_on: [consolidate, draft_agent_workflows]
    tools: [workspace_write]
    tool_rounds_max: 16
    gate: auto
    on_failure: retry
    context_budget: 16000
    model: DeepSeek V3.2
`;

export const yamlHelpExample = `name: parallel-agents
steps:
  - id: orchestrate
    type: fan_out
  - id: agent-a
    depends_on: orchestrate
    ai_gate_after: orchestrate
  - id: agent-b
    depends_on: orchestrate
    ai_gate_after: orchestrate
  - id: join
    depends_on: [agent-a, agent-b]`;

export type Step = {
  id: string;
  type?: string;
  prompt?: string;
  model?: string;
  tools?: string[];
  tool_rounds_max?: number;
  depends_on?: string[] | string;
  deps?: string[] | string;
  needs?: string[] | string;
  requires?: string[] | string;
  human_gate_after?: string[] | string;
  ai_gate_after?: string[] | string;
  gate?: string;
};

export type GraphResult = {
  nodes: string[];
  depsByNode: Map<string, string[]>;
  humanGateByNode: Map<string, string[]>;
  aiGateByNode: Map<string, string[]>;
  stepTypes: Map<string, string>;
  topoOrder: string[];
  cyclePath: string[] | null;
  parseError: string | null;
};

function asArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

function topoFromDeps(nodes: string[], depsByNode: Map<string, string[]>): { topoOrder: string[]; cyclePath: string[] | null } {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const topo: string[] = [];
  let cyclePath: string[] | null = null;

  const dfs = (node: string, path: string[]) => {
    if (cyclePath) return;
    if (visiting.has(node)) {
      const start = path.indexOf(node);
      cyclePath = start >= 0 ? [...path.slice(start), node] : [node, node];
      return;
    }
    if (visited.has(node)) return;

    visiting.add(node);
    const nextPath = [...path, node];
    for (const dep of depsByNode.get(node) ?? []) {
      dfs(dep, nextPath);
    }
    visiting.delete(node);
    visited.add(node);
    topo.push(node);
  };

  for (const node of nodes) dfs(node, []);

  return { topoOrder: cyclePath ? [] : topo, cyclePath };
}

export function parseDag(text: string): GraphResult {
  try {
    const parsed = yaml.load(text) as { name?: string; steps?: Step[]; jobs?: Record<string, unknown> } | undefined;

    /** Orchestrator-native workflows (`jobs:`) — same graph semantics as `steps:`. */
    if (parsed?.jobs && typeof parsed.jobs === "object" && !Array.isArray(parsed.jobs)) {
      const jobs = parsed.jobs as Record<
        string,
        { depends_on?: string[]; gate?: string; prompt?: unknown }
      >;
      const nodes = Object.keys(jobs).filter((id) => id.length > 0);
      const nodeSet = new Set(nodes);
      const depsByNode = new Map<string, string[]>();
      const stepTypes = new Map<string, string>();

      for (const id of nodes) {
        const raw = jobs[id]?.depends_on;
        const deps = Array.isArray(raw)
          ? raw.filter((d): d is string => typeof d === "string" && nodeSet.has(d))
          : [];
        depsByNode.set(id, Array.from(new Set(deps)));
        const g = jobs[id]?.gate;
        stepTypes.set(id, g === "human" ? "human_gate" : "llm");
      }

      const { topoOrder, cyclePath } = topoFromDeps(nodes, depsByNode);

      return {
        nodes,
        depsByNode,
        humanGateByNode: new Map(),
        aiGateByNode: new Map(),
        stepTypes,
        topoOrder,
        cyclePath,
        parseError: null,
      };
    }

    if (!parsed || !Array.isArray(parsed.steps)) {
      return {
        nodes: [],
        depsByNode: new Map(),
        humanGateByNode: new Map(),
        aiGateByNode: new Map(),
        stepTypes: new Map(),
        topoOrder: [],
        cyclePath: null,
        parseError: "Expected `steps:` (DAG editor) or `jobs:` (orchestrator / CLōD) in the YAML root.",
      };
    }

    const nodes = parsed.steps
      .map((step) => step.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);

    const stepTypes = new Map<string, string>();
    for (const step of parsed.steps) {
      if (step.id && typeof step.type === "string") stepTypes.set(step.id, step.type);
    }

    const nodeSet = new Set(nodes);
    const depsByNode = new Map<string, string[]>();
    const humanGateByNode = new Map<string, string[]>();
    const aiGateByNode = new Map<string, string[]>();
    for (const step of parsed.steps) {
      if (!step.id) continue;
      const deps = [
        ...asArray(step.depends_on),
        ...asArray(step.deps),
        ...asArray(step.needs),
        ...asArray(step.requires),
      ].filter((dep) => nodeSet.has(dep));
      depsByNode.set(step.id, Array.from(new Set(deps)));

      const humanGates = asArray(step.human_gate_after).filter((dep) => nodeSet.has(dep) && deps.includes(dep));
      const aiGates = asArray(step.ai_gate_after).filter((dep) => nodeSet.has(dep) && deps.includes(dep));
      if (humanGates.length > 0) humanGateByNode.set(step.id, Array.from(new Set(humanGates)));
      if (aiGates.length > 0) aiGateByNode.set(step.id, Array.from(new Set(aiGates)));
    }

    const { topoOrder, cyclePath } = topoFromDeps(nodes, depsByNode);

    return {
      nodes,
      depsByNode,
      humanGateByNode,
      aiGateByNode,
      stepTypes,
      topoOrder,
      cyclePath,
      parseError: null,
    };
  } catch (error) {
    return {
      nodes: [],
      depsByNode: new Map(),
      humanGateByNode: new Map(),
      aiGateByNode: new Map(),
      stepTypes: new Map(),
      topoOrder: [],
      cyclePath: null,
      parseError: error instanceof Error ? error.message : "Invalid YAML.",
    };
  }
}

function defaultStepPrompt(step: Step): string {
  const id = step.id;
  const t = step.type ?? "step";
  return `Complete step "${id}" (${t}). Reply with a short plain-text summary of what you did.`;
}

export type OrchestratorYamlResult =
  | { ok: true; yaml: string }
  | { ok: false; error: string };

/**
 * Produce YAML accepted by `POST /api/runs` (orchestrator `name` + `jobs`).
 * Passes through `jobs:` workflows; converts DAG-editor `steps:` to `jobs`.
 */
export function toOrchestratorWorkflowYaml(text: string): OrchestratorYamlResult {
  try {
    const parsed = yaml.load(text.replace(/^\uFEFF/, "")) as Record<string, unknown> | undefined;
    if (!parsed || typeof parsed !== "object") {
      return { ok: false, error: "Invalid YAML root." };
    }

    if ("jobs" in parsed && parsed.jobs && typeof parsed.jobs === "object" && !Array.isArray(parsed.jobs)) {
      const dump = yaml.dump(parsed, { lineWidth: -1, noRefs: true, quotingType: '"' });
      return { ok: true, yaml: dump };
    }

    const steps = parsed.steps;
    if (!Array.isArray(steps)) {
      return {
        ok: false,
        error: "Use `jobs:` (orchestrator) or `steps:` (DAG editor). See examples/hello-world-ticker.yaml.",
      };
    }

    const name = typeof parsed.name === "string" ? parsed.name : "workflow";

    const stepList = steps as Step[];
    const nodes = stepList.map((s) => s.id).filter((id): id is string => typeof id === "string" && id.length > 0);
    const nodeSet = new Set(nodes);

    const depsById = new Map<string, string[]>();
    for (const step of stepList) {
      if (!step.id) continue;
      const deps = [
        ...asArray(step.depends_on),
        ...asArray(step.deps),
        ...asArray(step.needs),
        ...asArray(step.requires),
      ].filter((dep) => nodeSet.has(dep));
      depsById.set(step.id, Array.from(new Set(deps)));
    }

    const jobs: Record<string, Record<string, unknown>> = {};

    for (const step of stepList) {
      if (!step.id) continue;
      const prompt =
        typeof step.prompt === "string" && step.prompt.trim()
          ? step.prompt
          : defaultStepPrompt(step);

      const gate =
        step.type === "human_gate" || step.gate === "human"
          ? "human"
          : "auto";

      const job: Record<string, unknown> = {
        prompt,
        depends_on: depsById.get(step.id) ?? [],
        gate,
      };

      if (typeof step.model === "string" && step.model.trim()) job.model = step.model.trim();
      if (Array.isArray(step.tools) && step.tools.length) job.tools = step.tools;
      if (typeof step.tool_rounds_max === "number") job.tool_rounds_max = step.tool_rounds_max;

      jobs[step.id] = job;
    }

    const dump = yaml.dump({ name, jobs }, { lineWidth: -1, noRefs: true, quotingType: '"' });
    return { ok: true, yaml: dump };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
