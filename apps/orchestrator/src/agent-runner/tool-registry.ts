import type OpenAI from "openai";
import { executeShellCommand, isShellToolEnabled } from "./shell-tool.js";

export type ToolExecutor = (args: Record<string, unknown>) => Promise<string>;

const shellDefinition: OpenAI.Chat.ChatCompletionTool = {
  type: "function",
  function: {
    name: "shell",
    description:
      "Execute one shell command on the orchestrator host (stdout/stderr captured). POC only; requires ALLOW_SHELL_TOOL=true.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Single shell command line to run (platform shell).",
        },
      },
      required: ["command"],
    },
  },
};

async function shellExecutor(args: Record<string, unknown>): Promise<string> {
  const command = args.command;
  if (typeof command !== "string") throw new Error("shell tool expects string `command`");
  return executeShellCommand(command);
}

export interface ResolvedTools {
  tools: OpenAI.Chat.ChatCompletionTool[];
  execute: Map<string, ToolExecutor>;
}

/**
 * Maps YAML `tools: [name, ...]` to OpenAI tool definitions + executors.
 */
export function resolveTools(names: string[]): ResolvedTools {
  const unique = [...new Set(names)].sort();
  const tools: OpenAI.Chat.ChatCompletionTool[] = [];
  const execute = new Map<string, ToolExecutor>();

  for (const name of unique) {
    if (name === "shell") {
      if (!isShellToolEnabled()) {
        throw new Error(
          'Job lists tools: [shell] but ALLOW_SHELL_TOOL is not "true". Refusing to start shell-capable job.',
        );
      }
      tools.push(shellDefinition);
      execute.set("shell", shellExecutor);
    } else {
      throw new Error(`Unknown tool "${name}". POC supports only: shell`);
    }
  }

  return { tools, execute };
}
