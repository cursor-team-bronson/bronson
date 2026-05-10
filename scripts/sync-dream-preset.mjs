import fs from "fs";

/**
 * Embeds `examples/dream-state.yaml` into `dreamStateWorkflowYaml` (before `yamlHelpExample`).
 * File order: starterYaml → essayWorkflowYaml → dreamStateWorkflowYaml → yamlHelpExample.
 * On a fresh `workflow-yaml.ts`, run sync-dream-preset first so `dreamStateWorkflowYaml` exists, then sync-essay-preset.
 */

const wfPath = new URL("../apps/web/lib/workflow-yaml.ts", import.meta.url);
const yamlPath = new URL("../examples/dream-state.yaml", import.meta.url);

const full = fs.readFileSync(wfPath, "utf8");
const start = "export const dreamStateWorkflowYaml = String.raw`";
const i = full.indexOf(start);
const j = full.search(/`;\s*\r?\n\s*\r?\nexport const yamlHelpExample/);
if (i < 0 || j < 0) throw new Error("dream preset markers not found in workflow-yaml.ts");
const yaml = fs.readFileSync(yamlPath, "utf8");
const out = full.slice(0, i + start.length) + yaml + full.slice(j);
fs.writeFileSync(wfPath, out);
