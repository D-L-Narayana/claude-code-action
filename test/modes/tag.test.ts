import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  mock,
  spyOn,
} from "bun:test";
import type { Mock } from "bun:test";
import { prepareTagMode } from "../../src/modes/tag";
import { PrepareError } from "../../src/utils/prepare-error";
import { mockIssueCommentContext } from "../mockContext";
import * as actor from "../../src/github/validation/actor";
import * as createInitial from "../../src/github/operations/comments/create-initial";
import * as fetcher from "../../src/github/data/fetcher";
import * as branch from "../../src/github/operations/branch";
import * as createPrompt from "../../src/create-prompt";
import * as mcp from "../../src/mcp/install-mcp-server";
import * as gitConfig from "../../src/github/operations/git-config";

const SSH_SIGNING_KEY =
  "-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----";

const BRANCH_INFO = {
  baseBranch: "main",
  claudeBranch: "claude/test",
  currentBranch: "claude/test",
};

describe("Tag Mode", () => {
  let spies: Array<{ mockRestore: () => void }>;
  let configureGitAuthSpy: Mock<typeof gitConfig.configureGitAuth>;
  let replaceCheckoutCredentialsSpy: Mock<
    typeof gitConfig.replaceCheckoutCredentials
  >;
  let setupSshSigningSpy: Mock<typeof gitConfig.setupSshSigning>;
  let fetchGitHubDataSpy: Mock<typeof fetcher.fetchGitHubData>;
  let setupBranchSpy: Mock<typeof branch.setupBranch>;

  beforeEach(() => {
    configureGitAuthSpy = spyOn(
      gitConfig,
      "configureGitAuth",
    ).mockImplementation(async () => {});
    replaceCheckoutCredentialsSpy = spyOn(
      gitConfig,
      "replaceCheckoutCredentials",
    ).mockImplementation(async () => {});
    setupSshSigningSpy = spyOn(gitConfig, "setupSshSigning").mockImplementation(
      async () => {},
    );
    fetchGitHubDataSpy = spyOn(fetcher, "fetchGitHubData").mockImplementation(
      async () => ({}) as never,
    );
    setupBranchSpy = spyOn(branch, "setupBranch").mockImplementation(
      async () => BRANCH_INFO as never,
    );
    spies = [
      configureGitAuthSpy,
      replaceCheckoutCredentialsSpy,
      setupSshSigningSpy,
      fetchGitHubDataSpy,
      setupBranchSpy,
      spyOn(actor, "checkHumanActor").mockImplementation(async () => {}),
      spyOn(createInitial, "createInitialComment").mockImplementation(
        async () => ({ id: 42 }) as never,
      ),
      spyOn(createPrompt, "createPrompt").mockImplementation(async () => {}),
      spyOn(mcp, "prepareMcpConfig").mockImplementation(async () => "{}"),
    ];
  });

  afterEach(() => {
    for (const spy of spies) {
      spy.mockRestore();
    }
  });

  test("prepareTagMode is exported as a function", () => {
    expect(typeof prepareTagMode).toBe("function");
  });

  describe("git credential configuration", () => {
    test("uses full git auth on the non-signing path", async () => {
      const context = { ...mockIssueCommentContext };

      const result = await prepareTagMode({
        context,
        octokit: {} as never,
        githubToken: "test-token",
      });

      expect(configureGitAuthSpy).toHaveBeenCalledTimes(1);
      expect(configureGitAuthSpy).toHaveBeenCalledWith("test-token", context, {
        login: context.inputs.botName,
        id: parseInt(context.inputs.botId),
      });
      // configureGitAuth performs the credential replacement itself; the mock
      // stands in for it here, so the standalone helper is not invoked.
      expect(replaceCheckoutCredentialsSpy).not.toHaveBeenCalled();
      expect(setupSshSigningSpy).not.toHaveBeenCalled();
      // Commits are made with the git CLI, not the API file-ops tools
      expect(result.claudeArgs).toContain("Bash(git commit:*)");
      expect(result.claudeArgs).not.toContain(
        "mcp__github_file_ops__commit_files",
      );
    });

    test("still replaces the checkout credential when API commit signing is enabled", async () => {
      const context = {
        ...mockIssueCommentContext,
        inputs: { ...mockIssueCommentContext.inputs, useCommitSigning: true },
      };

      const result = await prepareTagMode({
        context,
        octokit: {} as never,
        githubToken: "test-token",
      });

      expect(configureGitAuthSpy).not.toHaveBeenCalled();
      expect(replaceCheckoutCredentialsSpy).toHaveBeenCalledTimes(1);
      expect(replaceCheckoutCredentialsSpy).toHaveBeenCalledWith(
        "test-token",
        context,
      );
      expect(setupSshSigningSpy).not.toHaveBeenCalled();
      // Commits go through the API, so the git CLI commands are not granted
      expect(result.claudeArgs).toContain("mcp__github_file_ops__commit_files");
      expect(result.claudeArgs).not.toContain("Bash(git commit:*)");
    });

    test("SSH signing takes precedence over API commit signing and keeps the git CLI tools", async () => {
      const context = {
        ...mockIssueCommentContext,
        inputs: {
          ...mockIssueCommentContext.inputs,
          sshSigningKey: SSH_SIGNING_KEY,
          useCommitSigning: true,
        },
      };

      const result = await prepareTagMode({
        context,
        octokit: {} as never,
        githubToken: "test-token",
      });

      expect(setupSshSigningSpy).toHaveBeenCalledTimes(1);
      expect(setupSshSigningSpy).toHaveBeenCalledWith(SSH_SIGNING_KEY);
      expect(configureGitAuthSpy).toHaveBeenCalledTimes(1);
      expect(configureGitAuthSpy).toHaveBeenCalledWith("test-token", context, {
        login: context.inputs.botName,
        id: parseInt(context.inputs.botId),
      });
      expect(replaceCheckoutCredentialsSpy).not.toHaveBeenCalled();
      expect(result.claudeArgs).toContain("Bash(git commit:*)");
      expect(result.claudeArgs).not.toContain(
        "mcp__github_file_ops__commit_files",
      );
    });
  });

  describe("tracking comment", () => {
    test("reports the comment id as soon as the comment exists, before later steps run", async () => {
      const order: string[] = [];
      const onTrackingComment = mock((_commentId: number) => {
        order.push("onTrackingComment");
      });
      fetchGitHubDataSpy.mockImplementation(async () => {
        order.push("fetchGitHubData");
        return {} as never;
      });
      setupBranchSpy.mockImplementation(async () => {
        order.push("setupBranch");
        return BRANCH_INFO as never;
      });

      const result = await prepareTagMode({
        context: { ...mockIssueCommentContext },
        octokit: {} as never,
        githubToken: "test-token",
        onTrackingComment,
      });

      expect(onTrackingComment).toHaveBeenCalledTimes(1);
      expect(onTrackingComment).toHaveBeenCalledWith(42);
      expect(order).toEqual([
        "onTrackingComment",
        "fetchGitHubData",
        "setupBranch",
      ]);
      // The return shape is unchanged: the id is still part of the result
      expect(result.commentId).toBe(42);
      expect(result.branchInfo).toEqual(BRANCH_INFO);
    });

    test("still reports the comment id when a later step throws, and the failure propagates", async () => {
      const onTrackingComment = mock((_commentId: number) => {});
      setupBranchSpy.mockImplementation(async () => {
        throw new PrepareError("branch", "Invalid branch name: bad name");
      });

      const error = await prepareTagMode({
        context: { ...mockIssueCommentContext },
        octokit: {} as never,
        githubToken: "test-token",
        onTrackingComment,
      }).then(
        () => undefined,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(PrepareError);
      expect((error as PrepareError).step).toBe("branch");
      expect((error as PrepareError).message).toBe(
        "Invalid branch name: bad name",
      );
      // The caller learned the id before the failure and can finalize the comment
      expect(onTrackingComment).toHaveBeenCalledTimes(1);
      expect(onTrackingComment).toHaveBeenCalledWith(42);
    });
  });
});
