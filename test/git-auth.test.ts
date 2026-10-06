import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as core from "@actions/core";
import * as gitConfig from "../src/github/operations/git-config";
import * as actor from "../src/github/validation/actor";
import * as createInitial from "../src/github/operations/comments/create-initial";
import * as fetcher from "../src/github/data/fetcher";
import * as branch from "../src/github/operations/branch";
import * as createPrompt from "../src/create-prompt";
import * as mcp from "../src/mcp/install-mcp-server";
import {
  configureGitAuthForMode,
  resolveGitAuthStrategy,
} from "../src/modes/shared/git-auth";
import { prepareAgentMode } from "../src/modes/agent";
import { prepareTagMode } from "../src/modes/tag";
import { PrepareError } from "../src/utils/prepare-error";
import type { GitHubContext } from "../src/github/context";
import {
  createMockAutomationContext,
  createMockContext,
  mockIssueCommentContext,
} from "./mockContext";

const TEST_KEY =
  "-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----";
const TOKEN = "ghs_testtoken1234567890abcdef";

// git diagnostics as printed when the action runs without actions/checkout
const NOT_A_REPO =
  "fatal: not a git repository (or any of the parent directories): .git";
const NOT_IN_GIT_DIR = "fatal: not in a git directory";
const LOCAL_OUTSIDE_REPO =
  "fatal: --local can only be used inside a git repository";
// ...and one that has nothing to do with a missing checkout
const NO_USERNAME =
  "fatal: could not read Username for 'https://github.com': No such device or address";

