import fs from "fs";

const wfPath = new URL("../apps/web/lib/workflow-yaml.ts", import.meta.url);
const yamlPath = new URL("../examples/essay-write-review-3cycles.yaml", import.meta.url);

const full = fs.readFileSync(wfPath, "utf8");
const start = "export const essayWorkflowYaml = String.raw`";
const i = full.indexOf(start);
const j = full.search(/`;\s*\r?\n\s*\r?\nexport const yamlHelpExample/);
if (i < 0 || j < 0) throw new Error("markers not found");
const yaml = fs.readFileSync(yamlPath, "utf8");
const out = full.slice(0, i + start.length) + yaml + full.slice(j);
fs.writeFileSync(wfPath, out);
