import type OpenAI from "openai";
import { executeShellCommand, isShellToolEnabled } from "./shell-tool.js";
import { executeWorkspaceWrite, isWorkspaceWriteEnabled } from "./workspace-write-tool.js";

export type ToolExecutor = (args: Record<string, unknown>) => Promise<string>;

const shellDefinition: OpenAI.Chat.ChatCompletionTool = {
  type: "function",
  function: {
    name: "shell",
    description:
      "Execute one shell command on the orchestrator host (stdout/stderr captured). Optional stdin avoids quoting huge payloads in the command line. POC only; requires ALLOW_SHELL_TOOL=true.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Single shell command line to run (platform shell).",
        },
        stdin: {
          type: "string",
          description:
            "Optional UTF-8 text fed to process stdin (pipe). Use for scripts too large or fragile for inline quoting.",
        },
      },
      required: ["command"],
    },
  },
};

const workspaceWriteDefinition: OpenAI.Chat.ChatCompletionTool = {
  type: "function",
  function: {
    name: "workspace_write",
    description:
      "Write a UTF-8 text file under TOOL_SHELL_CWD without shell quoting. Path must be relative (no .. escapes). Safer than shell for saving drafts.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path under the workspace root (e.g. essay-draft.txt).",
        },
        content: {
          type: "string",
          description: "Full file contents as UTF-8 text.",
        },
      },
      required: ["path", "content"],
    },
  },
};

async function shellExecutor(args: Record<string, unknown>): Promise<string> {
  const command = args.command;
  if (typeof command !== "string") throw new Error("shell tool expects string `command`");
  const stdin = args.stdin;
  if (stdin !== undefined && typeof stdin !== "string") throw new Error("shell tool `stdin` must be a string");
  return executeShellCommand(command, stdin !== undefined ? { stdin } : undefined);
}

async function workspaceWriteExecutor(args: Record<string, unknown>): Promise<string> {
  const rel = args.path;
  const content = args.content;
  if (typeof rel !== "string") throw new Error("workspace_write expects string `path`");
  if (typeof content !== "string") throw new Error("workspace_write expects string `content`");
  return executeWorkspaceWrite({ path: rel, content });
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
    } else if (name === "workspace_write") {
      if (!isWorkspaceWriteEnabled()) {
        throw new Error(
          'Job lists tools: [workspace_write] but workspace writes are disabled (set ALLOW_WORKSPACE_WRITE=true or ALLOW_SHELL_TOOL=true).',
        );
      }
      tools.push(workspaceWriteDefinition);
      execute.set("workspace_write", workspaceWriteExecutor);
    } else {
      throw new Error(`Unknown tool "${name}". POC supports: shell, workspace_write`);
    }
  }

  return { tools, execute };
}
