/**
 * Claude Code CLI installation for the action entrypoint.
 *
 * The installer is a `curl | bash` pipeline with no progress contract, so a
 * stalled download used to hang the job until the runner's own timeout. Every
 * attempt now has its own deadline, and the version pin lives here so the
 * entrypoint and the install command cannot drift apart.
 */

import { spawn as spawnChildProcess } from "child_process";
import { appendFile } from "fs/promises";
import { dirname } from "path";

export const CLAUDE_CODE_VERSION = "2.1.283";

// `set -o pipefail` makes curl's non-zero exit propagate through the pipe so
// the install retry logic actually triggers on 429/403 instead of silently
// succeeding (see #1136).
export function buildInstallCommand(version: string): string {
  return `set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash -s -- ${version}`;
}

export type InstallOptions = {
  version?: string;
  attempts?: number;
  timeoutMs?: number;
  backoffMs?: number;
  customExecutable?: string;
  spawnFn?: typeof import("child_process").spawn;
  env?: NodeJS.ProcessEnv;
  appendPath?: (dir: string) => Promise<void>;
};

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_BACKOFF_MS = 5_000;
// How long a timed-out installer gets to honour SIGTERM before SIGKILL.
const KILL_GRACE_MS = 10_000;

// Newlines and other control characters in the executable path would let a
// crafted value smuggle extra entries into GITHUB_PATH.
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs one installer process. The attempt fails if the process exits
 * non-zero, cannot be spawned, or is still running after `timeoutMs`.
 */
function runInstallAttempt(
  spawnFn: typeof spawnChildProcess,
  command: string,
  attempt: number,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawnFn("bash", ["-c", command], { stdio: "inherit" });
    let closed = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;

    const deadline = setTimeout(() => {
      child.kill("SIGTERM");
      // The attempt is over once the deadline passes; escalating to SIGKILL
      // is best-effort cleanup that must not keep the process alive.
      escalation = setTimeout(() => {
        if (!closed) child.kill("SIGKILL");
      }, KILL_GRACE_MS);
      escalation.unref();
      reject(
        new Error(`Install attempt ${attempt} timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);

    child.on("close", (code) => {
      closed = true;
      clearTimeout(deadline);
      if (escalation) clearTimeout(escalation);
      if (code === 0) resolve();
      else reject(new Error(`Install failed with exit code ${code}`));
    });
    child.on("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
  });
}

/**
 * Install the Claude Code CLI, or register a user-supplied executable, and
 * return the absolute path to the `claude` binary.
 *
 * The binary's directory is appended to $GITHUB_PATH (for later workflow
 * steps) and prepended to PATH of the current process.
 */
export async function installClaudeCode(
  options: InstallOptions = {},
): Promise<string> {
  const env = options.env ?? process.env;
  const appendPath =
    options.appendPath ??
    (async (dir: string) => {
      const githubPath = env.GITHUB_PATH;
      if (githubPath) {
        await appendFile(githubPath, `${dir}\n`);
      }
    });
  const registerBinDir = async (dir: string) => {
    await appendPath(dir);
    env.PATH = `${dir}:${env.PATH}`;
  };

  const customExecutable =
    options.customExecutable ?? env.PATH_TO_CLAUDE_CODE_EXECUTABLE;
  if (customExecutable) {
    if (CONTROL_CHARACTERS.test(customExecutable)) {
      throw new Error(
        "PATH_TO_CLAUDE_CODE_EXECUTABLE contains control characters (e.g. newlines), which is not allowed",
      );
    }
    console.log(`Using custom Claude Code executable: ${customExecutable}`);
    await registerBinDir(dirname(customExecutable));
    return customExecutable;
  }

  const version = options.version ?? CLAUDE_CODE_VERSION;
  const attempts = Math.max(
    1,
    Math.floor(options.attempts ?? DEFAULT_ATTEMPTS),
  );
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const spawnFn = options.spawnFn ?? spawnChildProcess;
  const command = buildInstallCommand(version);

  console.log(`Installing Claude Code v${version}...`);

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    console.log(`Installation attempt ${attempt}...`);
    try {
      await runInstallAttempt(spawnFn, command, attempt, timeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        console.log(
          `Installation attempt ${attempt} failed (${error}), retrying in ${backoffMs}ms...`,
        );
        await sleep(backoffMs);
      }
      continue;
    }

    console.log("Claude Code installed successfully");
    const homeBin = `${env.HOME}/.local/bin`;
    await registerBinDir(homeBin);
    return `${homeBin}/claude`;
  }

  throw new Error(
    `Failed to install Claude Code after ${attempts} attempts: ${lastError}`,
  );
}
