import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  spyOn,
  mock,
  type Mock,
} from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as branchCleanup from "../src/github/operations/branch-cleanup";
import { updateCommentLink } from "../src/entrypoints/update-comment-link";
import type { Octokits } from "../src/github/api/client";
import { GITHUB_SERVER_URL } from "../src/github/api/config";
import { GITHUB_COMMENT_MAX_LENGTH } from "../src/github/constants";
import {
  mockIssueCommentContext,
  mockPullRequestReviewCommentContext,
} from "./mockContext";

const RUN_ID = "987654321";
const WORKING_BODY =
  'Claude Code is working… <img src="spinner.gif" />\n\nI\'ll analyze this and get back to you.\n\n[View job run](https://github.com/test-owner/test-repo/actions/runs/1)';

type FakeOctokitOptions = {
  issueCommentBody?: string;
  reviewCommentBody?: string;
  getCommentError?: Error;
  totalCommits?: number;
};

function createFakeOctokit(options: FakeOctokitOptions = {}) {
  const getComment = mock(async (params: { comment_id: number }) => {
    if (options.getCommentError) throw options.getCommentError;
    return {
      data: { id: params.comment_id, body: options.issueCommentBody ?? "" },
    };
  });
  const updateComment = mock(
    async (params: { comment_id: number; body: string }) => ({
      data: {
        id: params.comment_id,
        html_url: `${GITHUB_SERVER_URL}/test-owner/test-repo/issues/55#issuecomment-${params.comment_id}`,
        updated_at: "2024-01-15T12:00:00Z",
      },
    }),
  );
  const getReviewComment = mock(async (params: { comment_id: number }) => ({
    data: { id: params.comment_id, body: options.reviewCommentBody ?? "" },
  }));
  const updateReviewComment = mock(
    async (params: { comment_id: number; body: string }) => ({
      data: {
        id: params.comment_id,
        html_url: `${GITHUB_SERVER_URL}/test-owner/test-repo/pull/999#discussion_r${params.comment_id}`,
        updated_at: "2024-01-15T12:00:00Z",
      },
    }),
  );
  const get = mock(async (_params: { pull_number: number }) => ({
    data: { state: "open", comments: 1, review_comments: 0 },
  }));
  const compareCommitsWithBasehead = mock(
    async (_params: { basehead: string }) => ({
      data: { total_commits: options.totalCommits ?? 0, files: [] },
    }),
  );

  const api = {
    issues: { getComment, updateComment },
    pulls: { getReviewComment, updateReviewComment, get },
    repos: { compareCommitsWithBasehead },
  };
  // `Octokits.rest` is an Octokit instance. The code under test reaches the
  // endpoint namespaces both directly on it (`octokit.rest.pulls.get`) and
  // through the instance's own `rest` property (`updateClaudeComment` is
  // handed `octokit.rest` and calls `.rest.issues.updateComment`), so the fake
  // instance exposes the same namespaces at both levels.
  const octokit = { rest: { ...api, rest: api } } as unknown as Octokits;

  return {
    octokit,
    getComment,
    updateComment,
    getReviewComment,
    updateReviewComment,
    get,
    compareCommitsWithBasehead,
  };
}

function baseParams(octokit: Octokits) {
  return {
    commentId: 100,
    githubToken: "test-token",
    baseBranch: "main",
    triggerUsername: "contributor-user",
    context: mockIssueCommentContext,
    octokit,
    claudeSuccess: true,
    prepareSuccess: true,
    useCommitSigning: false,
  };
}

