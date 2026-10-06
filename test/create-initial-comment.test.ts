import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  spyOn,
  mock,
  type Mock,
} from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as core from "@actions/core";
import type { Octokit } from "@octokit/rest";
import { createInitialComment } from "../src/github/operations/comments/create-initial";
import {
  createCommentBody,
  createJobRunLink,
} from "../src/github/operations/comments/common";
import { CLAUDE_GITHUB_APP_USER_ID } from "../src/github/constants";
import {
  mockIssueCommentContext,
  mockPullRequestOpenedContext,
  mockPullRequestReviewCommentContext,
} from "./mockContext";

type ExistingComment = {
  id: number;
  body: string;
  user: { id: number; login: string; type: string };
};

type FakeOctokitOptions = {
  existingComments?: ExistingComment[];
  replyError?: Error;
  createError?: Error;
};

function createFakeOctokit(options: FakeOctokitOptions = {}) {
  const listComments = mock(async (_params: { issue_number: number }) => ({
    data: options.existingComments ?? [],
  }));
  const updateComment = mock(
    async (params: { comment_id: number; body: string }) => ({
      data: { id: params.comment_id, body: params.body },
    }),
  );
  const createComment = mock(
    async (params: { issue_number: number; body: string }) => {
      if (options.createError) throw options.createError;
      return { data: { id: 777, body: params.body } };
    },
  );
  const createReplyForReviewComment = mock(
    async (params: {
      pull_number: number;
      comment_id: number;
      body: string;
    }) => {
      if (options.replyError) throw options.replyError;
      return { data: { id: 888, body: params.body } };
    },
  );

  const octokit = {
    rest: {
      issues: { listComments, updateComment, createComment },
      pulls: { createReplyForReviewComment },
    },
  } as unknown as Octokit;

  return {
    octokit,
    listComments,
    updateComment,
    createComment,
    createReplyForReviewComment,
  };
}

const expectedInitialBody = createCommentBody(
  createJobRunLink("test-owner", "test-repo", "1234567890"),
);

