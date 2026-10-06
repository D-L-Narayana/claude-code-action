#!/usr/bin/env bun

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { setupClaudeCodeSettings } from "../src/setup-claude-code-settings";
import { tmpdir } from "os";
import { mkdir, writeFile, readFile, rm } from "fs/promises";
import { join } from "path";

const testHomeDir = join(
  tmpdir(),
  "claude-code-test-home",
  Date.now().toString(),
);
const settingsPath = join(testHomeDir, ".claude", "settings.json");
const testSettingsDir = join(testHomeDir, ".claude-test");
const testSettingsPath = join(testSettingsDir, "test-settings.json");

describe("setupClaudeCodeSettings", () => {
  beforeEach(async () => {
    // Create test home directory and test settings directory
    await mkdir(testHomeDir, { recursive: true });
    await mkdir(testSettingsDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up test home directory
    await rm(testHomeDir, { recursive: true, force: true });
  });

  test("should always set enableAllProjectMcpServers to true when no input", async () => {
    await setupClaudeCodeSettings(undefined, testHomeDir);

    const settingsContent = await readFile(settingsPath, "utf-8");
    const settings = JSON.parse(settingsContent);

    expect(settings.enableAllProjectMcpServers).toBe(true);
  });

  test("should merge settings from JSON string input", async () => {
    const inputSettings = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      env: { API_KEY: "test-key" },
    });

    await setupClaudeCodeSettings(inputSettings, testHomeDir);

    const settingsContent = await readFile(settingsPath, "utf-8");
    const settings = JSON.parse(settingsContent);

    expect(settings.enableAllProjectMcpServers).toBe(true);
    expect(settings.model).toBe("claude-sonnet-4-20250514");
    expect(settings.env).toEqual({ API_KEY: "test-key" });
  });

  test("should merge settings from file path input", async () => {
    const testSettings = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "echo test" }],
          },
        ],
      },
      permissions: {
        allow: ["Bash", "Read"],
      },
    };

    await writeFile(testSettingsPath, JSON.stringify(testSettings, null, 2));

    await setupClaudeCodeSettings(testSettingsPath, testHomeDir);

    const settingsContent = await readFile(settingsPath, "utf-8");
    const settings = JSON.parse(settingsContent);

    expect(settings.enableAllProjectMcpServers).toBe(true);
    expect(settings.hooks).toEqual(testSettings.hooks);
    expect(settings.permissions).toEqual(testSettings.permissions);
  });

  test("should override enableAllProjectMcpServers even if false in input", async () => {
    const inputSettings = JSON.stringify({
      enableAllProjectMcpServers: false,
      model: "test-model",
    });

    await setupClaudeCodeSettings(inputSettings, testHomeDir);

    const settingsContent = await readFile(settingsPath, "utf-8");
    const settings = JSON.parse(settingsContent);

    expect(settings.enableAllProjectMcpServers).toBe(true);
    expect(settings.model).toBe("test-model");
  });

  test("should throw error for invalid JSON string", async () => {
    expect(() =>
      setupClaudeCodeSettings("{ invalid json", testHomeDir),
    ).toThrow();
  });

  test("should throw error for non-existent file path", async () => {
    expect(() =>
      setupClaudeCodeSettings("/non/existent/file.json", testHomeDir),
    ).toThrow();
  });

  test("should handle empty string input", async () => {
    await setupClaudeCodeSettings("", testHomeDir);

    const settingsContent = await readFile(settingsPath, "utf-8");
    const settings = JSON.parse(settingsContent);

    expect(settings.enableAllProjectMcpServers).toBe(true);
  });

  test("should handle whitespace-only input", async () => {
    await setupClaudeCodeSettings("   \n\t  ", testHomeDir);

    const settingsContent = await readFile(settingsPath, "utf-8");
    const settings = JSON.parse(settingsContent);

    expect(settings.enableAllProjectMcpServers).toBe(true);
  });

  test("should merge with existing settings", async () => {
    // First, create some existing settings
    await setupClaudeCodeSettings(
      JSON.stringify({ existingKey: "existingValue" }),
      testHomeDir,
    );

    // Then, add new settings
    const newSettings = JSON.stringify({
      newKey: "newValue",
      model: "claude-opus-4-1-20250805",
    });

    await setupClaudeCodeSettings(newSettings, testHomeDir);

    const settingsContent = await readFile(settingsPath, "utf-8");
    const settings = JSON.parse(settingsContent);

    expect(settings.enableAllProjectMcpServers).toBe(true);
    expect(settings.existingKey).toBe("existingValue");
    expect(settings.newKey).toBe("newValue");
    expect(settings.model).toBe("claude-opus-4-1-20250805");
  });

  test("should warn and start from empty settings when the existing settings file is corrupt", async () => {
    await mkdir(join(testHomeDir, ".claude"), { recursive: true });
    await writeFile(settingsPath, "{ this is not valid json");
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    try {
      await setupClaudeCodeSettings(
        JSON.stringify({ model: "claude-sonnet-4-20250514" }),
        testHomeDir,
      );

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [warning] = warnSpy.mock.calls[0] ?? [];
      expect(String(warning)).toContain(settingsPath);
      expect(String(warning)).toContain("not valid JSON");

      const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
      expect(settings).toEqual({
        model: "claude-sonnet-4-20250514",
        enableAllProjectMcpServers: true,
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("should warn and start from empty settings when the existing settings file is not a JSON object", async () => {
    await mkdir(join(testHomeDir, ".claude"), { recursive: true });
    await writeFile(settingsPath, "null");
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    try {
      await setupClaudeCodeSettings(undefined, testHomeDir);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
      expect(settings).toEqual({ enableAllProjectMcpServers: true });
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("should not warn when the existing settings file is empty", async () => {
    await mkdir(join(testHomeDir, ".claude"), { recursive: true });
    await writeFile(settingsPath, "");
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    try {
      await setupClaudeCodeSettings(undefined, testHomeDir);

      expect(warnSpy).not.toHaveBeenCalled();
      const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
      expect(settings).toEqual({ enableAllProjectMcpServers: true });
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("should write the settings file as exactly the pretty-printed JSON", async () => {
    await setupClaudeCodeSettings(
      JSON.stringify({ model: "claude-sonnet-4-20250514" }),
      testHomeDir,
    );

    const settingsContent = await readFile(settingsPath, "utf-8");
    expect(settingsContent).toBe(
      JSON.stringify(
        { model: "claude-sonnet-4-20250514", enableAllProjectMcpServers: true },
        null,
        2,
      ),
    );
  });

  test("should preserve shell-sensitive characters in setting values", async () => {
    const inputSettings = {
      env: {
        TEMPLATE:
          "$HOME/`whoami` \"quoted\" 'single' \\n\\t literal\\backslash",
        UNICODE: "héllo – 日本語 ✓",
      },
    };

    await setupClaudeCodeSettings(JSON.stringify(inputSettings), testHomeDir);

    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    expect(settings.env).toEqual(inputSettings.env);
  });

  describe("never exposes settings values in logs or errors", () => {
    // Synthetic stand-ins for user secrets held in settings. A bare identifier
    // in value position makes the JSON parser quote it in its error message,
    // which is exactly how a parser exception can carry payload fragments.
    const GARBAGE = "GARBAGEFRAGMENTXYZ";

    type ConsoleCapture = { text(): string; restore(): void };

    function formatArg(arg: unknown): string {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return arg.stack ?? arg.message;
      return String(JSON.stringify(arg));
    }

    // Capture every console channel so a leak on any of them is caught
    function captureConsole(): ConsoleCapture {
      const lines: string[] = [];
      const record = (...args: unknown[]) => {
        lines.push(args.map(formatArg).join(" "));
      };
      const spies = [
        spyOn(console, "log").mockImplementation(record),
        spyOn(console, "warn").mockImplementation(record),
        spyOn(console, "error").mockImplementation(record),
        spyOn(console, "info").mockImplementation(record),
        spyOn(console, "debug").mockImplementation(record),
      ];
      return {
        text: () => lines.join("\n"),
        restore: () => {
          for (const spy of spies) spy.mockRestore();
        },
      };
    }

    async function runCaptured(
      settingsInput: string | undefined,
    ): Promise<{ logs: string; error: unknown }> {
      const output = captureConsole();
      try {
        const error: unknown = await setupClaudeCodeSettings(
          settingsInput,
          testHomeDir,
        ).then(
          () => undefined,
          (e: unknown) => e,
        );
        return { logs: output.text(), error };
      } finally {
        output.restore();
      }
    }

    async function writeExistingSettings(content: string): Promise<void> {
      await mkdir(join(testHomeDir, ".claude"), { recursive: true });
      await writeFile(settingsPath, content);
    }

    function expectNone(text: string, markers: string[]): void {
      for (const marker of markers) {
        expect(text).not.toContain(marker);
      }
    }

    test("(a) existing settings values are not logged when there is no input", async () => {
      const marker = "SYNTHETIC-A-MARKER";
      await writeExistingSettings(
        JSON.stringify({
          model: "claude-sonnet-4-20250514",
          env: { CUSTOM_TOKEN: marker },
        }),
      );

      const { logs, error } = await runCaptured(undefined);

      expect(error).toBeUndefined();
      expectNone(logs, [marker]);
      // Value-free diagnostics stay useful: the path and top-level key names
      expect(logs).toContain(settingsPath);
      expect(logs).toContain("env");
      const written = await readFile(settingsPath, "utf-8");
      expect(written).toContain(marker);
      expect(JSON.parse(written)).toEqual({
        model: "claude-sonnet-4-20250514",
        env: { CUSTOM_TOKEN: marker },
        enableAllProjectMcpServers: true,
      });
    });

    test("(b) neither existing nor inline input values are logged when both carry secrets", async () => {
      const existingMarker = "SYNTHETIC-B-EXISTING-MARKER";
      const inputMarker = "SYNTHETIC-B-INPUT-MARKER";
      await writeExistingSettings(
        JSON.stringify({ env: { CUSTOM_TOKEN: existingMarker } }),
      );

      const { logs, error } = await runCaptured(
        JSON.stringify({ model: "m", apiKeyHelper: `echo ${inputMarker}` }),
      );

      expect(error).toBeUndefined();
      expectNone(logs, [existingMarker, inputMarker]);
      const written = await readFile(settingsPath, "utf-8");
      expect(written).toContain(existingMarker);
      expect(written).toContain(inputMarker);
      expect(JSON.parse(written)).toEqual({
        env: { CUSTOM_TOKEN: existingMarker },
        model: "m",
        apiKeyHelper: `echo ${inputMarker}`,
        enableAllProjectMcpServers: true,
      });
    });

    test("(c) a malformed existing settings file is neither echoed nor quoted via the parser error", async () => {
      const marker = "SYNTHETIC-C-MARKER";
      const inputMarker = "SYNTHETIC-C-INPUT-MARKER";
      await writeExistingSettings(
        `{"env":{"CUSTOM_TOKEN":"${marker}"},"model":${GARBAGE}}`,
      );

      const { logs, error } = await runCaptured(
        JSON.stringify({ env: { OTHER_TOKEN: inputMarker } }),
      );

      expect(error).toBeUndefined();
      expectNone(logs, [marker, GARBAGE, inputMarker]);
      expect(logs).toContain("not valid JSON");
      const written = await readFile(settingsPath, "utf-8");
      expect(written).toContain(inputMarker);
      expect(JSON.parse(written)).toEqual({
        env: { OTHER_TOKEN: inputMarker },
        enableAllProjectMcpServers: true,
      });
    });

    test("(d) malformed inline JSON input is rejected without echoing it in logs or the error", async () => {
      const marker = "SYNTHETIC-D-MARKER";

      const { logs, error } = await runCaptured(
        `{"env":{"CUSTOM_TOKEN":"${marker}"},"model":${GARBAGE}}`,
      );

      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expectNone(message, [marker, GARBAGE]);
      expectNone(logs, [marker, GARBAGE]);
      expect(message).toContain(
        "Settings input looks like JSON but could not be parsed",
      );
    });

    test("(e) a settings file with malformed JSON is rejected without quoting its content", async () => {
      const marker = "SYNTHETIC-E-MARKER";
      await writeFile(
        testSettingsPath,
        `{"env":{"CUSTOM_TOKEN":"${marker}"},"model":${GARBAGE}}`,
      );

      const { logs, error } = await runCaptured(testSettingsPath);

      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expectNone(message, [marker, GARBAGE]);
      expectNone(logs, [marker, GARBAGE]);
      // The path is a useful, value-free diagnostic
      expect(message).toContain(testSettingsPath);
      expect(message).toContain("not valid JSON");
    });

    test("(f) a valid settings file is merged without logging its values", async () => {
      const existingMarker = "SYNTHETIC-F-EXISTING-MARKER";
      const fileMarker = "SYNTHETIC-F-FILE-MARKER";
      await writeExistingSettings(
        JSON.stringify({ env: { CUSTOM_TOKEN: existingMarker } }),
      );
      await writeFile(
        testSettingsPath,
        JSON.stringify({ apiKeyHelper: `echo ${fileMarker}` }),
      );

      const { logs, error } = await runCaptured(testSettingsPath);

      expect(error).toBeUndefined();
      expectNone(logs, [existingMarker, fileMarker]);
      expect(logs).toContain(testSettingsPath);
      const written = await readFile(settingsPath, "utf-8");
      expect(written).toContain(existingMarker);
      expect(written).toContain(fileMarker);
      expect(JSON.parse(written)).toEqual({
        env: { CUSTOM_TOKEN: existingMarker },
        apiKeyHelper: `echo ${fileMarker}`,
        enableAllProjectMcpServers: true,
      });
    });

    test("(g) malformed input that is neither a JSON object nor a path is rejected without being echoed", async () => {
      const marker = "SYNTHETIC-G-MARKER";

      // Outer braces missing: not inline JSON, and clearly not a file path either
      const { logs, error } = await runCaptured(
        `"env": {"CUSTOM_TOKEN": "${marker}"}`,
      );

      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expectNone(message, [marker]);
      expectNone(logs, [marker]);
      expect(message).toContain("neither a JSON object nor a file path");
    });

    test("a missing settings file reports only the path and the error code", async () => {
      const missingPath = join(testSettingsDir, "missing.json");

      const { error } = await runCaptured(missingPath);

      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain(missingPath);
      expect(message).toContain("ENOENT");
    });

    test("a file-path input with surrounding whitespace (YAML block) is still read", async () => {
      await writeFile(testSettingsPath, JSON.stringify({ model: "m" }));

      const { error } = await runCaptured(`${testSettingsPath}\n`);

      expect(error).toBeUndefined();
      expect(JSON.parse(await readFile(settingsPath, "utf-8"))).toEqual({
        model: "m",
        enableAllProjectMcpServers: true,
      });
    });
  });
});
