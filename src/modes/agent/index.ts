import { mkdir, rm, writeFile } from "fs/promises";
import { prepareMcpConfig } from "../../mcp/install-mcp-server";
import { parseAllowedTools } from "./parse-tools";
import { configureGitAuthForMode } from "../shared/git-auth";
import { checkHumanActor } from "../../github/validation/actor";
import type { GitHubContext } from "../../github/context";
import type { Octokits } from "../../github/api/client";

/**
 * Prepares the agent mode execution context.
 *
 * Agent mode runs whenever an explicit prompt is provided in the workflow configuration.
 * It bypasses the standard @claude mention checking and comment tracking used by tag mode,
 * providing direct access to Claude Code for automation workflows.
 */
export async function prepareAgentMode({
  context,
  octokit,
  githubToken,
}: {
  context: GitHubContext;
  octokit: Octokits;
  githubToken: string;
}) {
  // Check if actor is human (prevents bot-triggered loops)
  await checkHumanActor(octokit.rest, context);

  // Configure git authentication (shared with tag mode). Agent mode tolerates
  // a missing checkout; every other failure aborts the prepare phase.
  await configureGitAuthForMode({ context, githubToken, mode: "agent" });

  // Create prompt directory. Clear any stale files from a prior invocation first —
  // see src/create-prompt/index.ts for context (non-ephemeral self-hosted runners
  // do not reliably honor the RUNNER_TEMP cleanup contract).
  const promptDir = `${process.env.RUNNER_TEMP || "/tmp"}/claude-prompts`;
  await rm(promptDir, { recursive: true, force: true });
  await mkdir(promptDir, { recursive: true });

  // Write the prompt file - use the user's prompt directly
  const promptContent =
    context.inputs.prompt ||
    `Repository: ${context.repository.owner}/${context.repository.repo}`;

  await writeFile(`${promptDir}/claude-prompt.txt`, promptContent);

  // Parse allowed tools from user's claude_args
  const userClaudeArgs = process.env.CLAUDE_ARGS || "";
  const allowedTools = parseAllowedTools(userClaudeArgs);

  // Check for branch info from environment variables (useful for auto-fix workflows)
  const claudeBranch = process.env.CLAUDE_BRANCH || undefined;
  const defaultBranch = context.repository.default_branch || "main";
  const baseBranch = context.inputs.baseBranch || defaultBranch;

  // Detect current branch from GitHub environment
  const currentBranch =
    claudeBranch ||
    process.env.GITHUB_HEAD_REF ||
    process.env.GITHUB_REF_NAME ||
    defaultBranch;

  // Get our GitHub MCP servers config
  const ourMcpConfig = await prepareMcpConfig({
    githubToken,
    owner: context.repository.owner,
    repo: context.repository.repo,
    branch: currentBranch,
    baseBranch: baseBranch,
    claudeCommentId: undefined, // No tracking comment in agent mode
    allowedTools,
    mode: "agent",
    context,
  });

  // Build final claude_args with multiple --mcp-config flags
  let claudeArgs = "";

  // Add our GitHub servers config if we have any
  const ourConfig = JSON.parse(ourMcpConfig);
  if (ourConfig.mcpServers && Object.keys(ourConfig.mcpServers).length > 0) {
    const escapedOurConfig = ourMcpConfig.replace(/'/g, "'\\''");
    claudeArgs = `--mcp-config '${escapedOurConfig}'`;
  }

  // Append user's claude_args (which may have more --mcp-config flags)
  claudeArgs = `${claudeArgs} ${userClaudeArgs}`.trim();

  return {
    commentId: undefined,
    branchInfo: {
      baseBranch: baseBranch,
      currentBranch: baseBranch, // Use base branch as current when creating new branch
      claudeBranch: claudeBranch,
    },
    mcpConfig: ourMcpConfig,
    claudeArgs,
  };
}
