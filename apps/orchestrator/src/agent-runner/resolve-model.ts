import type { JobConfig } from "@bronson/types";

/**
 * Model id is provider-specific (CLōD and others). Resolve order:
 * 1. Job YAML `model`
 * 2. `DEFAULT_AGENT_MODEL`
 * 3. `CLOD_DEFAULT_MODEL` (alias)
 */
export function resolveAgentModel(jobConfig: JobConfig): string {
  const fromYaml = jobConfig.model?.trim();
  if (fromYaml) return fromYaml;
  const fromEnv =
    process.env.DEFAULT_AGENT_MODEL?.trim() ||
    process.env.CLOD_DEFAULT_MODEL?.trim();
  if (fromEnv) return fromEnv;
  throw new Error(
    'Set `model` on the job in YAML (exact CLōD catalog id, e.g. "DeepSeek V3.2"), or set DEFAULT_AGENT_MODEL or CLOD_DEFAULT_MODEL on the orchestrator.',
  );
}
