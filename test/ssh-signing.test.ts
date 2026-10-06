import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import type { Mock } from "bun:test";
import { execFileSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import {
  cleanupSshSigning,
  setupSshSigning,
} from "../src/github/operations/git-config";

const TEST_KEY =
  "-----BEGIN OPENSSH PRIVATE KEY-----\ntest-key-content\n-----END OPENSSH PRIVATE KEY-----";

// git exports these into hooks (e.g. a pre-commit hook running the test
// suite); if inherited they would point every git command below at the
// enclosing repository instead of the temp repo.
const GIT_ENV_OVERRIDES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_PREFIX",
] as const;

// The suite points setupSshSigning at a throw-away home directory; nothing it
// does may reach the real one. Remember whether a key was already there so the
// safety net in afterAll never deletes a developer's own file.
const REAL_KEY_PATH = join(homedir(), ".ssh", "claude_signing_key");
const realKeyExistedBefore = existsSync(REAL_KEY_PATH);

describe("SSH signing", () => {
  let originalCwd: string;
  let tempDir: string;
  let repoDir: string;
  let homeDir: string;
  let sshDir: string;
  let keyPath: string;
  let originalGitEnv: Record<string, string | undefined>;
  let consoleLogSpy: Mock<typeof console.log>;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalGitEnv = {};
    for (const name of GIT_ENV_OVERRIDES) {
      originalGitEnv[name] = process.env[name];
      delete process.env[name];
    }

    tempDir = mkdtempSync(join(tmpdir(), "ssh-signing-test-"));
    repoDir = join(tempDir, "repo");
    homeDir = join(tempDir, "home");
    sshDir = join(homeDir, ".ssh");
    keyPath = join(sshDir, "claude_signing_key");
    mkdirSync(homeDir, { recursive: true });
    git(["init", repoDir]);
    // setupSshSigning configures the repository in the current directory
    process.chdir(repoDir);

    consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    consoleLogSpy.mockRestore();
    for (const name of GIT_ENV_OVERRIDES) {
      if (originalGitEnv[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = originalGitEnv[name];
      }
    }
  });

  afterAll(() => {
    // Safety net: a regression that ignores the injected home directory would
    // otherwise leave test key material in the real one.
    if (!realKeyExistedBefore) {
      rmSync(REAL_KEY_PATH, { force: true });
    }
  });

  describe("setupSshSigning", () => {
    test("writes the key with mode 0600 inside a 0700 .ssh directory under the given home", async () => {
      await setupSshSigning(TEST_KEY, homeDir);

      expect(existsSync(sshDir)).toBe(true);
      expect(statSync(sshDir).mode & 0o777).toBe(0o700);
      expect(existsSync(keyPath)).toBe(true);
      expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    });

    test("appends the trailing newline ssh-keygen needs when the key lacks one", async () => {
      await setupSshSigning(TEST_KEY, homeDir);

      expect(existsSync(keyPath)).toBe(true);
      expect(readFileSync(keyPath, "utf8")).toBe(`${TEST_KEY}\n`);
    });

    test("does not double the trailing newline when the key already has one", async () => {
      await setupSshSigning(`${TEST_KEY}\n`, homeDir);

      expect(existsSync(keyPath)).toBe(true);
      expect(readFileSync(keyPath, "utf8")).toBe(`${TEST_KEY}\n`);
    });

    test("configures the repository to sign commits with the written key", async () => {
      await setupSshSigning(TEST_KEY, homeDir);

      expect(localConfig("gpg.format")).toBe("ssh");
      expect(localConfig("user.signingkey")).toBe(keyPath);
      expect(localConfig("commit.gpgsign")).toBe("true");
    });

    test.each([
      ["an empty key", "", "SSH signing key cannot be empty"],
      ["a whitespace-only key", "   \n\t  ", "SSH signing key cannot be empty"],
      [
        "a key without a PEM header",
        "not a valid key",
        "Invalid SSH private key format",
      ],
      [
        "a public key",
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample user@host",
        "Invalid SSH private key format",
      ],
    ])(
      "rejects %s without writing a file or touching git config",
      async (_label, key, message) => {
        await expect(setupSshSigning(key, homeDir)).rejects.toThrow(message);

        expect(existsSync(keyPath)).toBe(false);
        expect(localConfig("gpg.format")).toBe("");
        expect(localConfig("user.signingkey")).toBe("");
        expect(localConfig("commit.gpgsign")).toBe("");
      },
    );
  });

  describe("cleanupSshSigning", () => {
    test("removes the key written by setupSshSigning", async () => {
      await setupSshSigning(TEST_KEY, homeDir);
      expect(existsSync(keyPath)).toBe(true);

      await cleanupSshSigning(homeDir);

      expect(existsSync(keyPath)).toBe(false);
    });

    test("tolerates a missing key and a missing .ssh directory", async () => {
      await expect(cleanupSshSigning(homeDir)).resolves.toBeUndefined();
      await expect(
        cleanupSshSigning(join(tempDir, "never-created")),
      ).resolves.toBeUndefined();
    });
  });

  // Pass an explicit env copy: unlike bun's `$`, execFileSync does not pick up
  // deletions from process.env, so the GIT_* overrides removed in beforeEach
  // would otherwise still reach the child process.
  function git(args: string[], cwd?: string): string {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env },
    }).trim();
  }

  function localConfig(key: string): string {
    try {
      return git(["config", "--local", "--get", key], repoDir);
    } catch {
      return "";
    }
  }
});
