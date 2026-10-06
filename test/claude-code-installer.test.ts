import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { EventEmitter } from "events";
import type { ChildProcess, spawn } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  CLAUDE_CODE_VERSION,
  buildInstallCommand,
  installClaudeCode,
} from "../src/install/claude-code-installer";

type ChildBehavior =
  | { kind: "exit"; code: number }
  | { kind: "spawn-error" }
  // A hung installer never closes on its own. With exitOnKill it behaves like
  // a process that honours SIGTERM; without it, like one that ignores it.
  | { kind: "hang"; exitOnKill: boolean };

// Just enough of a ChildProcess for installClaudeCode: close/error events and
// kill(), with the outcome scripted per spawn.
class FakeChild extends EventEmitter {
  readonly killSignals: Array<NodeJS.Signals | number | undefined> = [];
  private readonly behavior: ChildBehavior;

  constructor(behavior: ChildBehavior) {
    super();
    this.behavior = behavior;
    if (behavior.kind === "exit") {
      setTimeout(() => this.emit("close", behavior.code, null), 0);
    } else if (behavior.kind === "spawn-error") {
      setTimeout(() => this.emit("error", new Error("spawn bash ENOENT")), 0);
    }
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    if (this.behavior.kind === "hang" && this.behavior.exitOnKill) {
      setTimeout(() => this.emit("close", null, signal ?? "SIGTERM"), 0);
    }
    return true;
  }
}

type SpawnCall = { command: string; args: readonly string[]; options: unknown };

