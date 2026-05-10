import fs from "fs";
import yaml from "js-yaml";
import { WorkflowConfig, WorkflowConfigSchema } from "@bronson/types";

export function parseWorkflowFile(filePath: string): WorkflowConfig {
  const raw = fs.readFileSync(filePath, "utf-8");
  return parseWorkflowString(raw);
}

/**
 * POST /api/runs sometimes sends `yaml` as a JSON array of lines (e.g. PowerShell
 * `Get-Content` without `-Raw`). Normalize to a single string before YAML parse.
 */
export function normalizeWorkflowYamlInput(raw: unknown): string {
  if (raw === undefined || raw === null) {
    throw new Error("yaml field is required");
  }
  if (typeof raw === "string") {
    let s = raw.replace(/^\uFEFF/, "").trim();
    // Some clients send a JSON-serialized array of lines as one string.
    if (s.startsWith("[") && s.endsWith("]")) {
      try {
        const j = JSON.parse(s) as unknown;
        if (Array.isArray(j) && j.every(x => typeof x === "string")) {
          return j.join("\n");
        }
      } catch {
        /* treat as YAML text */
      }
    }
    return raw.replace(/^\uFEFF/, "");
  }
  if (Array.isArray(raw)) {
    return raw.map(line => String(line)).join("\n");
  }
  return String(raw);
}

export function parseWorkflowString(content: string): WorkflowConfig {
  let parsed: unknown = yaml.load(content);
  // js-yaml may parse JSON-compat "[ ... ]" at root as an array of lines; join and re-parse.
  if (Array.isArray(parsed) && parsed.every(x => typeof x === "string")) {
    parsed = yaml.load(parsed.join("\n"));
  }
  const result = WorkflowConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid workflow YAML: ${result.error.message}`);
  }
  return result.data;
}
