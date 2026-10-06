import { runClaudeWithSdk } from "./run-claude-sdk";
import type { ClaudeRunResult } from "./run-claude-sdk";
import { parseSdkOptions } from "./parse-sdk-options";

// Re-exported so callers of runClaude() can recognise failures that still
// carry a session id / execution file without importing the SDK module.
export { ClaudeExecutionError } from "./run-claude-sdk";

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

export async function runClaude(
  promptPath: string,
  options: ClaudeOptions,
): Promise<ClaudeRunResult> {
  const parsedOptions = parseSdkOptions(options);
  return runClaudeWithSdk(promptPath, parsedOptions);
}
