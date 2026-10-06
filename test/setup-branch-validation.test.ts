import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { setupBranch } from "../src/github/operations/branch";
import { PrepareError } from "../src/utils/prepare-error";
import { createMockContext } from "./mockContext";

const octokits = {
  rest: {
    repos: { get: async () => ({ data: { default_branch: "main" } }) },
    git: { getRef: async () => ({ data: { object: { sha: "abc1234" } } }) },
  },
} as any;

const githubData = {
  contextData: { title: "Add feature", labels: { nodes: [] } },
} as any;

// ':' is rejected by validateBranchName. The signing path used to skip that
// check and only fail on the file ops server's first commit (a 422).
const INVALID_TEMPLATE = "{{prefix}}release:{{entityNumber}}";

describe("setupBranch generated branch name validation", () => {
  let originalCwd: string;
  let tempDir: string;
  // Safety net only: should setupBranch ever regress to process.exit(1), fail
  // the assertions below instead of taking the whole test runner down.
  let originalExit: typeof process.exit;

  beforeEach(() => {
    originalCwd = process.cwd();
    // Not a git repo, so the remote existence probe fails and setupBranch
    // continues with the generated name.
    tempDir = mkdtempSync(join("/tmp", "setup-branch-"));
    process.chdir(tempDir);

    originalExit = process.exit;
    process.exit = (() => {
      throw new Error("process.exit called");
    }) as typeof process.exit;
  });

  afterEach(() => {
    process.exit = originalExit;
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  for (const useCommitSigning of [true, false]) {
    test(`rejects an invalid generated branch name with use_commit_signing: ${useCommitSigning}`, async () => {
      const context = createMockContext({
        isPR: false,
        entityNumber: 42,
        inputs: {
          useCommitSigning,
          branchPrefix: "claude/",
          branchNameTemplate: INVALID_TEMPLATE,
        },
      });

      const result = setupBranch(octokits, githubData, context);

      // Throwing (rather than exiting) is what lets run.ts reach its finally
      // block and update the tracking comment.
      await expect(result).rejects.toBeInstanceOf(PrepareError);
      const error = (await result.catch((e: unknown) => e)) as PrepareError;
      expect(error.step).toBe("branch");
      // Must fail on the name itself, not on a later git or API call.
      expect(error.message).toContain(
        'Invalid branch name: "claude/release:42"',
      );
      expect(error.cause).toBeInstanceOf(Error);
    });
  }
});
