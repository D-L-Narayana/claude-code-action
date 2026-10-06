import {
  buildTriggerRegex,
  checkContainsTrigger,
  escapeRegExp,
} from "../src/github/validation/trigger";
import { describe, it, expect } from "bun:test";
import {
  createMockContext,
  mockIssueAssignedContext,
  mockIssueLabeledContext,
  mockIssueCommentContext,
  mockIssueOpenedContext,
  mockPullRequestReviewContext,
  mockPullRequestReviewCommentContext,
} from "./mockContext";
import type {
  IssueCommentEvent,
  IssuesAssignedEvent,
  IssuesEvent,
  IssuesLabeledEvent,
  PullRequestEvent,
  PullRequestReviewEvent,
} from "@octokit/webhooks-types";
import type { ParsedGitHubContext } from "../src/github/context";

describe("checkContainsTrigger", () => {
  describe("prompt trigger", () => {
    it("should return true when prompt is provided", () => {
      const context = createMockContext({
        eventName: "issues",
        eventAction: "opened",
        inputs: {
          prompt: "Fix the bug in the login form",
          triggerPhrase: "/claude",
          assigneeTrigger: "",
          labelTrigger: "",
          branchPrefix: "claude/",
          useStickyComment: false,
          classifyInlineComments: true,
          useCommitSigning: false,
          allowedBots: "",
        },
      });
      expect(checkContainsTrigger(context)).toBe(true);
    });

    it("should return false when prompt is empty", () => {
      const context = createMockContext({
        eventName: "issues",
        eventAction: "opened",
        payload: {
          action: "opened",
          issue: {
            number: 1,
            title: "Test Issue",
            body: "Test body without trigger",
            created_at: "2023-01-01T00:00:00Z",
            user: { login: "testuser" },
          },
        } as IssuesEvent,
        inputs: {
          prompt: "",
          triggerPhrase: "/claude",
          assigneeTrigger: "",
          labelTrigger: "",
          branchPrefix: "claude/",
          useStickyComment: false,
          classifyInlineComments: true,
          useCommitSigning: false,
          allowedBots: "",
        },
      });
      expect(checkContainsTrigger(context)).toBe(false);
    });
  });

  describe("assignee trigger", () => {
    it("should return true when issue is assigned to the trigger user", () => {
      const context = mockIssueAssignedContext;
      expect(checkContainsTrigger(context)).toBe(true);
    });

    it("should add @ symbol from assignee trigger", () => {
      const context = {
        ...mockIssueAssignedContext,
        inputs: {
          ...mockIssueAssignedContext.inputs,
          assigneeTrigger: "claude-bot",
        },
      };
      expect(checkContainsTrigger(context)).toBe(true);
    });

    it("should return false when issue is assigned to a different user", () => {
      const context = {
        ...mockIssueAssignedContext,
        payload: {
          ...mockIssueAssignedContext.payload,
          assignee: {
            ...(mockIssueAssignedContext.payload as IssuesAssignedEvent)
              .assignee,
            login: "otherUser",
          },
          issue: {
            ...(mockIssueAssignedContext.payload as IssuesAssignedEvent).issue,
            assignee: {
              ...(mockIssueAssignedContext.payload as IssuesAssignedEvent).issue
                .assignee,
              login: "otherUser",
            },
          },
        },
      } as ParsedGitHubContext;

      expect(checkContainsTrigger(context)).toBe(false);
    });
  });

  describe("label trigger", () => {
    it("should return true when issue is labeled with the trigger label", () => {
      const context = mockIssueLabeledContext;
      expect(checkContainsTrigger(context)).toBe(true);
    });

    it("should return false when issue is labeled with a different label", () => {
      const context = {
        ...mockIssueLabeledContext,
        payload: {
          ...mockIssueLabeledContext.payload,
          label: {
            ...(mockIssueLabeledContext.payload as IssuesLabeledEvent).label,
            name: "bug",
          },
        },
      } as ParsedGitHubContext;
      expect(checkContainsTrigger(context)).toBe(false);
    });

    it("should return true when the labeled name differs only in case from the trigger", () => {
      const context = {
        ...mockIssueLabeledContext,
        payload: {
          ...mockIssueLabeledContext.payload,
          label: {
            ...(mockIssueLabeledContext.payload as IssuesLabeledEvent).label,
            name: "Claude-Task",
          },
        },
      } as ParsedGitHubContext;
      expect(checkContainsTrigger(context)).toBe(true);
    });

    it("should return false for non-labeled events", () => {
      const context = {
        ...mockIssueLabeledContext,
        eventAction: "opened",
        payload: {
          ...mockIssueLabeledContext.payload,
          action: "opened",
        },
      } as ParsedGitHubContext;
      expect(checkContainsTrigger(context)).toBe(false);
    });
  });

  describe("issue body and title trigger", () => {
    it("should return true when issue body contains trigger phrase", () => {
      const context = mockIssueOpenedContext;
      expect(checkContainsTrigger(context)).toBe(true);
    });

    it("should return true when issue title contains trigger phrase", () => {
      const context = {
        ...mockIssueOpenedContext,
        payload: {
          ...mockIssueOpenedContext.payload,
          issue: {
            ...(mockIssueOpenedContext.payload as IssuesEvent).issue,
            title: "/claude Fix the login bug",
            body: "The login page is broken",
          },
        },
      } as ParsedGitHubContext;
      expect(checkContainsTrigger(context)).toBe(true);
    });

    it("should handle trigger phrase with punctuation", () => {
      const baseContext = {
        ...mockIssueOpenedContext,
        inputs: {
          ...mockIssueOpenedContext.inputs,
          triggerPhrase: "@claude",
        },
      };

      // Test various punctuation marks
      const testCases = [
        { issueBody: "@claude, can you help?", expected: true },
        { issueBody: "@claude. Please look at this", expected: true },
        { issueBody: "@claude! This is urgent", expected: true },
        { issueBody: "@claude? What do you think?", expected: true },
        { issueBody: "@claude: here's the issue", expected: true },
        { issueBody: "@claude; and another thing", expected: true },
        { issueBody: "Hey @claude, can you help?", expected: true },
        { issueBody: "@Claude can you help?", expected: true },
        { issueBody: "@CLAUDE fix this", expected: true },
        { issueBody: "claudette contains claude", expected: false },
        { issueBody: "email@claude.com", expected: false },
      ];

      testCases.forEach(({ issueBody, expected }) => {
        const context = {
          ...baseContext,
          payload: {
            ...baseContext.payload,
            issue: {
              ...(baseContext.payload as IssuesEvent).issue,
              body: issueBody,
            },
          },
        } as ParsedGitHubContext;
        expect(checkContainsTrigger(context)).toBe(expected);
      });
    });

    it("should return false when trigger phrase is part of another word", () => {
      const context = {
        ...mockIssueOpenedContext,
        payload: {
          ...mockIssueOpenedContext.payload,
          issue: {
            ...(mockIssueOpenedContext.payload as IssuesEvent).issue,
            body: "claudette helped me with this",
          },
        },
      } as ParsedGitHubContext;
      expect(checkContainsTrigger(context)).toBe(false);
    });

    it("should handle trigger phrase in title with punctuation", () => {
      const baseContext = {
        ...mockIssueOpenedContext,
        inputs: {
          ...mockIssueOpenedContext.inputs,
          triggerPhrase: "@claude",
        },
      };

      const testCases = [
        { issueTitle: "@claude, can you help?", expected: true },
        { issueTitle: "@claude: Fix this bug", expected: true },
        { issueTitle: "Bug: @claude please review", expected: true },
        { issueTitle: "email@claude.com issue", expected: false },
        { issueTitle: "claudette needs help", expected: false },
      ];

      testCases.forEach(({ issueTitle, expected }) => {
        const context = {
          ...baseContext,
          payload: {
            ...baseContext.payload,
            issue: {
              ...(baseContext.payload as IssuesEvent).issue,
              title: issueTitle,
              body: "No trigger in body",
            },
          },
        } as ParsedGitHubContext;
        expect(checkContainsTrigger(context)).toBe(expected);
      });
    });
  });

  describe("pull request body and title trigger", () => {
    it("should return true when PR body contains trigger phrase", () => {
      const context = createMockContext({
        eventName: "pull_request",
        eventAction: "opened",
        isPR: true,
        payload: {
          action: "opened",
          pull_request: {
            number: 123,
            title: "Test PR",
            body: "@claude can you review this?",
            created_at: "2023-01-01T00:00:00Z",
            user: { login: "testuser" },
          },
        } as PullRequestEvent,
        inputs: {
          prompt: "",
          triggerPhrase: "@claude",
          assigneeTrigger: "",
          labelTrigger: "",
          branchPrefix: "claude/",
          useStickyComment: false,
          classifyInlineComments: true,
          useCommitSigning: false,
          allowedBots: "",
        },
      });
      expect(checkContainsTrigger(context)).toBe(true);
    });

    it("should return true when PR title contains trigger phrase", () => {
      const context = createMockContext({
        eventName: "pull_request",
        eventAction: "opened",
        isPR: true,
        payload: {
          action: "opened",
          pull_request: {
            number: 123,
            title: "@claude Review this PR",
            body: "This PR fixes a bug",
            created_at: "2023-01-01T00:00:00Z",
            user: { login: "testuser" },
          },
        } as PullRequestEvent,
        inputs: {
          prompt: "",
          triggerPhrase: "@claude",
          assigneeTrigger: "",
          labelTrigger: "",
          branchPrefix: "claude/",
          useStickyComment: false,
          classifyInlineComments: true,
          useCommitSigning: false,
          allowedBots: "",
        },
      });
      expect(checkContainsTrigger(context)).toBe(true);
    });

    it("should return false when PR body doesn't contain trigger phrase", () => {
      const context = createMockContext({
        eventName: "pull_request",
        eventAction: "opened",
        isPR: true,
        payload: {
          action: "opened",
          pull_request: {
            number: 123,
            title: "Test PR",
            body: "This PR fixes a bug",
            created_at: "2023-01-01T00:00:00Z",
            user: { login: "testuser" },
          },
        } as PullRequestEvent,
        inputs: {
          prompt: "",
          triggerPhrase: "@claude",
          assigneeTrigger: "",
          labelTrigger: "",
          branchPrefix: "claude/",
          useStickyComment: false,
          classifyInlineComments: true,
          useCommitSigning: false,
          allowedBots: "",
        },
      });
      expect(checkContainsTrigger(context)).toBe(false);
    });
  });

  describe("comment trigger", () => {
    it("should return true for issue_comment with trigger phrase", () => {
      const context = mockIssueCommentContext;
      expect(checkContainsTrigger(context)).toBe(true);
    });

    it("should return true for pull_request_review_comment with trigger phrase", () => {
      const context = mockPullRequestReviewCommentContext;
      expect(checkContainsTrigger(context)).toBe(true);
    });

    it("should return true for pull_request_review with submitted action and trigger phrase", () => {
      const context = mockPullRequestReviewContext;
      expect(checkContainsTrigger(context)).toBe(true);
    });

    it("should return true for pull_request_review with edited action and trigger phrase", () => {
      const context = {
        ...mockPullRequestReviewContext,
        eventAction: "edited",
        payload: {
          ...mockPullRequestReviewContext.payload,
          action: "edited",
        },
      } as ParsedGitHubContext;
      expect(checkContainsTrigger(context)).toBe(true);
    });

    it("should return false for pull_request_review with different action", () => {
      const context = {
        ...mockPullRequestReviewContext,
        eventAction: "dismissed",
        payload: {
          ...mockPullRequestReviewContext.payload,
          action: "dismissed",
          review: {
            ...(mockPullRequestReviewContext.payload as PullRequestReviewEvent)
              .review,
            body: "/claude please review this PR",
          },
        },
      } as ParsedGitHubContext;
      expect(checkContainsTrigger(context)).toBe(false);
    });

    it("should handle pull_request_review with punctuation", () => {
      const baseContext = {
        ...mockPullRequestReviewContext,
        inputs: {
          ...mockPullRequestReviewContext.inputs,
          triggerPhrase: "@claude",
        },
      };

      const testCases = [
        { commentBody: "@claude, please review", expected: true },
        { commentBody: "@claude. fix this", expected: true },
        { commentBody: "@claude!", expected: true },
        { commentBody: "claude@example.com", expected: false },
        { commentBody: "claudette", expected: false },
      ];

      testCases.forEach(({ commentBody, expected }) => {
        const context = {
          ...baseContext,
          payload: {
            ...baseContext.payload,
            review: {
              ...(baseContext.payload as PullRequestReviewEvent).review,
              body: commentBody,
            },
          },
        } as ParsedGitHubContext;
        expect(checkContainsTrigger(context)).toBe(expected);
      });
    });

    it("should handle comment trigger with punctuation", () => {
      const baseContext = {
        ...mockIssueCommentContext,
        inputs: {
          ...mockIssueCommentContext.inputs,
          triggerPhrase: "@claude",
        },
      };

      const testCases = [
        { commentBody: "@claude, please review", expected: true },
        { commentBody: "@claude. fix this", expected: true },
        { commentBody: "@claude!", expected: true },
        { commentBody: "claude@example.com", expected: false },
        { commentBody: "claudette", expected: false },
      ];

      testCases.forEach(({ commentBody, expected }) => {
        const context = {
          ...baseContext,
          payload: {
            ...baseContext.payload,
            comment: {
              ...(baseContext.payload as IssueCommentEvent).comment,
              body: commentBody,
            },
          },
        } as ParsedGitHubContext;
        expect(checkContainsTrigger(context)).toBe(expected);
      });
    });
  });
});