// Bun's `$` rejects with a ShellError whose message is only "Failed with exit
// code N"; git's diagnostic lives in `stderr`. Mirror that shape so the policy
// is exercised against what the real git-config helpers actually throw.
function gitFailure(stderr: string): Error {
  return Object.assign(new Error("Failed with exit code 128"), {
    exitCode: 128,
    stderr: Buffer.from(`${stderr}\n`),
  });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("git-auth", () => {
  let calls: string[];
  let setupSshSigningSpy: Mock<typeof gitConfig.setupSshSigning>;
  let configureGitAuthSpy: Mock<typeof gitConfig.configureGitAuth>;
  let replaceCheckoutCredentialsSpy: Mock<
    typeof gitConfig.replaceCheckoutCredentials
  >;
  let warningSpy: Mock<typeof core.warning>;

  beforeEach(() => {
    calls = [];
    setupSshSigningSpy = spyOn(gitConfig, "setupSshSigning").mockImplementation(
      async () => {
        calls.push("setupSshSigning");
      },
    );
    configureGitAuthSpy = spyOn(
      gitConfig,
      "configureGitAuth",
    ).mockImplementation(async () => {
      calls.push("configureGitAuth");
    });
    replaceCheckoutCredentialsSpy = spyOn(
      gitConfig,
      "replaceCheckoutCredentials",
    ).mockImplementation(async () => {
      calls.push("replaceCheckoutCredentials");
    });
    warningSpy = spyOn(core, "warning").mockImplementation(() => {});
  });

  afterEach(() => {
    setupSshSigningSpy.mockRestore();
    configureGitAuthSpy.mockRestore();
    replaceCheckoutCredentialsSpy.mockRestore();
    warningSpy.mockRestore();
  });

  describe("resolveGitAuthStrategy", () => {
    test("ssh_signing_key takes precedence over use_commit_signing", () => {
      expect(
        resolveGitAuthStrategy({
          sshSigningKey: TEST_KEY,
          useCommitSigning: true,
        }),
      ).toBe("ssh-signing");
    });

    test("ssh_signing_key alone selects SSH signing", () => {
      expect(
        resolveGitAuthStrategy({
          sshSigningKey: TEST_KEY,
          useCommitSigning: false,
        }),
      ).toBe("ssh-signing");
    });

    test("use_commit_signing without a key selects API commit signing", () => {
      expect(
        resolveGitAuthStrategy({ sshSigningKey: "", useCommitSigning: true }),
      ).toBe("api-commit-signing");
    });

    test("neither option selects the plain git CLI", () => {
      expect(
        resolveGitAuthStrategy({ sshSigningKey: "", useCommitSigning: false }),
      ).toBe("git-cli");
    });
  });

  describe.each(["tag", "agent"] as const)(
    "configureGitAuthForMode (%s mode)",
    (mode) => {
      const configure = (context: GitHubContext) =>
        configureGitAuthForMode({ context, githubToken: TOKEN, mode });

      test("plain git CLI: configures the git user and the credential", async () => {
        const context = createMockAutomationContext();

        await configure(context);

        expect(configureGitAuthSpy).toHaveBeenCalledTimes(1);
        expect(configureGitAuthSpy).toHaveBeenCalledWith(TOKEN, context, {
          login: context.inputs.botName,
          id: Number(context.inputs.botId),
        });
        expect(setupSshSigningSpy).not.toHaveBeenCalled();
        expect(replaceCheckoutCredentialsSpy).not.toHaveBeenCalled();
      });

      test("SSH signing: writes the key, then configures git auth, even if use_commit_signing is also set", async () => {
        const context = createMockAutomationContext({
          inputs: { sshSigningKey: TEST_KEY, useCommitSigning: true },
        });

        await configure(context);

        expect(setupSshSigningSpy).toHaveBeenCalledTimes(1);
        expect(setupSshSigningSpy).toHaveBeenCalledWith(TEST_KEY);
        expect(configureGitAuthSpy).toHaveBeenCalledWith(TOKEN, context, {
          login: context.inputs.botName,
          id: Number(context.inputs.botId),
        });
        expect(calls).toEqual(["setupSshSigning", "configureGitAuth"]);
        expect(replaceCheckoutCredentialsSpy).not.toHaveBeenCalled();
      });

      test("API commit signing: only replaces the checkout credential", async () => {
        const context = createMockAutomationContext({
          inputs: { useCommitSigning: true },
        });

        await configure(context);

        expect(replaceCheckoutCredentialsSpy).toHaveBeenCalledTimes(1);
        expect(replaceCheckoutCredentialsSpy).toHaveBeenCalledWith(
          TOKEN,
          context,
        );
        expect(configureGitAuthSpy).not.toHaveBeenCalled();
        expect(setupSshSigningSpy).not.toHaveBeenCalled();
      });

      test("rejects a non-numeric bot_id before touching git", async () => {
        const context = createMockAutomationContext({
          inputs: { botId: "claude" },
        });

        const error = await rejection(configure(context));

        expect(error).toBeInstanceOf(PrepareError);
        expect((error as PrepareError).step).toBe("git-auth");
        expect((error as PrepareError).message).toBe(
          "bot_id must be a numeric GitHub user id (got 'claude')",
        );
        expect(configureGitAuthSpy).not.toHaveBeenCalled();
        expect(setupSshSigningSpy).not.toHaveBeenCalled();
      });

      test("an unusable SSH key fails the git-auth step", async () => {
        setupSshSigningSpy.mockImplementation(async () => {
          throw new Error("Invalid SSH private key format");
        });
        const context = createMockAutomationContext({
          inputs: { sshSigningKey: "not a key" },
        });

        const error = await rejection(configure(context));

        expect(error).toBeInstanceOf(PrepareError);
        expect((error as PrepareError).step).toBe("git-auth");
        expect((error as PrepareError).message).toContain(
          "Invalid SSH private key format",
        );
        expect(configureGitAuthSpy).not.toHaveBeenCalled();
        expect(warningSpy).not.toHaveBeenCalled();
      });

      test("surfaces git's stderr in the failure and redacts the token", async () => {
        configureGitAuthSpy.mockImplementation(async () => {
          throw gitFailure(
            `fatal: unable to access 'https://x-access-token:${TOKEN}@github.com/o/r.git/': Could not resolve host: github.com`,
          );
        });

        const error = await rejection(configure(createMockAutomationContext()));

        expect(error).toBeInstanceOf(PrepareError);
        expect((error as PrepareError).step).toBe("git-auth");
        expect((error as PrepareError).message).toContain(
          "Could not resolve host: github.com",
        );
        expect((error as PrepareError).message).not.toContain(TOKEN);
      });
    },
  );

  describe("tag mode failure policy", () => {
    test("a missing checkout is a hard failure", async () => {
      configureGitAuthSpy.mockImplementation(async () => {
        throw gitFailure(NOT_A_REPO);
      });

      const error = await rejection(
        configureGitAuthForMode({
          context: createMockContext(),
          githubToken: TOKEN,
          mode: "tag",
        }),
      );

      expect(error).toBeInstanceOf(PrepareError);
      expect((error as PrepareError).step).toBe("git-auth");
      expect((error as PrepareError).message).toContain("not a git repository");
      expect(warningSpy).not.toHaveBeenCalled();
    });

    test("any other git failure is a hard failure", async () => {
      configureGitAuthSpy.mockImplementation(async () => {
        throw gitFailure(NO_USERNAME);
      });

      const error = await rejection(
        configureGitAuthForMode({
          context: createMockContext(),
          githubToken: TOKEN,
          mode: "tag",
        }),
      );

      expect(error).toBeInstanceOf(PrepareError);
      expect((error as PrepareError).step).toBe("git-auth");
      expect((error as PrepareError).message).toContain(
        "could not read Username",
      );
    });
  });

  describe("agent mode failure policy", () => {
    const configure = (
      context: GitHubContext = createMockAutomationContext(),
    ) =>
      configureGitAuthForMode({ context, githubToken: TOKEN, mode: "agent" });

    test.each([NOT_A_REPO, NOT_IN_GIT_DIR, LOCAL_OUTSIDE_REPO])(
      "continues with a warning when git reports %s",
      async (stderr) => {
        configureGitAuthSpy.mockImplementation(async () => {
          throw gitFailure(stderr);
        });

        await expect(configure()).resolves.toBeUndefined();

        expect(warningSpy).toHaveBeenCalledTimes(1);
        const warning = String(warningSpy.mock.calls[0]?.[0]);
        expect(warning).toContain(stderr);
        expect(warning).toContain("actions/checkout");
      },
    );

    test("any other failure to configure git auth is a hard failure", async () => {
      configureGitAuthSpy.mockImplementation(async () => {
        throw gitFailure(NO_USERNAME);
      });

      const error = await rejection(configure());

      expect(error).toBeInstanceOf(PrepareError);
      expect((error as PrepareError).step).toBe("git-auth");
      expect((error as PrepareError).message).toContain(
        "could not read Username",
      );
      expect(warningSpy).not.toHaveBeenCalled();
    });

    test("failing to replace the checkout credential is a hard failure", async () => {
      replaceCheckoutCredentialsSpy.mockImplementation(async () => {
        throw new Error("EACCES: permission denied, open '.git/config'");
      });

      const error = await rejection(
        configure(
          createMockAutomationContext({ inputs: { useCommitSigning: true } }),
        ),
      );

      expect(error).toBeInstanceOf(PrepareError);
      expect((error as PrepareError).step).toBe("git-auth");
      expect((error as PrepareError).message).toContain("EACCES");
      expect(warningSpy).not.toHaveBeenCalled();
    });

    test("a missing checkout on the API commit signing path is only a warning", async () => {
      replaceCheckoutCredentialsSpy.mockImplementation(async () => {
        throw gitFailure(NOT_A_REPO);
      });

      await expect(
        configure(
          createMockAutomationContext({ inputs: { useCommitSigning: true } }),
        ),
      ).resolves.toBeUndefined();

      expect(warningSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("prepare functions", () => {
    let runnerTemp: string;
    let originalRunnerTemp: string | undefined;
    let originalClaudeArgs: string | undefined;
    let spies: Array<{ mockRestore: () => void }>;

    beforeEach(() => {
      originalRunnerTemp = process.env.RUNNER_TEMP;
      originalClaudeArgs = process.env.CLAUDE_ARGS;
      runnerTemp = mkdtempSync(join(tmpdir(), "git-auth-test-"));
      process.env.RUNNER_TEMP = runnerTemp;
      delete process.env.CLAUDE_ARGS;
      spies = [
        spyOn(actor, "checkHumanActor").mockImplementation(async () => {}),
        spyOn(mcp, "prepareMcpConfig").mockImplementation(async () => "{}"),
        spyOn(createInitial, "createInitialComment").mockImplementation(
          async () => ({ id: 42 }) as never,
        ),
        spyOn(fetcher, "fetchGitHubData").mockImplementation(
          async () => ({}) as never,
        ),
        spyOn(branch, "setupBranch").mockImplementation(
          async () =>
            ({
              baseBranch: "main",
              claudeBranch: "claude/test",
              currentBranch: "claude/test",
            }) as never,
        ),
        spyOn(createPrompt, "createPrompt").mockImplementation(async () => {}),
      ];
    });

    afterEach(() => {
      for (const spy of spies) {
        spy.mockRestore();
      }
      rmSync(runnerTemp, { recursive: true, force: true });
      if (originalRunnerTemp === undefined) {
        delete process.env.RUNNER_TEMP;
      } else {
        process.env.RUNNER_TEMP = originalRunnerTemp;
      }
      if (originalClaudeArgs === undefined) {
        delete process.env.CLAUDE_ARGS;
      } else {
        process.env.CLAUDE_ARGS = originalClaudeArgs;
      }
    });

    test("prepareAgentMode fails the prepare step when git auth cannot be configured", async () => {
      configureGitAuthSpy.mockImplementation(async () => {
        throw gitFailure(NO_USERNAME);
      });

      const error = await rejection(
        prepareAgentMode({
          context: createMockAutomationContext(),
          octokit: {} as never,
          githubToken: TOKEN,
        }),
      );

      expect(error).toBeInstanceOf(PrepareError);
      expect((error as PrepareError).step).toBe("git-auth");
      expect(warningSpy).not.toHaveBeenCalled();
    });

    test("prepareAgentMode continues with a warning when there is no checkout", async () => {
      configureGitAuthSpy.mockImplementation(async () => {
        throw gitFailure(NOT_A_REPO);
      });

      const result = await prepareAgentMode({
        context: createMockAutomationContext(),
        octokit: {} as never,
        githubToken: TOKEN,
      });

      expect(result.commentId).toBeUndefined();
      expect(result.branchInfo.baseBranch).toBe("main");
      expect(warningSpy).toHaveBeenCalledTimes(1);
    });

    test("prepareAgentMode rejects a non-numeric bot_id", async () => {
      const error = await rejection(
        prepareAgentMode({
          context: createMockAutomationContext({ inputs: { botId: "abc" } }),
          octokit: {} as never,
          githubToken: TOKEN,
        }),
      );

      expect(error).toBeInstanceOf(PrepareError);
      expect((error as PrepareError).step).toBe("git-auth");
      expect(configureGitAuthSpy).not.toHaveBeenCalled();
    });

    test("prepareTagMode fails the prepare step with a git-auth PrepareError", async () => {
      configureGitAuthSpy.mockImplementation(async () => {
        throw gitFailure(NO_USERNAME);
      });

      const error = await rejection(
        prepareTagMode({
          context: { ...mockIssueCommentContext },
          octokit: {} as never,
          githubToken: TOKEN,
        }),
      );

      expect(error).toBeInstanceOf(PrepareError);
      expect((error as PrepareError).step).toBe("git-auth");
      expect((error as PrepareError).message).toContain(
        "could not read Username",
      );
    });

    test("prepareTagMode rejects a non-numeric bot_id", async () => {
      const error = await rejection(
        prepareTagMode({
          context: {
            ...mockIssueCommentContext,
            inputs: { ...mockIssueCommentContext.inputs, botId: "abc" },
          },
          octokit: {} as never,
          githubToken: TOKEN,
        }),
      );

      expect(error).toBeInstanceOf(PrepareError);
      expect((error as PrepareError).step).toBe("git-auth");
      expect(configureGitAuthSpy).not.toHaveBeenCalled();
    });
  });
});