describe("updateCommentLink", () => {
  const originalRunId = process.env.GITHUB_RUN_ID;
  let tempDir: string;
  let cleanupSpy: Mock<typeof branchCleanup.checkAndCommitOrDeleteBranch>;
  let consoleLogSpy: Mock<typeof console.log>;
  let consoleErrorSpy: Mock<typeof console.error>;

  beforeAll(() => {
    process.env.GITHUB_RUN_ID = RUN_ID;
    tempDir = mkdtempSync(join(tmpdir(), "update-comment-link-"));
  });

  afterAll(() => {
    if (originalRunId === undefined) {
      delete process.env.GITHUB_RUN_ID;
    } else {
      process.env.GITHUB_RUN_ID = originalRunId;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // checkAndCommitOrDeleteBranch shells out to git; it is stubbed so these
    // tests only exercise the comment update logic.
    cleanupSpy = spyOn(
      branchCleanup,
      "checkAndCommitOrDeleteBranch",
    ).mockResolvedValue({ shouldDeleteBranch: false, branchLink: "" });
    consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanupSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  test("rewrites the tracking comment with the finished header and job link on success", async () => {
    const fake = createFakeOctokit({ issueCommentBody: WORKING_BODY });

    await updateCommentLink(baseParams(fake.octokit));

    expect(fake.getComment).toHaveBeenCalledWith({
      owner: "test-owner",
      repo: "test-repo",
      comment_id: 100,
    });
    expect(fake.updateComment).toHaveBeenCalledTimes(1);
    const body = fake.updateComment.mock.calls[0]?.[0]?.body ?? "";
    expect(body.startsWith("**Claude finished @contributor-user's task")).toBe(
      true,
    );
    expect(body).toContain(
      `[View job](${GITHUB_SERVER_URL}/test-owner/test-repo/actions/runs/${RUN_ID})`,
    );
    expect(body).not.toContain("Claude Code is working");
    expect(body).not.toContain("View job run");
    expect(fake.updateReviewComment).not.toHaveBeenCalled();
  });

  test("reports a prepare failure with the redacted error in a code block", async () => {
    const token = "ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
    const fake = createFakeOctokit({ issueCommentBody: WORKING_BODY });

    await updateCommentLink({
      ...baseParams(fake.octokit),
      prepareSuccess: false,
      prepareError: `Authentication failed for test-owner/test-repo using token ${token}`,
    });

    const body = fake.updateComment.mock.calls[0]?.[0]?.body ?? "";
    expect(body.startsWith("**Claude encountered an error")).toBe(true);
    expect(body).toContain(
      "```\nAuthentication failed for test-owner/test-repo using token [REDACTED_GITHUB_TOKEN]\n```",
    );
    expect(body).not.toContain(token);
    expect(fake.updateComment).toHaveBeenCalledTimes(1);
  });

  test("reports an execution failure with the duration read from the output file", async () => {
    const outputFile = join(tempDir, "execution-output.json");
    writeFileSync(
      outputFile,
      JSON.stringify([
        { type: "system", subtype: "init" },
        {
          type: "result",
          total_cost_usd: 0.0123,
          duration_ms: 65000,
          duration_api_ms: 60000,
        },
      ]),
    );
    const fake = createFakeOctokit({ issueCommentBody: WORKING_BODY });

    await updateCommentLink({
      ...baseParams(fake.octokit),
      claudeSuccess: false,
      outputFile,
    });

    const body = fake.updateComment.mock.calls[0]?.[0]?.body ?? "";
    expect(body.startsWith("**Claude encountered an error after 1m 5s**")).toBe(
      true,
    );
    expect(body).toContain(
      `[View job](${GITHUB_SERVER_URL}/test-owner/test-repo/actions/runs/${RUN_ID})`,
    );
  });

  test("adds the branch and Create PR links when the Claude branch has commits", async () => {
    const claudeBranch = "claude/issue-55-20240101-1200";
    const branchUrl = `${GITHUB_SERVER_URL}/test-owner/test-repo/tree/${claudeBranch}`;
    cleanupSpy.mockResolvedValue({
      shouldDeleteBranch: false,
      branchLink: `\n[View branch](${branchUrl})`,
    });
    const fake = createFakeOctokit({
      issueCommentBody: WORKING_BODY,
      totalCommits: 2,
    });

    await updateCommentLink({
      ...baseParams(fake.octokit),
      claudeBranch,
    });

    expect(cleanupSpy).toHaveBeenCalledWith(
      fake.octokit,
      "test-owner",
      "test-repo",
      claudeBranch,
      "main",
      false,
      [],
    );
    expect(fake.compareCommitsWithBasehead).toHaveBeenCalledWith({
      owner: "test-owner",
      repo: "test-repo",
      basehead: `main...${claudeBranch}`,
    });
    const body = fake.updateComment.mock.calls[0]?.[0]?.body ?? "";
    expect(body).toContain(`[\`${claudeBranch}\`](${branchUrl})`);
    // updateCommentBody renders the "[Create a PR](...)" link built here as
    // the "Create PR ➔" header link pointing at the quick-pull compare URL.
    expect(body).toContain(
      `[Create PR ➔](${GITHUB_SERVER_URL}/test-owner/test-repo/compare/main...${claudeBranch}?quick_pull=1&title=Issue%20%2355`,
    );
  });

  test("omits the branch and Create PR links when the empty branch is being deleted", async () => {
    const claudeBranch = "claude/issue-55-20240101-1200";
    cleanupSpy.mockResolvedValue({ shouldDeleteBranch: true, branchLink: "" });
    const fake = createFakeOctokit({
      issueCommentBody: WORKING_BODY,
      totalCommits: 0,
    });

    await updateCommentLink({
      ...baseParams(fake.octokit),
      claudeBranch,
    });

    expect(fake.compareCommitsWithBasehead).not.toHaveBeenCalled();
    const body = fake.updateComment.mock.calls[0]?.[0]?.body ?? "";
    expect(body).not.toContain("Create PR");
    expect(body).not.toContain("Create a PR");
    expect(body).not.toContain(claudeBranch);
    expect(body.startsWith("**Claude finished @contributor-user's task")).toBe(
      true,
    );
  });

  test("uses the pull request review comment API for pull_request_review_comment events", async () => {
    const fake = createFakeOctokit({ reviewCommentBody: WORKING_BODY });

    await updateCommentLink({
      ...baseParams(fake.octokit),
      commentId: 500,
      triggerUsername: "code-reviewer",
      context: mockPullRequestReviewCommentContext,
    });

    expect(fake.getReviewComment).toHaveBeenCalledWith({
      owner: "test-owner",
      repo: "test-repo",
      comment_id: 500,
    });
    expect(fake.getComment).not.toHaveBeenCalled();
    expect(fake.updateReviewComment).toHaveBeenCalledTimes(1);
    expect(fake.updateComment).not.toHaveBeenCalled();
    const body = fake.updateReviewComment.mock.calls[0]?.[0]?.body ?? "";
    expect(body.startsWith("**Claude finished @code-reviewer's task")).toBe(
      true,
    );
    expect(body).toContain(`/actions/runs/${RUN_ID}`);
  });

  test("logs pull request debug info and rethrows when the comment cannot be fetched", async () => {
    const fake = createFakeOctokit({
      getCommentError: new Error("Not Found"),
    });

    await expect(updateCommentLink(baseParams(fake.octokit))).rejects.toThrow(
      "Not Found",
    );

    expect(fake.get).toHaveBeenCalledWith({
      owner: "test-owner",
      repo: "test-repo",
      pull_number: 55,
    });
    expect(fake.updateComment).not.toHaveBeenCalled();
  });

  test("keeps the final body within the GitHub comment limit when the tracked body is oversized", async () => {
    // Claude's progress updates can grow the tracking comment close to the
    // limit; adding the header on top must not turn the final PATCH into a 422.
    const fake = createFakeOctokit({
      issueCommentBody: WORKING_BODY + "\n\n" + "x".repeat(70_000),
    });

    await updateCommentLink(baseParams(fake.octokit));

    expect(fake.updateComment).toHaveBeenCalledTimes(1);
    const body = fake.updateComment.mock.calls[0]?.[0]?.body ?? "";
    expect(body.length).toBeLessThanOrEqual(GITHUB_COMMENT_MAX_LENGTH);
    expect(body.startsWith("**Claude finished @contributor-user's task")).toBe(
      true,
    );
    expect(body).toContain(
      `[View job](${GITHUB_SERVER_URL}/test-owner/test-repo/actions/runs/${RUN_ID})`,
    );
    expect(body).toMatch(/…\[truncated \d+ characters\]…/);
  });
});