describe("escapeRegExp", () => {
  it("should escape special regex characters", () => {
    expect(escapeRegExp(".*+?^${}()|[]\\")).toBe(
      "\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\",
    );
  });

  it("should not escape regular characters", () => {
    expect(escapeRegExp("abc123")).toBe("abc123");
  });

  it("should handle mixed characters", () => {
    expect(escapeRegExp("hello.world")).toBe("hello\\.world");
    expect(escapeRegExp("test[123]")).toBe("test\\[123\\]");
  });
});

describe("buildTriggerRegex", () => {
  it("matches the phrase on its own", () => {
    expect(buildTriggerRegex("@claude").test("@claude")).toBe(true);
  });

  it("matches the phrase followed by whitespace or punctuation", () => {
    const regex = buildTriggerRegex("@claude");
    expect(regex.test("hi @claude!")).toBe(true);
    expect(regex.test("@claude: x")).toBe(true);
    expect(regex.test("@claude, please")).toBe(true);
    expect(regex.test("@claude fix this")).toBe(true);
  });

  it("does not match when the phrase is a prefix of a longer token", () => {
    const regex = buildTriggerRegex("@claude");
    expect(regex.test("@claude-bot")).toBe(false);
    expect(regex.test("@claudette")).toBe(false);
  });

  it("does not match when the phrase is embedded in an email address", () => {
    expect(buildTriggerRegex("@claude").test("email@claude.ai")).toBe(false);
  });

  it("requires whitespace or start-of-text before the phrase", () => {
    const regex = buildTriggerRegex("@claude");
    expect(regex.test("foo@claude")).toBe(false);
    expect(regex.test("\n@claude")).toBe(true);
  });

  it("is case-insensitive", () => {
    const regex = buildTriggerRegex("@claude");
    expect(regex.test("@CLAUDE fix")).toBe(true);
    expect(regex.test("@Claude")).toBe(true);
  });

  it("escapes regex metacharacters in the phrase", () => {
    const regex = buildTriggerRegex("/claude.bot");
    expect(regex.test("/claude.bot help")).toBe(true);
    expect(regex.test("/claudeXbot help")).toBe(false);
  });

  it("uses only the case-insensitive flag so repeated test() calls are stateless", () => {
    const regex = buildTriggerRegex("@claude");
    expect(regex.flags).toBe("i");
    expect(regex.test("@claude")).toBe(true);
    expect(regex.test("@claude")).toBe(true);
  });
});
