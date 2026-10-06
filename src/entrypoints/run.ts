#!/usr/bin/env bun

/**
 * Unified entrypoint for the Claude Code Action.
 * Merges all previously separate action.yml steps (prepare, install, run, cleanup)
 * into a single TypeScript orchestrator.
 *
 * Failure contract: library code throws (see src/utils/prepare-error.ts)
 * instead of exiting the process, so every failure reaches the `finally`
 * block in run(), which finalizes the tracking comment, writes the step
 * summary and sets the action outputs.
 */

import * as core from "@actions/core";
import { appendFile } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { setupGitHubToken, WorkflowValidationSkipError } from "../github/token";
import { checkWritePermissions } from "../github/validation/permissions";
import { createOctokit } from "../github/api/client";
import type { Octokits } from "../github/api/client";
import {
  parseGitHubContext,
  isEntityContext,
  isPullRequestEvent,
  isPullRequestReviewEvent,
  isPullRequestReviewCommentEvent,
  isWorkflowRunEvent,
} from "../github/context";
import type { GitHubContext } from "../github/context";
import { detectMode } from "../modes/detector";
import { prepareTagMode } from "../modes/tag";
import { prepareAgentMode } from "../modes/agent";
import { checkContainsTrigger } from "../github/validation/trigger";
import { restoreConfigFromBase } from "../github/operations/restore-config";
import { validateBranchName } from "../github/operations/branch";
import { collectActionInputsPresence } from "./collect-inputs";
import { updateCommentLink } from "./update-comment-link";
import { formatTurnsFromData } from "./format-turns";
import type { Turn } from "./format-turns";
import { redactSecrets } from "../github/utils/sanitizer";
import { installClaudeCode } from "../install/claude-code-installer";
import { PrepareError, isPrepareError } from "../utils/prepare-error";
// Base-action imports (used directly instead of subprocess)
import { setupWorkloadIdentity } from "../../base-action/src/workload-identity";
import type { WorkloadIdentityHandle } from "../../base-action/src/workload-identity";
import { validateEnvironmentVariables } from "../../base-action/src/validate-env";
import { setupClaudeCodeSettings } from "../../base-action/src/setup-claude-code-settings";
import { installPlugins } from "../../base-action/src/install-plugins";
import { preparePrompt } from "../../base-action/src/prepare-prompt";
import { runClaude } from "../../base-action/src/run-claude";
import type { ClaudeRunResult } from "../../base-action/src/run-claude-sdk";
import { setExecutionFileOutputIfPresent } from "../../base-action/src/execution-file";

// The install command builder lives with the installer; re-exported so
// existing imports keep resolving.
export { buildInstallCommand } from "../install/claude-code-installer";

/**
 * Structural check for the SDK runner's failure error (ClaudeExecutionError
 * in base-action/src/run-claude-sdk.ts). Matching on the name rather than the
 * class keeps the check valid when the runner module is substituted in tests.
 */
function isClaudeExecutionError(
  error: unknown,
): error is Error & { sessionId?: string; executionFile?: string } {
  return error instanceof Error && error.name === "ClaudeExecutionError";
}

/**
 * Write the step summary from Claude's execution output file.
 */
async function writeStepSummary(executionFile: string): Promise<void> {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) return;

  try {
    const fileContent = readFileSync(executionFile, "utf-8");
    const data: Turn[] = JSON.parse(fileContent);
    const markdown = formatTurnsFromData(data);
    await appendFile(summaryFile, markdown);
    console.log("Successfully formatted Claude Code report");
  } catch (error) {
    console.error(`Failed to format output: ${error}`);
    // Fall back to raw JSON
    try {
      let fallback = "## Claude Code Report (Raw Output)\n\n";
      fallback +=
        "Failed to format output (please report). Here's the raw JSON:\n\n";
      fallback += "```json\n";
      fallback += redactSecrets(readFileSync(executionFile, "utf-8"));
      fallback += "\n```\n";
      await appendFile(summaryFile, fallback);
    } catch {
      console.error("Failed to write raw output to step summary");
    }
  }
}

