import { describe, test, expect } from "bun:test";
import {
  SPINNER_HTML,
  createJobRunLink,
  createBranchLink,
  createCommentBody,
  hasUnclosedCodeFence,
  openCodeFence,
} from "../src/github/operations/comments/common";
import { GITHUB_SERVER_URL } from "../src/github/api/config";

describe("comments/common", () => {
  describe("createJobRunLink", () => {
    test("builds a markdown link to the workflow run", () => {
      const result = createJobRunLink("anthropics", "claude-code-action", "42");
      expect(result).toBe(
        `[View job run](${GITHUB_SERVER_URL}/anthropics/claude-code-action/actions/runs/42)`,
      );
    });

    test("honors GITHUB_SERVER_URL (GHES) rather than hardcoding github.com", () => {
      // The link is built from the configured server URL, so it must point at
      // whatever GITHUB_SERVER_URL resolves to (github.com by default, a GHES
      // host in enterprise setups).
      expect(createJobRunLink("o", "r", "1")).toContain(GITHUB_SERVER_URL);
    });
  });

  describe("createBranchLink", () => {
    test("builds a leading-newline markdown link to the branch tree", () => {
      const result = createBranchLink(
        "anthropics",
        "claude-code-action",
        "feature/x",
      );
      expect(result).toBe(
        `\n[View branch](${GITHUB_SERVER_URL}/anthropics/claude-code-action/tree/feature/x)`,
      );
    });

    test("encodes URL-significant characters in a branch name", () => {
      expect(createBranchLink("o", "r", "claude/fix#123")).toBe(
        `\n[View branch](${GITHUB_SERVER_URL}/o/r/tree/claude/fix%23123)`,
      );
    });

    test("prefixes the link with a newline so it renders on its own line", () => {
      expect(createBranchLink("o", "r", "main").startsWith("\n")).toBe(true);
    });
  });

  describe("createCommentBody", () => {
    test("includes the spinner, the working message, and the job run link", () => {
      const jobRunLink = createJobRunLink("o", "r", "7");
      const body = createCommentBody(jobRunLink);

      expect(body).toContain(SPINNER_HTML);
      expect(body).toContain("Claude Code is working…");
      expect(body).toContain(jobRunLink);
    });

    test("omits the branch link when none is provided (defaults to empty)", () => {
      const body = createCommentBody(createJobRunLink("o", "r", "7"));
      expect(body).not.toContain("View branch");
      // No trailing branch content: body ends with the job run link.
      expect(body.endsWith(")")).toBe(true);
    });

    test("appends the branch link when provided", () => {
      const jobRunLink = createJobRunLink("o", "r", "7");
      const branchLink = createBranchLink("o", "r", "feature/x");
      const body = createCommentBody(jobRunLink, branchLink);

      expect(body).toContain(jobRunLink);
      expect(body).toContain(branchLink);
      // The branch link (with its leading newline) comes after the job run link.
      expect(body.indexOf(branchLink)).toBeGreaterThan(
        body.indexOf(jobRunLink),
      );
    });
  });

  describe("hasUnclosedCodeFence", () => {
    test("is false for text without fences", () => {
      expect(hasUnclosedCodeFence("")).toBe(false);
      expect(hasUnclosedCodeFence("plain\ntext")).toBe(false);
    });

    test("is true when a backtick fence is opened but never closed", () => {
      expect(hasUnclosedCodeFence('intro\n```json\n{"a": 1}')).toBe(true);
    });

    test("is false once the fence is closed again", () => {
      expect(hasUnclosedCodeFence("```\ncode\n```\nafter")).toBe(false);
    });

    test("treats an indented fence with an info string as an opener", () => {
      expect(hasUnclosedCodeFence("  ```python\nprint(1)")).toBe(true);
    });

    test("only closes a fence with the same fence character", () => {
      // A backtick line inside a tilde block is content, not a closer.
      expect(hasUnclosedCodeFence("~~~\n```\nstill inside")).toBe(true);
      expect(hasUnclosedCodeFence("~~~\n```\n~~~\noutside")).toBe(false);
    });

    test("ignores inline code spans", () => {
      expect(hasUnclosedCodeFence("use `foo()` and ``bar`` here")).toBe(false);
    });

    test("does not open a backtick fence whose info string contains a backtick", () => {
      // CommonMark: such a line is not a fence opener.
      expect(hasUnclosedCodeFence("```js `inline`\ntext")).toBe(false);
    });
  });

  describe("openCodeFence", () => {
    test("returns the exact opener so a closer of matching length can be built", () => {
      expect(openCodeFence("````md\n```\nnested example")).toBe("````");
      expect(openCodeFence("~~~\ncode")).toBe("~~~");
    });

    test("requires the closer to be at least as long as the opener", () => {
      expect(openCodeFence("````\n```\nstill open")).toBe("````");
      expect(openCodeFence("````\n`````\nclosed")).toBeNull();
    });

    test("returns null when nothing is open", () => {
      expect(openCodeFence("```\nclosed\n```")).toBeNull();
      expect(openCodeFence("no fences here")).toBeNull();
    });
  });
});
