import * as core from "@actions/core";
import { readFile, access } from "fs/promises";
import { dirname, join } from "path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ParsedSdkOptions } from "./parse-sdk-options";
import { writeExecutionFile } from "./execution-file";

export type ClaudeRunResult = {
  executionFile?: string;
  sessionId?: string;
  conclusion: "success" | "failure";
  structuredOutput?: string;
};

/**
 * Error thrown when a Claude run ends without a usable result. It carries the
 * session id and execution file (when known) so callers can still expose them
 * as outputs after a failure instead of losing them with the thrown error.
 */
export class ClaudeExecutionError extends Error {
  readonly sessionId?: string;
  readonly executionFile?: string;

  constructor(
    message: string,
    details: { sessionId?: string; executionFile?: string },
  ) {
    super(message);
    this.name = "ClaudeExecutionError";
    this.sessionId = details.sessionId;
    this.executionFile = details.executionFile;
  }
}

/** Filename for the user request file, written by prompt generation */
const USER_REQUEST_FILENAME = "claude-user-request.txt";

/**
 * Extract the session id from the system.init message, if one was received.
 */
function extractSessionId(messages: SDKMessage[]): string | undefined {
  const initMessage = messages.find(
    (m) => m.type === "system" && "subtype" in m && m.subtype === "init",
  );
  if (initMessage && "session_id" in initMessage && initMessage.session_id) {
    return initMessage.session_id as string;
  }
  return undefined;
}

/**
 * Check if a file exists
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates a prompt configuration for the SDK.
 * If a user request file exists alongside the prompt file, returns a multi-block
 * SDKUserMessage that enables slash command processing in the CLI.
 * Otherwise, returns the prompt as a simple string.
 */
async function createPromptConfig(
  promptPath: string,
  showFullOutput: boolean,
): Promise<string | AsyncIterable<SDKUserMessage>> {
  const promptContent = await readFile(promptPath, "utf-8");

  // Check for user request file in the same directory
  const userRequestPath = join(dirname(promptPath), USER_REQUEST_FILENAME);
  const hasUserRequest = await fileExists(userRequestPath);

  if (!hasUserRequest) {
    // No user request file - use simple string prompt
    return promptContent;
  }

  // User request file exists - create multi-block message
  const userRequest = await readFile(userRequestPath, "utf-8");
  if (showFullOutput) {
    console.log("Using multi-block message with user request:", userRequest);
  } else {
    console.log("Using multi-block message with user request (content hidden)");
  }

  // Create an async generator that yields a single multi-block message
  // The context/instructions go first, then the user's actual request last
  // This allows the CLI to detect and process slash commands in the user request
  async function* createMultiBlockMessage(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: "user",
      session_id: "",
      message: {
        role: "user",
        content: [
          { type: "text", text: promptContent }, // Instructions + GitHub context
          { type: "text", text: userRequest }, // User's request (may be a slash command)
        ],
      },
      parent_tool_use_id: null,
    };
  }

  return createMultiBlockMessage();
}

type ModelUsageSummary = Record<
  string,
  {
    contextWindow: number;
    maxOutputTokens: number;
  }
>;

/**
 * Keep resolved model limits visible without exposing token usage or cost details.
 */
function sanitizeModelUsage(
  modelUsage: SDKResultMessage["modelUsage"] | undefined,
): ModelUsageSummary | undefined {
  if (!modelUsage) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(modelUsage).map(([model, usage]) => [
      model,
      {
        contextWindow: usage.contextWindow,
        maxOutputTokens: usage.maxOutputTokens,
      },
    ]),
  );
}

/**
 * Sanitizes SDK output to match CLI sanitization behavior
 */
function sanitizeSdkOutput(
  message: SDKMessage,
  showFullOutput: boolean,
): string | null {
  if (showFullOutput) {
    return JSON.stringify(message, null, 2);
  }

  // System initialization - safe to show
  if (message.type === "system" && message.subtype === "init") {
    return JSON.stringify(
      {
        type: "system",
        subtype: "init",
        message: "Claude Code initialized",
        model: "model" in message ? message.model : "unknown",
      },
      null,
      2,
    );
  }

  // Result messages - show sanitized summary
  if (message.type === "result") {
    const resultMsg = message as SDKResultMessage;
    return JSON.stringify(
      {
        type: "result",
        subtype: resultMsg.subtype,
        is_error: resultMsg.is_error,
        duration_ms: resultMsg.duration_ms,
        num_turns: resultMsg.num_turns,
        total_cost_usd: resultMsg.total_cost_usd,
        permission_denials_count: resultMsg.permission_denials?.length ?? 0,
        modelUsage: sanitizeModelUsage(resultMsg.modelUsage),
      },
      null,
      2,
    );
  }

  // Suppress other message types in non-full-output mode
  return null;
}

/**
 * Run Claude using the Agent SDK
 */
