#!/usr/bin/env bun

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
  type Mock,
} from "bun:test";
import {
  DEFAULT_PROMPT_BUDGET,
  keepNewest,
  resolvePromptBudget,
  truncateText,
} from "../src/create-prompt/budget";
import type { PromptBudget } from "../src/create-prompt/budget";
import { generatePrompt } from "../src/create-prompt";
import type { PreparedContext } from "../src/create-prompt";
import type { FetchDataResult } from "../src/github/data/fetcher";
import type {
  GitHubComment,
  GitHubIssue,
  GitHubPullRequest,
  GitHubReview,
} from "../src/github/types";
import { createMockContext } from "./mockContext";

beforeAll(() => {
  process.env.GITHUB_ACTION_PATH = "/test/action/path";
});

const OMITTED_PREFIX = (count: number, noun = "comments") =>
  `[… ${count} earlier ${noun} omitted …]\n\n`;

describe("truncateText", () => {
  test("returns the text unchanged when it fits", () => {
    expect(truncateText("abc", 3, "body")).toBe("abc");
    expect(truncateText("abc", 10, "body")).toBe("abc");
    expect(truncateText("", 0, "body")).toBe("");
  });

  test("keeps a prefix and appends a marker so the result never exceeds max", () => {
    const text = "a".repeat(10_000);

    const result = truncateText(text, 1_000, "body");

    expect(result.length).toBeLessThanOrEqual(1_000);
    const marker = result.match(/\n\[… truncated (\d+) chars of body …\]$/);
    expect(marker).not.toBeNull();
    const prefix = result.slice(0, result.length - marker![0].length);
    expect(prefix).toBe(text.slice(0, prefix.length));
    expect(Number(marker![1])).toBe(text.length - prefix.length);
  });

  test("holds the bound across sizes, including digit-count boundaries", () => {
    for (const max of [100, 150, 999, 1_000, 10_000]) {
      for (const length of [max + 1, max + 50, 2 * max, 1_000_000]) {
        const text = "x".repeat(length);
        const result = truncateText(text, max, "comment");
        expect(result.length).toBeLessThanOrEqual(max);
        const marker = result.match(
          /\n\[… truncated (\d+) chars of comment …\]$/,
        );
        expect(marker).not.toBeNull();
        const prefix = result.slice(0, result.length - marker![0].length);
        expect(Number(marker![1])).toBe(length - prefix.length);
      }
    }
  });

  test("stays within max even when max is smaller than the marker", () => {
    const result = truncateText("x".repeat(50), 10, "body");
    expect(result.length).toBeLessThanOrEqual(10);
  });
});

describe("keepNewest", () => {
  test("returns everything joined in order when it fits", () => {
    expect(keepNewest(["a", "b", "c"], (s) => s, 100)).toEqual({
      text: "a\n\nb\n\nc",
      omitted: 0,
    });
  });

  // 30-char items: four of them (126 chars joined) overflow a budget sized
  // for the omitted-prefix plus the two newest (96 chars).
  const pad = (s: string) => s.padEnd(30, ".");
  const fourItems = ["old-1", "old-2", "new-1", "new-2"].map(pad);
  const newestTwo = `${pad("new-1")}\n\n${pad("new-2")}`;

  test("drops the oldest items first and reports how many were omitted", () => {
    const max = OMITTED_PREFIX(2).length + newestTwo.length;

    const result = keepNewest(fourItems, (s) => s, max);

    expect(result).toEqual({
      text: `${OMITTED_PREFIX(2)}${newestTwo}`,
      omitted: 2,
    });
    expect(result.text.length).toBeLessThanOrEqual(max);
  });

  test("counts the omitted prefix against the budget", () => {
    // One char short of fitting two items plus the prefix: a third must go.
    const max = OMITTED_PREFIX(2).length + newestTwo.length - 1;

    const result = keepNewest(fourItems, (s) => s, max);

    expect(result.omitted).toBe(3);
    expect(result.text).toBe(`${OMITTED_PREFIX(3)}${pad("new-2")}`);
    expect(result.text.length).toBeLessThanOrEqual(max);
  });

  test("renders items through the provided function", () => {
    const items = [{ body: "a" }, { body: "b" }];
    expect(keepNewest(items, (item) => `[${item.body}]`, 100)).toEqual({
      text: "[a]\n\n[b]",
      omitted: 0,
    });
  });

  test("keeps a truncated copy of the newest item when even it does not fit", () => {
    const result = keepNewest(["older", "x".repeat(500)], (s) => s, 120);

    expect(result.omitted).toBe(1);
    expect(result.text.length).toBeLessThanOrEqual(120);
    expect(result.text).toStartWith(OMITTED_PREFIX(1));
    expect(result.text).toContain("[… truncated");
  });

  test("handles an empty list", () => {
    expect(keepNewest([], (s: string) => s, 10)).toEqual({
      text: "",
      omitted: 0,
    });
  });
});