export async function run(): Promise<void> {
  let githubToken: string | undefined;
  let commentId: number | undefined;
  let claudeBranch: string | undefined;
  let baseBranch: string | undefined;
  let executionFile: string | undefined;
  let claudeSuccess = false;
  let prepareSuccess = true;
  let prepareError: string | undefined;
  // Only set once Claude ran or the run failed, so the skip paths (workflow
  // validation mismatch, no trigger) leave the `conclusion` output empty.
  let conclusion: "success" | "failure" | undefined;
  let context: GitHubContext | undefined;
  let octokit: Octokits | undefined;
  let workloadIdentity: WorkloadIdentityHandle | undefined;
  // Paths reverted to the PR base branch, which cleanup must not commit back
  // onto the PR author's branch. Empty unless restoreConfigFromBase ran.
  let restoredConfigPaths: string[] = [];
  // Track whether we've completed prepare phase, so we can attribute errors correctly
  let prepareCompleted = false;
  try {
    // Phase 1: Prepare
    const actionInputsPresent = collectActionInputsPresence();
    context = parseGitHubContext();
    const modeName = detectMode(context);
    console.log(
      `Auto-detected mode: ${modeName} for event: ${context.eventName}`,
    );

    try {
      githubToken = await setupGitHubToken();
    } catch (error) {
      if (error instanceof WorkflowValidationSkipError) {
        core.setOutput("skipped_due_to_workflow_validation_mismatch", "true");
        console.log("Exiting due to workflow validation skip");
        return;
      }
      throw error;
    }

    octokit = createOctokit(githubToken);

    // Set GITHUB_TOKEN and GH_TOKEN in process env for downstream usage
    process.env.GITHUB_TOKEN = githubToken;
    process.env.GH_TOKEN = githubToken;

    // Check write permissions for entity contexts, and for workflow_run
    // events, whose upstream run may have been started by an actor without
    // write access (e.g. the author of a fork pull request)
    if (isEntityContext(context) || isWorkflowRunEvent(context)) {
      const hasWritePermissions = await checkWritePermissions(
        octokit.rest,
        context,
        context.inputs.allowedNonWriteUsers,
        !!process.env.OVERRIDE_GITHUB_TOKEN,
      );
      if (!hasWritePermissions) {
        throw new Error(
          "Actor does not have write permissions to the repository",
        );
      }
    }

    // Check trigger conditions
    const containsTrigger =
      modeName === "tag"
        ? isEntityContext(context) && checkContainsTrigger(context)
        : !!context.inputs?.prompt;
    console.log(`Mode: ${modeName}`);
    console.log(`Context prompt: ${context.inputs?.prompt || "NO PROMPT"}`);
    console.log(`Trigger result: ${containsTrigger}`);

    if (!containsTrigger) {
      console.log("No trigger found, skipping remaining steps");
      core.setOutput("github_token", githubToken);
      return;
    }

    // Run prepare
    console.log(
      `Preparing with mode: ${modeName} for event: ${context.eventName}`,
    );
    const prepareResult =
      modeName === "tag"
        ? await prepareTagMode({
            context,
            octokit,
            githubToken,
            // Learn the tracking comment id as soon as the comment exists, so
            // the finally block can finalize it even when a later prepare step
            // throws before prepareTagMode returns.
            onTrackingComment: (id) => {
              commentId = id;
            },
          })
        : await prepareAgentMode({ context, octokit, githubToken });

    commentId = prepareResult.commentId;
    claudeBranch = prepareResult.branchInfo.claudeBranch;
    baseBranch = prepareResult.branchInfo.baseBranch;
    prepareCompleted = true;

    // Phase 2: Install Claude Code CLI. Claude has not run yet, so an install
    // failure is reported like a prepare failure (with the error text in the
    // tracking comment).
    let claudeExecutable: string;
    try {
      claudeExecutable = await installClaudeCode();
    } catch (error) {
      if (isPrepareError(error)) throw error;
      throw new PrepareError(
        "install",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }

    // Phase 3: Run Claude (import base-action directly)
    // Set env vars needed by the base-action code
    process.env.INPUT_ACTION_INPUTS_PRESENT = actionInputsPresent;
    process.env.CLAUDE_CODE_ACTION = "1";
    process.env.DETAILED_PERMISSION_MESSAGES = "1";

    // When workload identity federation is configured, fetch the GitHub OIDC
    // identity token and expose it to the CLI before validating auth env vars.
    workloadIdentity = await setupWorkloadIdentity();

    validateEnvironmentVariables();

    // On PRs, .claude/ and .mcp.json in the checkout are attacker-controlled.
    // Restore them from the base branch before the CLI reads them.
    //
    // We read pull_request.base.ref from the payload directly because agent
    // mode's branchInfo.baseBranch defaults to the repo's default branch rather
    // than the PR's actual target (agent/index.ts). For issue_comment on a PR the payload
    // lacks base.ref, so we fall back to the mode-provided value — tag mode
    // fetches it from GraphQL; agent mode on issue_comment is an edge case
    // that at worst restores from the wrong trusted branch (still secure).
    if (isEntityContext(context) && context.isPR) {
      let restoreBase = baseBranch;
      if (
        isPullRequestEvent(context) ||
        isPullRequestReviewEvent(context) ||
        isPullRequestReviewCommentEvent(context)
      ) {
        restoreBase = context.payload.pull_request.base.ref;
        validateBranchName(restoreBase);
      }
      if (restoreBase) {
        restoredConfigPaths = restoreConfigFromBase(restoreBase);
      }
    }

    await setupClaudeCodeSettings(process.env.INPUT_SETTINGS);

    await installPlugins(
      process.env.INPUT_PLUGIN_MARKETPLACES,
      process.env.INPUT_PLUGINS,
      claudeExecutable,
    );

    const promptFile =
      process.env.INPUT_PROMPT_FILE ||
      `${process.env.RUNNER_TEMP}/claude-prompts/claude-prompt.txt`;
    const promptConfig = await preparePrompt({
      prompt: "",
      promptFile,
    });

    const claudeResult: ClaudeRunResult = await runClaude(promptConfig.path, {
      claudeArgs: prepareResult.claudeArgs,
      appendSystemPrompt: process.env.APPEND_SYSTEM_PROMPT,
      model: process.env.ANTHROPIC_MODEL,
      pathToClaudeCodeExecutable: claudeExecutable,
      showFullOutput: process.env.INPUT_SHOW_FULL_OUTPUT,
    });

    claudeSuccess = claudeResult.conclusion === "success";
    conclusion = claudeResult.conclusion;
    executionFile = claudeResult.executionFile;

    // Set action-level outputs
    if (claudeResult.executionFile) {
      core.setOutput("execution_file", claudeResult.executionFile);
    }
    if (claudeResult.sessionId) {
      core.setOutput("session_id", claudeResult.sessionId);
    }
    if (claudeResult.structuredOutput) {
      core.setOutput("structured_output", claudeResult.structuredOutput);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    conclusion = "failure";
    executionFile ??= setExecutionFileOutputIfPresent();
    if (isClaudeExecutionError(error)) {
      // The SDK produced a session before failing: expose it so the run can
      // be resumed with --resume and its log can be located.
      if (error.sessionId) {
        core.setOutput("session_id", error.sessionId);
      }
      if (
        !executionFile &&
        error.executionFile &&
        existsSync(error.executionFile)
      ) {
        executionFile = error.executionFile;
        core.setOutput("execution_file", executionFile);
      }
    }
    if (isPrepareError(error)) {
      // Thrown by the prepare/install steps before Claude ran: the tracking
      // comment names the failing step and shows the error.
      console.error(
        `Step '${error.step}' failed: ${redactSecrets(errorMessage)}`,
      );
      prepareSuccess = false;
      prepareError = `${error.step}: ${errorMessage}`;
    } else if (!prepareCompleted) {
      // Only mark as prepare failure if we haven't completed the prepare phase
      prepareSuccess = false;
      prepareError = errorMessage;
    }
    core.setFailed(`Action failed with error: ${redactSecrets(errorMessage)}`);
  } finally {
    // Phase 4: Cleanup (always runs)

    // Stop refreshing the workload identity token file and delete the token
    // material so it doesn't outlive this step
    workloadIdentity?.stop();

    // Update tracking comment
    if (
      commentId &&
      context &&
      isEntityContext(context) &&
      githubToken &&
      octokit
    ) {
      try {
        await updateCommentLink({
          commentId,
          githubToken,
          claudeBranch,
          baseBranch: baseBranch || context.repository.default_branch || "main",
          triggerUsername: context.actor,
          context,
          octokit,
          claudeSuccess,
          outputFile: executionFile,
          prepareSuccess,
          prepareError,
          useCommitSigning: context.inputs.useCommitSigning,
          restoredConfigPaths,
        });
      } catch (error) {
        console.error("Error updating comment with job link:", error);
      }
    }

    // Write step summary (unless display_report is set to false)
    if (
      executionFile &&
      existsSync(executionFile) &&
      process.env.DISPLAY_REPORT !== "false"
    ) {
      await writeStepSummary(executionFile);
    }

    // Set remaining action-level outputs
    if (conclusion) {
      core.setOutput("conclusion", conclusion);
    }
    core.setOutput("branch_name", claudeBranch);
    core.setOutput("github_token", githubToken);
  }
}

if (import.meta.main) {
  run();
}
