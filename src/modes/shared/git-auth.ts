import * as core from "@actions/core";
import type { GitHubContext } from "../../github/context";
import {
  configureGitAuth,
  replaceCheckoutCredentials,
  setupSshSigning,
} from "../../github/operations/git-config";
import type { GitUser } from "../../github/operations/git-config";
import { PrepareError } from "../../utils/prepare-error";

export type GitAuthMode = "tag" | "agent";

/**
 * How Claude's commits and pushes are authenticated:
 * - "ssh-signing": commits are made with the git CLI and signed with the
 *   provided SSH key; pushes use the action's token.
 * - "git-cli": commits and pushes use the git CLI with the bot identity and
 *   the action's token.
 * - "api-commit-signing": commits go through the GitHub API (signed by
 *   GitHub); only the credential actions/checkout left behind is replaced.
 */
export type GitAuthStrategy = "ssh-signing" | "git-cli" | "api-commit-signing";

const FAILURE_LABEL: Record<GitAuthStrategy, string> = {
  "ssh-signing": "Failed to configure SSH signing and git authentication",
  "git-cli": "Failed to configure git authentication",
  "api-commit-signing": "Failed to replace the actions/checkout git credential",
};

// What git prints when the working directory is not inside a repository, i.e.
// the workflow has no actions/checkout step. The exact wording depends on the
// first git command that runs (`git config …` vs `git remote …`).
const NO_REPOSITORY_PATTERN =
  /not a git repository|not in a git directory|can only be used inside a git repository/i;

export function resolveGitAuthStrategy(
  inputs: Pick<GitHubContext["inputs"], "sshSigningKey" | "useCommitSigning">,
): GitAuthStrategy {
  // ssh_signing_key takes precedence over use_commit_signing (see action.yml)
  if (inputs.sshSigningKey) return "ssh-signing";
  if (inputs.useCommitSigning) return "api-commit-signing";
  return "git-cli";
}

/**
 * Configure git for the selected strategy, with the failure policy of the
 * calling mode.
 *
 * Tag mode always runs inside an actions/checkout working tree, so any failure
 * fails the prepare phase. Agent mode may legitimately run without a checkout
 * (schedule, workflow_dispatch); in that single case there is no repository to
 * configure and no checkout credential to replace, so a warning is enough. Any
 * other failure — in particular one that leaves the actions/checkout
 * credential in place — fails the run in both modes.
 */
export async function configureGitAuthForMode({
  context,
  githubToken,
  mode,
}: {
  context: GitHubContext;
  githubToken: string;
  mode: GitAuthMode;
}): Promise<void> {
  const strategy = resolveGitAuthStrategy(context.inputs);
  // API commit signing commits through the GitHub API and never reads bot_id.
  // The git CLI paths validate it before any git command runs so a typo fails
  // fast instead of producing a "NaN+claude[bot]@…" committer email.
  const user =
    strategy === "api-commit-signing"
      ? undefined
      : resolveGitUser(context.inputs);

  try {
    if (user === undefined) {
      // Commits go through the GitHub API, so no git identity is needed, but
      // the credential actions/checkout left in git config must still be
      // replaced with the action's own.
      await replaceCheckoutCredentials(githubToken, context);
    } else {
      if (strategy === "ssh-signing") {
        await setupSshSigning(context.inputs.sshSigningKey);
      }
      // SSH signing still needs the git identity and the push credential
      await configureGitAuth(githubToken, context, user);
    }
  } catch (error) {
    const detail = redactToken(describeFailure(error), githubToken);
    if (mode === "agent" && NO_REPOSITORY_PATTERN.test(detail)) {
      core.warning(
        `Git authentication was not configured because the workspace is not a git repository (${detail}). ` +
          "Add an actions/checkout step before this action if Claude needs to run git commands.",
      );
      return;
    }
    throw new PrepareError(
      "git-auth",
      `${FAILURE_LABEL[strategy]}: ${detail}`,
      { cause: error },
    );
  }
}

function resolveGitUser(
  inputs: Pick<GitHubContext["inputs"], "botId" | "botName">,
): GitUser {
  const id = parseInt(inputs.botId, 10);
  if (Number.isNaN(id)) {
    throw new PrepareError(
      "git-auth",
      `bot_id must be a numeric GitHub user id (got '${inputs.botId}')`,
    );
  }
  return { login: inputs.botName, id };
}

/**
 * Bun's `$` rejects with a ShellError whose message is only
 * "Failed with exit code N"; git's actual diagnostic is in `stderr`.
 */
function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const stderr = (error as { stderr?: unknown }).stderr;
  const diagnostic =
    typeof stderr === "string"
      ? stderr.trim()
      : stderr instanceof Uint8Array
        ? new TextDecoder().decode(stderr).trim()
        : "";
  return diagnostic ? `${diagnostic} (${error.message})` : error.message;
}

// git may echo the authenticated remote URL in its diagnostics
function redactToken(text: string, token: string): string {
  return token ? text.replaceAll(token, "***") : text;
}
