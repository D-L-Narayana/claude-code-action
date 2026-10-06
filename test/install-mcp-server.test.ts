import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { prepareMcpConfig } from "../src/mcp/install-mcp-server";
import { PrepareError } from "../src/utils/prepare-error";
import * as core from "@actions/core";
import type { ParsedGitHubContext } from "../src/github/context";
import { CLAUDE_APP_BOT_ID, CLAUDE_BOT_LOGIN } from "../src/github/constants";

// Runs `fn` with the given process.env entries set (or deleted when the value
// is undefined) and restores the previous values afterwards, so tests are
// independent of whether they run inside GitHub Actions.
async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  const apply = (entries: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
  }
  apply(overrides);
  try {
    return await fn();
  } finally {
    apply(saved);
  }
}

describe("prepareMcpConfig", () => {
  let consoleInfoSpy: any;
  let consoleWarningSpy: any;
  let setFailedSpy: any;
  let fetchSpy: any;

  // Create a mock context for tests
  const mockContext: ParsedGitHubContext = {
    runId: "test-run-id",
    eventName: "issue_comment",
    eventAction: "created",
    repository: {
      owner: "test-owner",
      repo: "test-repo",
      full_name: "test-owner/test-repo",
    },
    actor: "test-actor",
    payload: {} as any,
    entityNumber: 123,
    isPR: false,
    inputs: {
      prompt: "",
      triggerPhrase: "@claude",
      assigneeTrigger: "",
      labelTrigger: "",
      branchPrefix: "",
      useStickyComment: false,
      classifyInlineComments: true,
      useCommitSigning: false,
      sshSigningKey: "",
      botId: String(CLAUDE_APP_BOT_ID),
      botName: CLAUDE_BOT_LOGIN,
      allowedBots: "",
      allowedNonWriteUsers: "",
      trackProgress: false,
      includeFixLinks: true,
      includeCommentsByActor: "",
      excludeCommentsByActor: "",
    },
  };

  const mockPRContext: ParsedGitHubContext = {
    ...mockContext,
    eventName: "pull_request",
    isPR: true,
    entityNumber: 456,
  };

  const mockContextWithSigning: ParsedGitHubContext = {
    ...mockContext,
    inputs: {
      ...mockContext.inputs,
      useCommitSigning: true,
    },
  };

  const mockPRContextWithSigning: ParsedGitHubContext = {
    ...mockPRContext,
    inputs: {
      ...mockPRContext.inputs,
      useCommitSigning: true,
    },
  };

  beforeEach(() => {
    consoleInfoSpy = spyOn(core, "info").mockImplementation(() => {});
    consoleWarningSpy = spyOn(core, "warning").mockImplementation(() => {});
    setFailedSpy = spyOn(core, "setFailed").mockImplementation(() => {});
    // Mock fetch so checkActionsReadPermission succeeds (returns 200 for actions API)
    fetchSpy = spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 }),
    );

    // Set up required environment variables
    if (!process.env.GITHUB_ACTION_PATH) {
      process.env.GITHUB_ACTION_PATH = "/test/action/path";
    }
  });

  afterEach(() => {
    consoleInfoSpy.mockRestore();
    consoleWarningSpy.mockRestore();
    setFailedSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  test("should return comment server when commit signing is disabled", async () => {
    const result = await prepareMcpConfig({
      githubToken: "test-token",
      owner: "test-owner",
      repo: "test-repo",
      branch: "test-branch",
      baseBranch: "main",
      allowedTools: [],
      context: mockContext,
      mode: "tag",
    });

    const parsed = JSON.parse(result);
    expect(parsed.mcpServers).toBeDefined();
    expect(parsed.mcpServers.github).not.toBeDefined();
    expect(parsed.mcpServers.github_file_ops).not.toBeDefined();
    expect(parsed.mcpServers.github_comment).toBeDefined();
    expect(parsed.mcpServers.github_comment.env.GITHUB_TOKEN).toBe(
      "test-token",
    );
  });

  test("should include file ops server when commit signing is enabled", async () => {
    const result = await prepareMcpConfig({
      githubToken: "test-token",
      owner: "test-owner",
      repo: "test-repo",
      branch: "test-branch",
      baseBranch: "main",
      allowedTools: [],
      mode: "tag",
      context: mockContextWithSigning,
    });

    const parsed = JSON.parse(result);
    expect(parsed.mcpServers).toBeDefined();
    expect(parsed.mcpServers.github).not.toBeDefined();
    expect(parsed.mcpServers.github_file_ops).toBeDefined();
    expect(parsed.mcpServers.github_file_ops.env.GITHUB_TOKEN).toBe(
      "test-token",
    );
    expect(parsed.mcpServers.github_file_ops.env.BRANCH_NAME).toBe(
      "test-branch",
    );
  });

  test("should tell the file ops server it is working on a PR from the context", async () => {
    const result = await withEnv({ IS_PR: undefined }, () =>
      prepareMcpConfig({
        githubToken: "test-token",
        owner: "test-owner",
        repo: "test-repo",
        branch: "test-branch",
        baseBranch: "main",
        allowedTools: [],
        mode: "tag",
        context: mockPRContextWithSigning,
      }),
    );

    const parsed = JSON.parse(result);
    expect(parsed.mcpServers.github_file_ops.env.IS_PR).toBe("true");
  });

  test("should tell the file ops server it is not on a PR for an issue, ignoring process.env.IS_PR", async () => {
    // Nothing in the action sets IS_PR in the environment; a stray value from
    // the runner must not be able to flip the server into PR mode.
    const result = await withEnv({ IS_PR: "true" }, () =>
      prepareMcpConfig({
        githubToken: "test-token",
        owner: "test-owner",
        repo: "test-repo",
        branch: "test-branch",
        baseBranch: "main",
        allowedTools: [],
        mode: "tag",
        context: mockContextWithSigning,
      }),
    );

    const parsed = JSON.parse(result);
    expect(parsed.mcpServers.github_file_ops.env.IS_PR).toBe("false");
  });

  test("should include github MCP server when mcp__github__ tools are allowed", async () => {
    const result = await prepareMcpConfig({
      githubToken: "test-token",
      owner: "test-owner",
      repo: "test-repo",
      branch: "test-branch",
      baseBranch: "main",
      allowedTools: ["mcp__github__create_issue", "mcp__github__create_pr"],
      mode: "tag",
      context: mockContext,
    });

    const parsed = JSON.parse(result);
    expect(parsed.mcpServers).toBeDefined();
    expect(parsed.mcpServers.github).toBeDefined();
    expect(parsed.mcpServers.github.command).toBe("docker");
    expect(parsed.mcpServers.github.env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe(
      "test-token",
    );
  });

  test("should include inline comment server for PRs when tools are allowed", async () => {
    const result = await prepareMcpConfig({
      githubToken: "test-token",
      owner: "test-owner",
      repo: "test-repo",
      branch: "test-branch",
      baseBranch: "main",
      allowedTools: ["mcp__github_inline_comment__create_inline_comment"],
      mode: "tag",
      context: mockPRContext,
    });

    const parsed = JSON.parse(result);
    expect(parsed.mcpServers).toBeDefined();
    expect(parsed.mcpServers.github_inline_comment).toBeDefined();
    expect(parsed.mcpServers.github_inline_comment.env.GITHUB_TOKEN).toBe(
      "test-token",
    );
    expect(parsed.mcpServers.github_inline_comment.env.PR_NUMBER).toBe("456");
  });

  test("should pass RUNNER_TEMP and GITHUB_RUN_ID to the inline comment server", async () => {
    // The inline comment server derives its per-run buffer path from these.
    const result = await withEnv(
      { RUNNER_TEMP: "/runner/temp", GITHUB_RUN_ID: "987654321" },
      () =>
        prepareMcpConfig({
          githubToken: "test-token",
          owner: "test-owner",
          repo: "test-repo",
          branch: "test-branch",
          baseBranch: "main",
          allowedTools: ["mcp__github_inline_comment__create_inline_comment"],
          mode: "tag",
          context: mockPRContext,
        }),
    );

    const env = JSON.parse(result).mcpServers.github_inline_comment.env;
    expect(env.RUNNER_TEMP).toBe("/runner/temp");
    expect(env.GITHUB_RUN_ID).toBe("987654321");
    // The existing keys must survive the additions.
    expect(env.GITHUB_TOKEN).toBe("test-token");
    expect(env.REPO_OWNER).toBe("test-owner");
    expect(env.REPO_NAME).toBe("test-repo");
    expect(env.PR_NUMBER).toBe("456");
    expect(env.GITHUB_API_URL).toBeDefined();
    expect(env.CLASSIFY_INLINE_COMMENTS).toBe("true");
  });

  test("should fall back to /tmp and an empty run id for the inline comment server outside Actions", async () => {
    const result = await withEnv(
      { RUNNER_TEMP: undefined, GITHUB_RUN_ID: undefined },
      () =>
        prepareMcpConfig({
          githubToken: "test-token",
          owner: "test-owner",
          repo: "test-repo",
          branch: "test-branch",
          baseBranch: "main",
          allowedTools: ["mcp__github_inline_comment"],
          mode: "agent",
          context: mockPRContext,
        }),
    );

    const env = JSON.parse(result).mcpServers.github_inline_comment.env;
    expect(env.RUNNER_TEMP).toBe("/tmp");
    expect(env.GITHUB_RUN_ID).toBe("");
  });

  test("should surface an internal failure as a PrepareError for the mcp-config step", async () => {
    // The inline comment server reads entityNumber while building its env,
    // so a context whose entityNumber cannot be read fails inside
    // prepareMcpConfig's own logic.
    const brokenContext: ParsedGitHubContext = {
      ...mockPRContext,
      get entityNumber(): number {
        throw new Error("entity number unavailable");
      },
    };

    // Safety net only: if prepareMcpConfig ever regresses to process.exit,
    // fail this test instead of taking the whole test runner down with it.
    const originalExit = process.exit;
    process.exit = (() => {
      throw new Error("process.exit called");
    }) as typeof process.exit;

    try {
      const result = prepareMcpConfig({
        githubToken: "test-token",
        owner: "test-owner",
        repo: "test-repo",
        branch: "test-branch",
        baseBranch: "main",
        allowedTools: ["mcp__github_inline_comment"],
        mode: "tag",
        context: brokenContext,
      });

      // Throwing (rather than exiting) is what lets run.ts reach its finally
      // block and update the tracking comment.
      await expect(result).rejects.toBeInstanceOf(PrepareError);
      const error = (await result.catch((e: unknown) => e)) as PrepareError;
      expect(error.step).toBe("mcp-config");
      expect(error.message).toContain("entity number unavailable");
      expect(error.cause).toBeInstanceOf(Error);
      expect((error.cause as Error).message).toBe("entity number unavailable");
      expect(setFailedSpy).not.toHaveBeenCalled();
    } finally {
      process.exit = originalExit;
    }
  });

  test("should include comment server when no GitHub tools are allowed and signing disabled", async () => {
    const result = await prepareMcpConfig({
      githubToken: "test-token",
      owner: "test-owner",
      repo: "test-repo",
      branch: "test-branch",
      baseBranch: "main",
      allowedTools: [],
      mode: "tag",
      context: mockContext,
    });

    const parsed = JSON.parse(result);
    expect(parsed.mcpServers).toBeDefined();
    expect(parsed.mcpServers.github).not.toBeDefined();
    expect(parsed.mcpServers.github_file_ops).not.toBeDefined();
    expect(parsed.mcpServers.github_comment).toBeDefined();
  });

  test("should set GITHUB_ACTION_PATH correctly", async () => {
    process.env.GITHUB_ACTION_PATH = "/test/action/path";

    const result = await prepareMcpConfig({
      githubToken: "test-token",
      owner: "test-owner",
      repo: "test-repo",
      branch: "test-branch",
      baseBranch: "main",
      allowedTools: [],
      mode: "tag",
      context: mockContextWithSigning,
    });

    const parsed = JSON.parse(result);
    expect(parsed.mcpServers.github_file_ops.args).toContain(
      "/test/action/path/src/mcp/github-file-ops-server.ts",
    );
  });

  test("should pin bun config flags before run for every bun server", async () => {
    process.env.GITHUB_ACTION_PATH = "/test/action/path";
    process.env.DEFAULT_WORKFLOW_TOKEN = "workflow-token";

    const result = await prepareMcpConfig({
      githubToken: "test-token",
      owner: "test-owner",
      repo: "test-repo",
      branch: "test-branch",
      baseBranch: "main",
      allowedTools: ["mcp__github_inline_comment__create_inline_comment"],
      mode: "tag",
      context: {
        ...mockPRContext,
        inputs: { ...mockPRContext.inputs, useCommitSigning: true },
      },
    });

    const parsed = JSON.parse(result);
    const servers: Record<string, string> = {
      github_comment: "src/mcp/github-comment-server.ts",
      github_file_ops: "src/mcp/github-file-ops-server.ts",
      github_inline_comment: "src/mcp/github-inline-comment-server.ts",
      github_ci: "src/mcp/github-actions-server.ts",
    };

    for (const [name, script] of Object.entries(servers)) {
      expect(parsed.mcpServers[name]).toBeDefined();
      expect(parsed.mcpServers[name].command).toBe("bun");
      expect(parsed.mcpServers[name].args).toEqual([
        "--no-env-file",
        "--config=/test/action/path/bunfig.toml",
        "run",
        `/test/action/path/${script}`,
      ]);
    }

    delete process.env.DEFAULT_WORKFLOW_TOKEN;
  });

  test("should use current working directory when GITHUB_WORKSPACE is not set", async () => {
    delete process.env.GITHUB_WORKSPACE;

    const result = await prepareMcpConfig({
      githubToken: "test-token",
      owner: "test-owner",
      repo: "test-repo",
      branch: "test-branch",
      baseBranch: "main",
      allowedTools: [],
      mode: "tag",
      context: mockContextWithSigning,
    });

    const parsed = JSON.parse(result);
    expect(parsed.mcpServers.github_file_ops.env.REPO_DIR).toBe(process.cwd());
  });

  test("should include CI server when context.isPR is true and DEFAULT_WORKFLOW_TOKEN exists", async () => {
    process.env.DEFAULT_WORKFLOW_TOKEN = "workflow-token";

    const result = await prepareMcpConfig({
      githubToken: "test-token",
      owner: "test-owner",
      repo: "test-repo",
      branch: "test-branch",
      baseBranch: "main",
      allowedTools: [],
      mode: "tag",
      context: mockPRContext,
    });

    const parsed = JSON.parse(result);
    expect(parsed.mcpServers.github_ci).toBeDefined();
    expect(parsed.mcpServers.github_ci.env.GITHUB_TOKEN).toBe("workflow-token");
    expect(parsed.mcpServers.github_ci.env.PR_NUMBER).toBe("456");

    delete process.env.DEFAULT_WORKFLOW_TOKEN;
  });

  test("should not include github_ci server when context.isPR is false", async () => {
    const result = await prepareMcpConfig({
      githubToken: "test-token",
      owner: "test-owner",
      repo: "test-repo",
      branch: "test-branch",
      baseBranch: "main",
      allowedTools: [],
      mode: "tag",
      context: mockContext,
    });

    const parsed = JSON.parse(result);
    expect(parsed.mcpServers.github_ci).not.toBeDefined();
  });

  test("should not include github_ci server when actions:read permission is missing", async () => {
    process.env.DEFAULT_WORKFLOW_TOKEN = "workflow-token";
    // Simulate 403 from actions API
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ message: "Resource not accessible by integration" }),
        { status: 403 },
      ),
    );

    const result = await prepareMcpConfig({
      githubToken: "test-token",
      owner: "test-owner",
      repo: "test-repo",
      branch: "test-branch",
      baseBranch: "main",
      allowedTools: [],
      mode: "tag",
      context: mockPRContext,
    });

    const parsed = JSON.parse(result);
    expect(parsed.mcpServers.github_ci).not.toBeDefined();

    delete process.env.DEFAULT_WORKFLOW_TOKEN;
  });

  test("should not include github_ci server when DEFAULT_WORKFLOW_TOKEN is missing", async () => {
    delete process.env.DEFAULT_WORKFLOW_TOKEN;

    const result = await prepareMcpConfig({
      githubToken: "test-token",
      owner: "test-owner",
      repo: "test-repo",
      branch: "test-branch",
      baseBranch: "main",
      allowedTools: [],
      mode: "tag",
      context: mockPRContext,
    });

    const parsed = JSON.parse(result);
    expect(parsed.mcpServers.github_ci).not.toBeDefined();
  });

  test("should include github MCP server when mcp__github shorthand is used", async () => {
    const result = await prepareMcpConfig({
      githubToken: "test-token",
      owner: "test-owner",
      repo: "test-repo",
      branch: "test-branch",
      baseBranch: "main",
      allowedTools: ["mcp__github"],
      mode: "agent",
      context: mockContext,
    });

    const parsed = JSON.parse(result);
    expect(parsed.mcpServers.github).toBeDefined();
    expect(parsed.mcpServers.github.command).toBe("docker");
    expect(parsed.mcpServers.github.env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe(
      "test-token",
    );
  });

  test("should include inline comment server when mcp__github_inline_comment shorthand is used", async () => {
    const result = await prepareMcpConfig({
      githubToken: "test-token",
      owner: "test-owner",
      repo: "test-repo",
      branch: "test-branch",
      baseBranch: "main",
      allowedTools: ["mcp__github_inline_comment"],
      mode: "agent",
      context: mockPRContext,
    });

    const parsed = JSON.parse(result);
    expect(parsed.mcpServers.github_inline_comment).toBeDefined();
    expect(parsed.mcpServers.github_inline_comment.env.GITHUB_TOKEN).toBe(
      "test-token",
    );
    expect(parsed.mcpServers.github_inline_comment.env.PR_NUMBER).toBe("456");
  });

  test("should include comment server in agent mode when mcp__github_comment shorthand is used", async () => {
    const result = await prepareMcpConfig({
      githubToken: "test-token",
      owner: "test-owner",
      repo: "test-repo",
      branch: "test-branch",
      baseBranch: "main",
      allowedTools: ["mcp__github_comment"],
      mode: "agent",
      context: mockContext,
    });

    const parsed = JSON.parse(result);
    expect(parsed.mcpServers.github_comment).toBeDefined();
    expect(parsed.mcpServers.github_comment.env.GITHUB_TOKEN).toBe(
      "test-token",
    );
  });

  test("should include CI server in agent mode when mcp__github_ci shorthand is used", async () => {
    process.env.DEFAULT_WORKFLOW_TOKEN = "workflow-token";

    const result = await prepareMcpConfig({
      githubToken: "test-token",
      owner: "test-owner",
      repo: "test-repo",
      branch: "test-branch",
      baseBranch: "main",
      allowedTools: ["mcp__github_ci"],
      mode: "agent",
      context: mockPRContext,
    });

    const parsed = JSON.parse(result);
    expect(parsed.mcpServers.github_ci).toBeDefined();
    expect(parsed.mcpServers.github_ci.env.GITHUB_TOKEN).toBe("workflow-token");
    expect(parsed.mcpServers.github_ci.env.PR_NUMBER).toBe("456");

    delete process.env.DEFAULT_WORKFLOW_TOKEN;
  });

  test("should not include github MCP server when unrelated tool is specified", async () => {
    const result = await prepareMcpConfig({
      githubToken: "test-token",
      owner: "test-owner",
      repo: "test-repo",
      branch: "test-branch",
      baseBranch: "main",
      allowedTools: ["Bash", "Read", "Grep"],
      mode: "agent",
      context: mockContext,
    });

    const parsed = JSON.parse(result);
    expect(parsed.mcpServers.github).not.toBeDefined();
    expect(parsed.mcpServers.github_inline_comment).not.toBeDefined();
  });
});