function scriptedSpawn(behaviors: ChildBehavior[]) {
  const children: FakeChild[] = [];
  const calls: SpawnCall[] = [];
  const spawnFn = ((
    command: string,
    args: readonly string[],
    options: unknown,
  ) => {
    calls.push({ command, args, options });
    const behavior = behaviors[children.length];
    if (!behavior) {
      throw new Error(`unexpected spawn call #${children.length + 1}`);
    }
    const child = new FakeChild(behavior);
    children.push(child);
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawn;
  return { spawnFn, children, calls };
}

function baseEnv(): NodeJS.ProcessEnv {
  return { HOME: "/home/runner", PATH: "/usr/bin" };
}

function noopAppend() {
  return mock(async (_dir: string) => {});
}

const EXPECTED_BIN = "/home/runner/.local/bin";
const EXPECTED_EXECUTABLE = `${EXPECTED_BIN}/claude`;

describe("installClaudeCode", () => {
  let logSpy: { mockRestore(): void };

  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  test("pins the Claude Code version", () => {
    expect(CLAUDE_CODE_VERSION).toBe("2.1.283");
  });

  test("returns the installed binary and registers its directory on success", async () => {
    const { spawnFn, calls } = scriptedSpawn([{ kind: "exit", code: 0 }]);
    const env = baseEnv();
    const appendPath = noopAppend();

    await expect(
      installClaudeCode({ spawnFn, env, appendPath, backoffMs: 0 }),
    ).resolves.toBe(EXPECTED_EXECUTABLE);

    expect(calls).toEqual([
      {
        command: "bash",
        args: ["-c", buildInstallCommand(CLAUDE_CODE_VERSION)],
        options: { stdio: "inherit" },
      },
    ]);
    expect(appendPath).toHaveBeenCalledTimes(1);
    expect(appendPath).toHaveBeenCalledWith(EXPECTED_BIN);
    expect(env.PATH).toBe(`${EXPECTED_BIN}:/usr/bin`);
  });

  test("installs the requested version", async () => {
    const { spawnFn, calls } = scriptedSpawn([{ kind: "exit", code: 0 }]);

    await expect(
      installClaudeCode({
        spawnFn,
        env: baseEnv(),
        appendPath: noopAppend(),
        backoffMs: 0,
        version: "9.9.9",
      }),
    ).resolves.toBe(EXPECTED_EXECUTABLE);

    expect(calls[0]?.args).toEqual(["-c", buildInstallCommand("9.9.9")]);
    expect(calls[0]?.args[1]).toContain("bash -s -- 9.9.9");
  });

  test("appends the bin directory to GITHUB_PATH by default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-installer-"));
    try {
      const githubPath = join(dir, "github_path");
      const env: NodeJS.ProcessEnv = { ...baseEnv(), GITHUB_PATH: githubPath };
      const { spawnFn } = scriptedSpawn([{ kind: "exit", code: 0 }]);

      await expect(
        installClaudeCode({ spawnFn, env, backoffMs: 0 }),
      ).resolves.toBe(EXPECTED_EXECUTABLE);

      expect(readFileSync(githubPath, "utf8")).toBe(`${EXPECTED_BIN}\n`);
      expect(env.PATH).toBe(`${EXPECTED_BIN}:/usr/bin`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("retries a failed attempt and succeeds on a later one", async () => {
    const { spawnFn, calls } = scriptedSpawn([
      { kind: "exit", code: 1 },
      { kind: "exit", code: 0 },
    ]);
    const appendPath = noopAppend();

    await expect(
      installClaudeCode({
        spawnFn,
        env: baseEnv(),
        appendPath,
        backoffMs: 0,
      }),
    ).resolves.toBe(EXPECTED_EXECUTABLE);

    expect(calls).toHaveLength(2);
    expect(appendPath).toHaveBeenCalledTimes(1);
  });

  test("treats a spawn error as a failed attempt", async () => {
    const { spawnFn, calls } = scriptedSpawn([
      { kind: "spawn-error" },
      { kind: "exit", code: 0 },
    ]);

    await expect(
      installClaudeCode({
        spawnFn,
        env: baseEnv(),
        appendPath: noopAppend(),
        backoffMs: 0,
      }),
    ).resolves.toBe(EXPECTED_EXECUTABLE);

    expect(calls).toHaveLength(2);
  });

  test("gives up after the configured number of attempts", async () => {
    const { spawnFn, calls } = scriptedSpawn([
      { kind: "exit", code: 1 },
      { kind: "exit", code: 2 },
      { kind: "exit", code: 1 },
    ]);
    const appendPath = noopAppend();

    await expect(
      installClaudeCode({
        spawnFn,
        env: baseEnv(),
        appendPath,
        backoffMs: 0,
      }),
    ).rejects.toThrow(
      "Failed to install Claude Code after 3 attempts: Error: Install failed with exit code 1",
    );

    expect(calls).toHaveLength(3);
    expect(appendPath).not.toHaveBeenCalled();
  });

  test("kills an installer that hangs past timeoutMs and counts the attempt as failed", async () => {
    const { spawnFn, children } = scriptedSpawn([
      { kind: "hang", exitOnKill: true },
      { kind: "exit", code: 0 },
    ]);

    await expect(
      installClaudeCode({
        spawnFn,
        env: baseEnv(),
        appendPath: noopAppend(),
        attempts: 2,
        backoffMs: 0,
        timeoutMs: 50,
      }),
    ).resolves.toBe(EXPECTED_EXECUTABLE);

    expect(children).toHaveLength(2);
    // Terminated gracefully: SIGKILL is only for children that ignore SIGTERM.
    expect(children[0]?.killSignals).toEqual(["SIGTERM"]);
    expect(children[1]?.killSignals).toEqual([]);
  });

  test("fails a timed-out attempt even when the child ignores SIGTERM", async () => {
    const { spawnFn, children } = scriptedSpawn([
      { kind: "hang", exitOnKill: false },
    ]);

    await expect(
      installClaudeCode({
        spawnFn,
        env: baseEnv(),
        appendPath: noopAppend(),
        attempts: 1,
        backoffMs: 0,
        timeoutMs: 50,
      }),
    ).rejects.toThrow(
      "Failed to install Claude Code after 1 attempts: Error: Install attempt 1 timed out after 50ms",
    );

    expect(children[0]?.killSignals).toEqual(["SIGTERM"]);
    // A late exit after the attempt was abandoned must be harmless.
    children[0]?.emit("close", null, "SIGKILL");
  });

  test("uses a custom executable without running the installer", async () => {
    const { spawnFn, calls } = scriptedSpawn([]);
    const env = baseEnv();
    const appendPath = noopAppend();

    await expect(
      installClaudeCode({
        spawnFn,
        env,
        appendPath,
        customExecutable: "/opt/claude/bin/claude",
      }),
    ).resolves.toBe("/opt/claude/bin/claude");

    expect(calls).toHaveLength(0);
    expect(appendPath).toHaveBeenCalledWith("/opt/claude/bin");
    expect(env.PATH).toBe("/opt/claude/bin:/usr/bin");
  });

  test("reads the custom executable from PATH_TO_CLAUDE_CODE_EXECUTABLE", async () => {
    const { spawnFn, calls } = scriptedSpawn([]);
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(),
      PATH_TO_CLAUDE_CODE_EXECUTABLE: "/custom/claude",
    };

    await expect(
      installClaudeCode({ spawnFn, env, appendPath: noopAppend() }),
    ).resolves.toBe("/custom/claude");

    expect(calls).toHaveLength(0);
    expect(env.PATH).toBe("/custom:/usr/bin");
  });

  test("ignores an empty PATH_TO_CLAUDE_CODE_EXECUTABLE and installs instead", async () => {
    const { spawnFn, calls } = scriptedSpawn([{ kind: "exit", code: 0 }]);
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(),
      PATH_TO_CLAUDE_CODE_EXECUTABLE: "",
    };

    await expect(
      installClaudeCode({
        spawnFn,
        env,
        appendPath: noopAppend(),
        backoffMs: 0,
      }),
    ).resolves.toBe(EXPECTED_EXECUTABLE);

    expect(calls).toHaveLength(1);
  });

  test("rejects a custom executable containing control characters", async () => {
    const { spawnFn, calls } = scriptedSpawn([]);
    const appendPath = noopAppend();
    const env = baseEnv();

    await expect(
      installClaudeCode({
        spawnFn,
        env,
        appendPath,
        customExecutable: "/opt/claude/bin/claude\nrm -rf /",
      }),
    ).rejects.toThrow(
      "PATH_TO_CLAUDE_CODE_EXECUTABLE contains control characters (e.g. newlines), which is not allowed",
    );

    expect(calls).toHaveLength(0);
    expect(appendPath).not.toHaveBeenCalled();
    expect(env.PATH).toBe("/usr/bin");
  });
});
