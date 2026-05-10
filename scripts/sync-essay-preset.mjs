import fs from "fs";

/** Embeds `examples/essay-write-review-3cycles.yaml`. Requires `export const dreamStateWorkflowYaml` below (run sync-dream-preset first on new files). */

const wfPath = new URL("../apps/web/lib/workflow-yaml.ts", import.meta.url);
const yamlPath = new URL("../examples/essay-write-review-3cycles.yaml", import.meta.url);

const full = fs.readFileSync(wfPath, "utf8");
const yaml = fs.readFileSync(yamlPath, "utf8");

const essayHeader = "export const essayWorkflowYaml = String.raw`";
/** Essay block ends before `export const dreamStateWorkflowYaml` (dream preset must exist after essay). */
const dreamMarker = "\nexport const dreamStateWorkflowYaml";

const dreamIdx = full.indexOf(dreamMarker);
if (dreamIdx < 0) {
  throw new Error(
    "essay preset: missing export const dreamStateWorkflowYaml — run sync-dream-preset.mjs first.",
  );
}

const i = full.indexOf(essayHeader);
if (i < 0 || i >= dreamIdx) {
  throw new Error("essay preset: essayWorkflowYaml must appear before dreamStateWorkflowYaml.");
}

const essayPrefix = full.slice(0, dreamIdx);
const j = essayPrefix.lastIndexOf("`;");
if (j < i + essayHeader.length) {
  throw new Error(
    "essay preset: could not find closing `; for essay String.raw before dream-state export.",
  );
}

const out = full.slice(0, i + essayHeader.length) + yaml + full.slice(j);
fs.writeFileSync(wfPath, out);
