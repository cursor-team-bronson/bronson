import fs from "fs";
import yaml from "js-yaml";
import { WorkflowConfig, WorkflowConfigSchema } from "@bronson/types";

export function parseWorkflowFile(filePath: string): WorkflowConfig {
  const raw = fs.readFileSync(filePath, "utf-8");
  return parseWorkflowString(raw);
}

export function parseWorkflowString(content: string): WorkflowConfig {
  const parsed = yaml.load(content);
  const result = WorkflowConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid workflow YAML: ${result.error.message}`);
  }
  return result.data;
}
