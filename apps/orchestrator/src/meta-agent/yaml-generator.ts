import fs from "fs";
import path from "path";
import OpenAI from "openai";
import { parseWorkflowString } from "../parser/yaml-parser.js";

const clod = new OpenAI({
  baseURL: process.env.CLOD_BASE_URL ?? "https://api.clod.io/v1",
  apiKey: process.env.CLOD_API_KEY ?? "",
});

function loadSkillsCatalog(): string {
  const cwd = process.cwd();
  const candidates = [
    path.resolve(cwd, "SKILLS.md"),
    path.resolve(cwd, "../../SKILLS.md"),
    path.resolve(cwd, "apps/orchestrator/SKILLS.md"),
  ];

  // __dirname is always available in CJS (compiled tsc output) and patched by
  // tsx in dev. Only use it if it's actually defined — avoids a ReferenceError
  // in pure-ESM runtimes that skip the shim.
  try {
    if (typeof __dirname === "string") {
      candidates.push(
        path.resolve(__dirname, "../../../../SKILLS.md"),
        path.resolve(__dirname, "../../SKILLS.md"),
      );
    }
  } catch { /* __dirname undefined — skip */ }

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, "utf-8");
    } catch { /* skip inaccessible paths */ }
  }
  return "No SKILLS.md found — generate a reasonable workflow based on the description.";
}

const SYSTEM_PROMPT = `You are a workflow YAML generator for the Bronson agentic orchestration platform.
Given a plain-English description of a task, you produce a valid Bronson workflow YAML.

Rules:
- Output ONLY the raw YAML — no markdown fences, no explanation, no preamble
- Use snake_case job IDs
- Pick models from the catalog (deepseek-v3 for cheap tasks, gpt-4o or claude-3-5-sonnet for reasoning)
- Add gate: human on any job that is destructive, financial, or irreversible
- Add budget_usd on jobs that may be expensive (e.g. heavy LLM chains, financial operations)
- Fan-out independent research/analysis jobs in parallel (same depends_on parent, no dependency between siblings)
- Keep prompts concise but specific — the agent needs clear instructions
- Validate your output mentally: every depends_on entry must reference an existing job ID`;

export interface GenerateWorkflowResult {
  yaml: string;
  validated: boolean;
  validationError?: string;
}

export async function generateWorkflow(description: string): Promise<GenerateWorkflowResult> {
  const skillsCatalog = loadSkillsCatalog();

  const userMessage = `## Bronson Skills Catalog\n\n${skillsCatalog}\n\n---\n\n## Task Description\n\n${description}\n\nGenerate the workflow YAML now.`;

  const response = await clod.chat.completions.create({
    model: process.env.META_AGENT_MODEL ?? "gpt-4o",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
    temperature: 0.2,
  });

  const raw = response.choices[0]?.message?.content?.trim() ?? "";
  // Strip accidental markdown fences if the model added them
  const yaml = raw.replace(/^```(?:yaml)?\n?/i, "").replace(/\n?```$/i, "").trim();

  // Validate the generated YAML against our schema
  let validated = false;
  let validationError: string | undefined;
  try {
    parseWorkflowString(yaml);
    validated = true;
  } catch (err) {
    validationError = String(err);
  }

  return { yaml, validated, validationError };
}