describe("resolvePromptBudget", () => {
  let warnSpy: Mock<typeof console.warn>;

  beforeEach(() => {
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  test("defaults match the documented budget", () => {
    expect(DEFAULT_PROMPT_BUDGET).toEqual({
      maxTotalChars: 300_000,
      maxBodyChars: 40_000,
      maxCommentChars: 10_000,
      maxCommentsChars: 120_000,
      maxReviewsChars: 120_000,
      maxDiffHunkChars: 2_000,
      maxChangedFiles: 300,
    });
  });

  test("returns the defaults when CLAUDE_PROMPT_MAX_CHARS is unset or empty", () => {
    expect(resolvePromptBudget({})).toEqual(DEFAULT_PROMPT_BUDGET);
    expect(resolvePromptBudget({ CLAUDE_PROMPT_MAX_CHARS: "" })).toEqual(
      DEFAULT_PROMPT_BUDGET,
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("scales every field down proportionally", () => {
    expect(resolvePromptBudget({ CLAUDE_PROMPT_MAX_CHARS: "150000" })).toEqual({
      maxTotalChars: 150_000,
      maxBodyChars: 20_000,
      maxCommentChars: 5_000,
      maxCommentsChars: 60_000,
      maxReviewsChars: 60_000,
      maxDiffHunkChars: 1_000,
      maxChangedFiles: 150,
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("scales every field up proportionally", () => {
    expect(resolvePromptBudget({ CLAUDE_PROMPT_MAX_CHARS: "600000" })).toEqual({
      maxTotalChars: 600_000,
      maxBodyChars: 80_000,
      maxCommentChars: 20_000,
      maxCommentsChars: 240_000,
      maxReviewsChars: 240_000,
      maxDiffHunkChars: 4_000,
      maxChangedFiles: 600,
    });
  });

  test("floors fractional results without floating-point drift", () => {
    expect(resolvePromptBudget({ CLAUDE_PROMPT_MAX_CHARS: "100000" })).toEqual({
      maxTotalChars: 100_000,
      maxBodyChars: 13_333,
      maxCommentChars: 3_333,
      maxCommentsChars: 40_000,
      maxReviewsChars: 40_000,
      maxDiffHunkChars: 666,
      maxChangedFiles: 100,
    });
  });

  test("applies the minimums: 100 chars per text field and 1 changed file", () => {
    expect(resolvePromptBudget({ CLAUDE_PROMPT_MAX_CHARS: "300" })).toEqual({
      maxTotalChars: 300,
      maxBodyChars: 100,
      maxCommentChars: 100,
      maxCommentsChars: 120,
      maxReviewsChars: 120,
      maxDiffHunkChars: 100,
      maxChangedFiles: 1,
    });
  });

  test.each(["abc", "-5", "0", "1.5", "1e5", "NaN"])(
    "warns and falls back to the defaults for the invalid value %p",
    (value) => {
      expect(resolvePromptBudget({ CLAUDE_PROMPT_MAX_CHARS: value })).toEqual(
        DEFAULT_PROMPT_BUDGET,
      );
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("CLAUDE_PROMPT_MAX_CHARS"),
      );
    },
  );

  test("reads process.env by default", () => {
    const previous = process.env.CLAUDE_PROMPT_MAX_CHARS;
    process.env.CLAUDE_PROMPT_MAX_CHARS = "150000";
    try {
      expect(resolvePromptBudget().maxTotalChars).toBe(150_000);
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_PROMPT_MAX_CHARS;
      } else {
        process.env.CLAUDE_PROMPT_MAX_CHARS = previous;
      }
    }
  });
});

describe("generatePrompt applies the budget end to end", () => {
  const issueCommentContext: PreparedContext = {
    repository: "owner/repo",
    claudeCommentId: "12345",
    triggerPhrase: "@claude",
    eventData: {
      eventName: "issue_comment",
      commentId: "67890",
      isPR: false,
      baseBranch: "main",
      claudeBranch: "claude/issue-1-20240101-1200",
      issueNumber: "1",
      commentBody: "@claude please summarize this thread",
    },
  };

  const prCommentContext: PreparedContext = {
    repository: "owner/repo",
    claudeCommentId: "12345",
    triggerPhrase: "@claude",
    eventData: {
      eventName: "issue_comment",
      commentId: "67890",
      isPR: true,
      prNumber: "99",
      commentBody: "@claude review this",
    },
  };

  function makeIssueData(
    body: string,
    comments: GitHubComment[] = [],
  ): FetchDataResult {
    const contextData: GitHubIssue = {
      title: "Big issue",
      body,
      author: { login: "author" },
      createdAt: "2024-01-01T00:00:00Z",
      state: "OPEN",
      labels: { nodes: [] },
      comments: { nodes: comments },
    };
    return {
      contextData,
      comments,
      changedFiles: [],
      changedFilesWithSHA: [],
      reviewData: null,
      imageUrlMap: new Map(),
    };
  }

  function makePrData(
    overrides: Partial<Omit<FetchDataResult, "contextData">> = {},
  ): FetchDataResult {
    const contextData: GitHubPullRequest = {
      title: "Big PR",
      body: "PR body",
      author: { login: "author" },
      baseRefName: "main",
      headRefName: "feature",
      headRefOid: "abc123",
      isCrossRepository: false,
      headRepository: { owner: { login: "owner" }, name: "repo" },
      createdAt: "2024-01-01T00:00:00Z",
      additions: 1,
      deletions: 1,
      state: "OPEN",
      labels: { nodes: [] },
      commits: { totalCount: 1, nodes: [] },
      files: { nodes: [] },
      comments: { nodes: [] },
      reviews: { nodes: [] },
    };
    return {
      contextData,
      comments: [],
      changedFiles: [],
      changedFilesWithSHA: [],
      reviewData: { nodes: [] },
      imageUrlMap: new Map(),
      ...overrides,
    };
  }

  function makeComments(count: number, filler: string): GitHubComment[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `c${i}`,
      databaseId: String(i),
      body: `Comment number ${i} ${filler}`,
      author: { login: "user" },
      createdAt: new Date(Date.UTC(2024, 0, 1, 0, i)).toISOString(),
    }));
  }

  function makeReviews(count: number, filler: string): GitHubReview[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `r${i}`,
      databaseId: String(1_000 + i),
      author: { login: "reviewer" },
      body: `Review number ${i} ${filler}`,
      state: "COMMENTED",
      submittedAt: new Date(Date.UTC(2024, 0, 2, 0, i)).toISOString(),
      comments: { nodes: [] },
    }));
  }

  test("caps a 1,000,000-char body so the whole prompt fits the default budget", () => {
    const prompt = generatePrompt(
      issueCommentContext,
      makeIssueData("b".repeat(1_000_000)),
      false,
      "tag",
    );

    expect(prompt.length).toBeLessThanOrEqual(
      DEFAULT_PROMPT_BUDGET.maxTotalChars,
    );
    expect(prompt).toContain("[… truncated");
    // The instruction tail is never truncated.
    expect(prompt).toContain(
      "IMPORTANT: Use the mcp__github_comment__update_claude_comment tool",
    );
    expect(prompt).toContain("CAPABILITIES AND LIMITATIONS");
    expect(prompt).toContain(
      "Before taking any action, conduct your analysis inside <analysis> tags",
    );
    expect(prompt).toContain(
      "<trigger_comment>\n@claude please summarize this thread\n</trigger_comment>",
    );
  });

  test("honors an explicit budget passed as the trailing parameter", () => {
    const budget: PromptBudget = {
      ...DEFAULT_PROMPT_BUDGET,
      maxBodyChars: 500,
    };

    const prompt = generatePrompt(
      issueCommentContext,
      makeIssueData("b".repeat(5_000)),
      false,
      "tag",
      budget,
    );

    expect(prompt).toContain("chars of body …]");
    expect(prompt).not.toContain("b".repeat(501));
  });

  test("sanitizes before truncating so a cut-off HTML comment cannot leak", () => {
    const body =
      "v".repeat(400) +
      "<!-- hidden instructions " +
      "w".repeat(5_000) +
      " -->";

    const prompt = generatePrompt(
      issueCommentContext,
      makeIssueData(body),
      false,
      "tag",
      { ...DEFAULT_PROMPT_BUDGET, maxBodyChars: 500 },
    );

    expect(prompt).not.toContain("hidden instructions");
    expect(prompt).toContain("v".repeat(400));
  });

  test("truncates each comment body to maxCommentChars", () => {
    const comments = makeComments(1, "q".repeat(20_000));

    const prompt = generatePrompt(
      issueCommentContext,
      makeIssueData("short body", comments),
      false,
      "tag",
      { ...DEFAULT_PROMPT_BUDGET, maxCommentChars: 1_000 },
    );

    expect(prompt).toContain("chars of comment …]");
    expect(prompt).not.toContain("q".repeat(1_001));
  });

  test("keeps the newest comments and drops the oldest when the section overflows", () => {
    const comments = makeComments(50, "z".repeat(2_000));

    const prompt = generatePrompt(
      issueCommentContext,
      makeIssueData("short body", comments),
      false,
      "tag",
      { ...DEFAULT_PROMPT_BUDGET, maxCommentsChars: 10_000 },
    );

    expect(prompt).toContain("Comment number 49 ");
    expect(prompt).not.toContain("Comment number 0 ");
    expect(prompt).toMatch(/\[… \d+ earlier comments omitted …\]/);
  });

  test("keeps the newest reviews and drops the oldest when the section overflows", () => {
    const prompt = generatePrompt(
      prCommentContext,
      makePrData({ reviewData: { nodes: makeReviews(30, "y".repeat(3_000)) } }),
      false,
      "tag",
      { ...DEFAULT_PROMPT_BUDGET, maxReviewsChars: 10_000 },
    );

    expect(prompt).toContain("Review number 29 ");
    expect(prompt).not.toContain("Review number 0 ");
    expect(prompt).toMatch(/\[… \d+ earlier reviews omitted …\]/);
  });

  test("truncates each diff hunk to maxDiffHunkChars", () => {
    const review: GitHubReview = {
      id: "r1",
      databaseId: "1001",
      author: { login: "reviewer" },
      body: "",
      state: "COMMENTED",
      submittedAt: "2024-01-02T00:00:00Z",
      comments: {
        nodes: [
          {
            id: "rc1",
            databaseId: "2001",
            body: "Look here",
            author: { login: "reviewer" },
            createdAt: "2024-01-02T00:00:00Z",
            path: "src/a.ts",
            line: 1,
            diffHunk: "@@ -1 +1 @@\n" + "+".repeat(10_000),
          },
        ],
      },
    };

    const prompt = generatePrompt(
      prCommentContext,
      makePrData({ reviewData: { nodes: [review] } }),
      false,
      "tag",
      { ...DEFAULT_PROMPT_BUDGET, maxDiffHunkChars: 2_000 },
    );

    expect(prompt).toContain("[Comment on src/a.ts:1]: Look here");
    expect(prompt).toContain("chars of diff hunk …]");
    expect(prompt).not.toContain("+".repeat(2_001));
  });

  test("caps the changed-files list at maxChangedFiles with a trailing count", () => {
    const changedFilesWithSHA = Array.from({ length: 400 }, (_, i) => ({
      path: `src/file-${i}.ts`,
      additions: 1,
      deletions: 0,
      changeType: "MODIFIED",
      sha: "abc123",
    }));

    const prompt = generatePrompt(
      prCommentContext,
      makePrData({ changedFilesWithSHA }),
      false,
      "tag",
      { ...DEFAULT_PROMPT_BUDGET, maxChangedFiles: 300 },
    );

    expect(prompt).toContain("- src/file-299.ts (MODIFIED) +1/-0 SHA: abc123");
    expect(prompt).not.toContain("- src/file-300.ts ");
    expect(prompt).toContain("[… 100 more files …]");
  });

  test("cuts the context block, never the instruction tail, when sections together exceed the total", () => {
    // Body and comments each fit their own caps; together they overflow a
    // total sized just above the instruction tail.
    const comments = makeComments(5, "k".repeat(3_000));

    const prompt = generatePrompt(
      issueCommentContext,
      makeIssueData("b".repeat(8_000), comments),
      false,
      "tag",
      { ...DEFAULT_PROMPT_BUDGET, maxTotalChars: 25_000 },
    );

    expect(prompt.length).toBeLessThanOrEqual(25_000);
    expect(prompt).toContain("chars of context …]");
    // Earlier sections survive; the cut lands at the end of the context block.
    expect(prompt).toContain("b".repeat(8_000));
    expect(prompt).toContain(
      "<trigger_comment>\n@claude please summarize this thread\n</trigger_comment>",
    );
    expect(prompt).toContain(
      "IMPORTANT: Use the mcp__github_comment__update_claude_comment tool",
    );
    expect(prompt).toContain("CAPABILITIES AND LIMITATIONS");
    expect(prompt).toContain(
      "Before taking any action, conduct your analysis inside <analysis> tags",
    );
  });

  test("bounds the simplified prompt (USE_SIMPLE_PROMPT) the same way", () => {
    const previous = process.env.USE_SIMPLE_PROMPT;
    process.env.USE_SIMPLE_PROMPT = "true";
    try {
      const prompt = generatePrompt(
        issueCommentContext,
        makeIssueData("b".repeat(1_000_000)),
        false,
        "tag",
      );

      expect(prompt.length).toBeLessThanOrEqual(
        DEFAULT_PROMPT_BUDGET.maxTotalChars,
      );
      expect(prompt).toContain("You were tagged on a GitHub issue");
      expect(prompt).toContain("[… truncated");
      expect(prompt).toContain("Always include at the bottom:");
      expect(prompt).toContain(
        "<trigger_comment>\n@claude please summarize this thread\n</trigger_comment>",
      );
    } finally {
      if (previous === undefined) {
        delete process.env.USE_SIMPLE_PROMPT;
      } else {
        process.env.USE_SIMPLE_PROMPT = previous;
      }
    }
  });

  test("counts custom instructions toward the total so they are never cut", () => {
    const customInstructions = `Custom rule: ${"r".repeat(2_000)}`;
    const context: PreparedContext = {
      ...issueCommentContext,
      githubContext: createMockContext({
        inputs: { prompt: customInstructions },
      }),
    };

    const prompt = generatePrompt(
      context,
      makeIssueData("b".repeat(1_000_000)),
      false,
      "tag",
    );

    expect(prompt.length).toBeLessThanOrEqual(
      DEFAULT_PROMPT_BUDGET.maxTotalChars,
    );
    expect(prompt).toContain(
      `<custom_instructions>\n${customInstructions}\n</custom_instructions>`,
    );
    expect(prompt).toContain("CAPABILITIES AND LIMITATIONS");
  });

  test("leaves prompts that already fit untouched", () => {
    const prompt = generatePrompt(
      issueCommentContext,
      makeIssueData("A short body", makeComments(2, "")),
      false,
      "tag",
    );

    expect(prompt).not.toContain("[… truncated");
    expect(prompt).not.toContain("earlier comments omitted");
    expect(prompt).toContain("Comment number 0 ");
    expect(prompt).toContain("Comment number 1 ");
  });
});