export async function runClaudeWithSdk(
  promptPath: string,
  { sdkOptions, showFullOutput, hasJsonSchema }: ParsedSdkOptions,
): Promise<ClaudeRunResult> {
  // Create prompt configuration - may be a string or multi-block message
  const prompt = await createPromptConfig(promptPath, showFullOutput);

  if (!showFullOutput) {
    console.log(
      "Running Claude Code via SDK (full output hidden for security)...",
    );
    console.log(
      "Rerun in debug mode or enable `show_full_output: true` in your workflow file for full output.",
    );
  }

  console.log(`Running Claude with prompt from file: ${promptPath}`);
  // Log SDK options without env (which could contain sensitive data)
  const { env, extraArgs, ...optionsToLog } = sdkOptions;
  console.log("SDK options:", JSON.stringify(optionsToLog, null, 2));

  const messages: SDKMessage[] = [];
  let resultMessage: SDKResultMessage | undefined;

  try {
    for await (const message of query({ prompt, options: sdkOptions })) {
      messages.push(message);

      const sanitized = sanitizeSdkOutput(message, showFullOutput);
      if (sanitized) {
        console.log(sanitized);
      }

      if (message.type === "result") {
        resultMessage = message as SDKResultMessage;
        // The SDK's query() iterator should close itself after the
        // result message, but in some workflow contexts (notably
        // pull_request-triggered runs) it stays open indefinitely and
        // the for-await hangs until the workflow's timeout-minutes
        // kills the job. This causes the action to "succeed" inside
        // Claude (verdict posted, $cost recorded) but be reported as
        // cancelled with no execution-output.json written. Break
        // explicitly: by SDK contract no further messages follow a
        // result, so the break is safe.
        break;
      }
    }
  } catch (error) {
    console.error("SDK execution error:", error);
    // Whatever was learned before the failure (execution log, session id)
    // travels with the error so callers can still surface it as outputs.
    const executionFile = await writeExecutionFile(messages);
    throw new ClaudeExecutionError(`SDK execution error: ${error}`, {
      sessionId: extractSessionId(messages),
      executionFile,
    });
  }

  const result: ClaudeRunResult = {
    conclusion: "failure",
  };

  const executionFile = await writeExecutionFile(messages);
  if (executionFile) {
    result.executionFile = executionFile;
  }

  // Extract session_id from system.init message
  const sessionId = extractSessionId(messages);
  if (sessionId) {
    result.sessionId = sessionId;
    core.info(`Set session_id: ${result.sessionId}`);
  }

  // Attached to every failure thrown below so the session can still be
  // resumed / the log located even though no ClaudeRunResult is returned
  const failureDetails = {
    sessionId: result.sessionId,
    executionFile: result.executionFile,
  };

  if (!resultMessage) {
    core.error("No result message received from Claude");
    throw new ClaudeExecutionError(
      "No result message received from Claude",
      failureDetails,
    );
  }

  if (
    resultMessage.subtype === "success" &&
    !resultMessage.is_error &&
    sdkOptions.maxTurns !== undefined &&
    resultMessage.num_turns > sdkOptions.maxTurns
  ) {
    const message = `Claude reported a successful result after ${resultMessage.num_turns} turns, exceeding the configured maximum of ${sdkOptions.maxTurns}`;
    core.error(message);
    throw new ClaudeExecutionError(message, failureDetails);
  }

  // subtype "success" with is_error:true means the run errored without producing
  // a real result — treat it as failure so CI does not show a misleading green check.
  const isSuccess =
    resultMessage.subtype === "success" && !resultMessage.is_error;
  result.conclusion = isSuccess ? "success" : "failure";

  // Handle structured output
  if (hasJsonSchema) {
    if (
      isSuccess &&
      "structured_output" in resultMessage &&
      resultMessage.structured_output
    ) {
      result.structuredOutput = JSON.stringify(resultMessage.structured_output);
      core.info(
        `Set structured_output with ${Object.keys(resultMessage.structured_output as object).length} field(s)`,
      );
    } else {
      core.setFailed(
        `--json-schema was provided but Claude did not return structured_output. Result subtype: ${resultMessage.subtype}`,
      );
      result.conclusion = "failure";
      throw new ClaudeExecutionError(
        `--json-schema was provided but Claude did not return structured_output. Result subtype: ${resultMessage.subtype}`,
        failureDetails,
      );
    }
  }

  if (!isSuccess) {
    if (resultMessage.subtype === "success" && resultMessage.is_error) {
      core.error(
        "Claude result reported subtype success with is_error:true (run did not complete successfully)",
      );
    }
    if ("errors" in resultMessage && resultMessage.errors) {
      core.error(`Execution failed: ${resultMessage.errors.join(", ")}`);
    }
    throw new ClaudeExecutionError(
      `Claude execution failed: ${
        resultMessage.subtype === "success" && resultMessage.is_error
          ? "result is_error:true"
          : "errors" in resultMessage && resultMessage.errors
            ? resultMessage.errors.join(", ")
            : "unknown error"
      }`,
      failureDetails,
    );
  }

  return result;
}