describe("createInitialComment", () => {
  const originalGithubOutput = process.env.GITHUB_OUTPUT;
  let setOutputSpy: Mock<typeof core.setOutput>;
  let consoleLogSpy: Mock<typeof console.log>;
  let consoleErrorSpy: Mock<typeof console.error>;
  let tempDir: string;

  beforeEach(() => {
    setOutputSpy = spyOn(core, "setOutput").mockImplementation(() => {});
    consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
    tempDir = mkdtempSync(join(tmpdir(), "create-initial-comment-"));
  });

  afterEach(() => {
    setOutputSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    rmSync(tempDir, { recursive: true, force: true });
    if (originalGithubOutput === undefined) {
      delete process.env.GITHUB_OUTPUT;
    } else {
      process.env.GITHUB_OUTPUT = originalGithubOutput;
    }
  });

  describe("when GITHUB_OUTPUT points at a file", () => {
    beforeEach(() => {
      const outputFile = join(tempDir, "github_output");
      writeFileSync(outputFile, "");
      process.env.GITHUB_OUTPUT = outputFile;
    });

    test("creates an issue comment and publishes its id through core.setOutput", async () => {
      const fake = createFakeOctokit();

      const result = await createInitialComment(
        fake.octokit,
        mockIssueCommentContext,
      );

      expect(fake.createComment).toHaveBeenCalledTimes(1);
      expect(fake.createComment).toHaveBeenCalledWith({
        owner: "test-owner",
        repo: "test-repo",
        issue_number: 55,
        body: expectedInitialBody,
      });
      expect(result.id).toBe(777);
      expect(setOutputSpy).toHaveBeenCalledWith("claude_comment_id", "777");
    });

    test("updates the existing sticky comment authored by the Claude app user id instead of creating one", async () => {
      const fake = createFakeOctokit({
        existingComments: [
          {
            id: 11,
            body: "Unrelated comment",
            user: { id: 1, login: "someone", type: "User" },
          },
          {
            // Login deliberately does not contain "claude" so only the user id
            // can match: that is the constant under test.
            id: 22,
            body: "Previous status",
            user: {
              id: CLAUDE_GITHUB_APP_USER_ID,
              login: "some-app[bot]",
              type: "Bot",
            },
          },
        ],
      });
      const context = {
        ...mockPullRequestOpenedContext,
        inputs: {
          ...mockPullRequestOpenedContext.inputs,
          useStickyComment: true,
        },
      };

      const result = await createInitialComment(fake.octokit, context);

      expect(fake.listComments).toHaveBeenCalledWith({
        owner: "test-owner",
        repo: "test-repo",
        issue_number: 456,
      });
      expect(fake.updateComment).toHaveBeenCalledTimes(1);
      expect(fake.updateComment).toHaveBeenCalledWith({
        owner: "test-owner",
        repo: "test-repo",
        comment_id: 22,
        body: expectedInitialBody,
      });
      expect(fake.createComment).not.toHaveBeenCalled();
      expect(result.id).toBe(22);
      expect(setOutputSpy).toHaveBeenCalledWith("claude_comment_id", "22");
    });

    test("creates a new comment on a pull request when no sticky comment exists yet", async () => {
      const fake = createFakeOctokit({ existingComments: [] });
      const context = {
        ...mockPullRequestOpenedContext,
        inputs: {
          ...mockPullRequestOpenedContext.inputs,
          useStickyComment: true,
        },
      };

      await createInitialComment(fake.octokit, context);

      expect(fake.updateComment).not.toHaveBeenCalled();
      expect(fake.createComment).toHaveBeenCalledWith({
        owner: "test-owner",
        repo: "test-repo",
        issue_number: 456,
        body: expectedInitialBody,
      });
      expect(setOutputSpy).toHaveBeenCalledWith("claude_comment_id", "777");
    });

    test("replies in the review thread for pull_request_review_comment events", async () => {
      const fake = createFakeOctokit();

      const result = await createInitialComment(
        fake.octokit,
        mockPullRequestReviewCommentContext,
      );

      expect(fake.createReplyForReviewComment).toHaveBeenCalledTimes(1);
      expect(fake.createReplyForReviewComment).toHaveBeenCalledWith({
        owner: "test-owner",
        repo: "test-repo",
        pull_number: 999,
        comment_id: 99988877,
        body: expectedInitialBody,
      });
      expect(fake.createComment).not.toHaveBeenCalled();
      expect(result.id).toBe(888);
      expect(setOutputSpy).toHaveBeenCalledWith("claude_comment_id", "888");
    });

    test("falls back to a plain issue comment when the primary call throws", async () => {
      const fake = createFakeOctokit({
        replyError: new Error("review thread is locked"),
      });

      const result = await createInitialComment(
        fake.octokit,
        mockPullRequestReviewCommentContext,
      );

      expect(fake.createReplyForReviewComment).toHaveBeenCalledTimes(1);
      expect(fake.createComment).toHaveBeenCalledTimes(1);
      expect(fake.createComment).toHaveBeenCalledWith({
        owner: "test-owner",
        repo: "test-repo",
        issue_number: 999,
        body: expectedInitialBody,
      });
      expect(result.id).toBe(777);
      expect(setOutputSpy).toHaveBeenCalledWith("claude_comment_id", "777");
    });

    test("rethrows when the fallback comment also fails", async () => {
      const fake = createFakeOctokit({
        replyError: new Error("review thread is locked"),
        createError: new Error("fallback boom"),
      });

      await expect(
        createInitialComment(fake.octokit, mockPullRequestReviewCommentContext),
      ).rejects.toThrow("fallback boom");
      expect(setOutputSpy).not.toHaveBeenCalled();
    });
  });

  describe("when GITHUB_OUTPUT is unset", () => {
    beforeEach(() => {
      delete process.env.GITHUB_OUTPUT;
    });

    test("still creates the comment and publishes its id without throwing", async () => {
      const fake = createFakeOctokit();

      await expect(
        createInitialComment(fake.octokit, mockIssueCommentContext),
      ).resolves.toMatchObject({ id: 777 });

      expect(fake.createComment).toHaveBeenCalledTimes(1);
      expect(setOutputSpy).toHaveBeenCalledWith("claude_comment_id", "777");
    });
  });
});
