// Test double for base-action/src/run-claude, substituted at runtime by the
// preload plugin in ./preload-fake-claude.ts when the end-to-end harness spawns
// src/entrypoints/run.ts. It stands in for the Claude Code SDK call only; the
// rest of the orchestration (GitHub API calls, git, prompt generation, MCP
// configuration, outputs, cleanup) runs unmodified.
//
// Behavior is driven by environment variables set by the harness:
//   E2E_CLAUDE_OUTCOME  "success" (default) or "failure"
//   E2E_CAPTURE_FILE    path that receives a JSON record of the invocation
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

export type ClaudeOptions = {
  claudeArgs?: string;
  model?: string;
  pathToClaudeCodeExecutable?: string;
  allowedTools?: string;
  disallowedTools?: string;
  maxTurns?: string;
  mcpConfig?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  fallbackModel?: string;
  showFullOutput?: string;
};

export type ClaudeRunResult = {
  executionFile?: string;
  sessionId?: string;
  conclusion: "success" | "failure";
  structuredOutput?: string;
};

export class ClaudeExecutionError extends Error {
  readonly sessionId?: string;
  readonly executionFile?: string;

  constructor(
    message: string,
    details: { sessionId?: string; executionFile?: string } = {},
  ) {
    super(message);
    this.name = "ClaudeExecutionError";
    this.sessionId = details.sessionId;
    this.executionFile = details.executionFile;
  }
}

export const E2E_SESSION_ID = "e2e-session-0001";

export type CapturedInvocation = {
  promptPath: string;
  prompt: string;
  claudeArgs: string;
  pathToClaudeCodeExecutable: string;
  outcome: "success" | "failure";
};

export async function runClaude(
  promptPath: string,
  options: ClaudeOptions,
): Promise<ClaudeRunResult> {
  const outcome: "success" | "failure" =
    process.env.E2E_CLAUDE_OUTCOME === "failure" ? "failure" : "success";
  const runnerTemp = process.env.RUNNER_TEMP || "/tmp";
  const executionFile = join(runnerTemp, "claude-execution-output.json");
  const prompt = readFileSync(promptPath, "utf-8");

  const messages = [
    {
      type: "system",
      subtype: "init",
      session_id: E2E_SESSION_ID,
      model: "fake-model",
      tools: ["Read", "mcp__github_comment__update_claude_comment"],
      mcp_servers: [{ name: "github_comment", status: "connected" }],
    },
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "text",
            text: "End-to-end harness: simulated assistant turn.",
          },
        ],
        usage: { input_tokens: 12, output_tokens: 7 },
      },
    },
    {
      type: "result",
      subtype: outcome === "success" ? "success" : "error_during_execution",
      is_error: outcome !== "success",
      duration_ms: 61_000,
      duration_api_ms: 50_000,
      num_turns: 1,
      total_cost_usd: 0.0123,
      result: outcome === "success" ? "Simulated completion" : "",
    },
  ];
  mkdirSync(dirname(executionFile), { recursive: true });
  writeFileSync(executionFile, JSON.stringify(messages, null, 2));

  const capturePath = process.env.E2E_CAPTURE_FILE;
  if (capturePath) {
    // The MCP server config inside claudeArgs carries the GitHub token; keep
    // the capture file free of it even though it lives in a temp directory.
    const token = process.env.GITHUB_TOKEN;
    const claudeArgs = options.claudeArgs ?? "";
    const captured: CapturedInvocation = {
      promptPath,
      prompt,
      claudeArgs: token ? claudeArgs.replaceAll(token, "[token]") : claudeArgs,
      pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable ?? "",
      outcome,
    };
    mkdirSync(dirname(capturePath), { recursive: true });
    writeFileSync(capturePath, JSON.stringify(captured, null, 2));
  }

  if (outcome === "failure") {
    throw new ClaudeExecutionError(
      "Claude execution failed: result is_error:true",
      { sessionId: E2E_SESSION_ID, executionFile },
    );
  }
  return { conclusion: "success", executionFile, sessionId: E2E_SESSION_ID };
}
