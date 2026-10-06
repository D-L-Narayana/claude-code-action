#!/usr/bin/env bun

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, relative } from "path";
import { parseSdkOptions } from "../src/parse-sdk-options";
import type { ClaudeOptions } from "../src/run-claude";

// The action always prepends its own MCP servers as inline JSON (see
// src/modes/tag/index.ts and src/modes/agent/index.ts), while users following
// docs/configuration.md "Passing Secrets to MCP Servers" append a file path.
const ACTION_INLINE_CONFIG =
  '{"mcpServers":{"github_comment":{"command":"node","args":["server.js"]}}}';

type McpServerEntry = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
};
type McpServers = Record<string, McpServerEntry>;

function parseMcpConfig(claudeArgs: string): string | null | undefined {
  const options: ClaudeOptions = { claudeArgs };
  return parseSdkOptions(options).sdkOptions.extraArgs?.["mcp-config"];
}

function parseMergedServers(claudeArgs: string): McpServers {
  const merged = parseMcpConfig(claudeArgs);
  expect(typeof merged).toBe("string");
  expect((merged as string).startsWith("{")).toBe(true);
  const parsed: { mcpServers?: McpServers } = JSON.parse(merged as string);
  if (!parsed.mcpServers) {
    throw new Error(`merged --mcp-config has no mcpServers: ${merged}`);
  }
  return parsed.mcpServers;
}

describe("parseSdkOptions --mcp-config file merging", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "mcp-config-merge-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("merges servers from a --mcp-config file with the action's inline JSON", async () => {
    const userConfigPath = join(tempDir, "user-mcp-config.json");
    await writeFile(
      userConfigPath,
      JSON.stringify({
        mcpServers: {
          user_server: {
            command: "custom",
            env: { API_KEY: "secret-from-file" },
          },
        },
      }),
    );

    const servers = parseMergedServers(
      `--mcp-config '${ACTION_INLINE_CONFIG}' --mcp-config ${userConfigPath}`,
    );

    expect(servers).toHaveProperty("github_comment");
    expect(servers).toHaveProperty("user_server");
    expect(servers.github_comment).toMatchObject({ command: "node" });
    // Secrets passed through the file must survive the merge intact
    expect(servers.user_server).toEqual({
      command: "custom",
      env: { API_KEY: "secret-from-file" },
    });
  });

  test("a later --mcp-config file overrides an inline server of the same name", async () => {
    const userConfigPath = join(tempDir, "override.json");
    await writeFile(
      userConfigPath,
      JSON.stringify({
        mcpServers: { github_comment: { command: "from-file" } },
      }),
    );

    const servers = parseMergedServers(
      `--mcp-config '${ACTION_INLINE_CONFIG}' --mcp-config ${userConfigPath}`,
    );

    expect(Object.keys(servers)).toEqual(["github_comment"]);
    expect(servers.github_comment).toEqual({ command: "from-file" });
  });

  test("a later inline config overrides a server of the same name from an earlier file", async () => {
    const userConfigPath = join(tempDir, "earlier.json");
    await writeFile(
      userConfigPath,
      JSON.stringify({
        mcpServers: {
          shared: { command: "from-file" },
          only_in_file: { command: "file-only" },
        },
      }),
    );

    const servers = parseMergedServers(
      `--mcp-config ${userConfigPath} --mcp-config '{"mcpServers":{"shared":{"command":"inline"}}}'`,
    );

    expect(servers.shared).toEqual({ command: "inline" });
    expect(servers.only_in_file).toEqual({ command: "file-only" });
  });

  test("merges two --mcp-config files when no inline JSON is present", async () => {
    const firstPath = join(tempDir, "first.json");
    const secondPath = join(tempDir, "second.json");
    await writeFile(
      firstPath,
      JSON.stringify({ mcpServers: { first: { command: "one" } } }),
    );
    await writeFile(
      secondPath,
      JSON.stringify({ mcpServers: { second: { command: "two" } } }),
    );

    const servers = parseMergedServers(
      `--mcp-config ${firstPath} --mcp-config ${secondPath}`,
    );

    expect(servers.first).toEqual({ command: "one" });
    expect(servers.second).toEqual({ command: "two" });
  });

  test("resolves a relative --mcp-config path against process.cwd()", async () => {
    const absolutePath = join(tempDir, "relative-user-config.json");
    await writeFile(
      absolutePath,
      JSON.stringify({ mcpServers: { user_server: { command: "custom" } } }),
    );
    const relativePath = relative(process.cwd(), absolutePath);
    expect(relativePath.startsWith("/")).toBe(false);

    const servers = parseMergedServers(
      `--mcp-config '${ACTION_INLINE_CONFIG}' --mcp-config ${relativePath}`,
    );

    expect(servers).toHaveProperty("github_comment");
    expect(servers.user_server).toEqual({ command: "custom" });
  });

  test("a --mcp-config file without mcpServers contributes nothing", async () => {
    const userConfigPath = join(tempDir, "no-servers.json");
    await writeFile(userConfigPath, JSON.stringify({ unrelated: true }));

    const servers = parseMergedServers(
      `--mcp-config '${ACTION_INLINE_CONFIG}' --mcp-config ${userConfigPath}`,
    );

    expect(Object.keys(servers)).toEqual(["github_comment"]);
  });

  test("throws a descriptive error when the --mcp-config file is not valid JSON", async () => {
    const userConfigPath = join(tempDir, "corrupt.json");
    await writeFile(userConfigPath, "{ this is not json");

    expect(() =>
      parseMcpConfig(
        `--mcp-config '${ACTION_INLINE_CONFIG}' --mcp-config ${userConfigPath}`,
      ),
    ).toThrow(
      `--mcp-config file '${userConfigPath}' could not be read or parsed:`,
    );
  });

  test("throws a descriptive error when the --mcp-config file does not exist", () => {
    const missingPath = join(tempDir, "missing.json");

    expect(() =>
      parseMcpConfig(
        `--mcp-config '${ACTION_INLINE_CONFIG}' --mcp-config ${missingPath}`,
      ),
    ).toThrow(
      `--mcp-config file '${missingPath}' could not be read or parsed:`,
    );
  });

  test("throws a descriptive error when an inline --mcp-config value is not valid JSON", () => {
    // Previously a malformed inline value was silently dropped from the merge
    expect(() =>
      parseMcpConfig(
        `--mcp-config '${ACTION_INLINE_CONFIG}' --mcp-config '{"mcpServers":{"broken":'`,
      ),
    ).toThrow("--mcp-config inline JSON could not be parsed:");
  });

  test("passes a single --mcp-config file path through unchanged without reading it", () => {
    // With a single value the CLI reads the file itself, so a missing file
    // must not fail here (keeps the pre-existing pass-through behaviour).
    const neverCreatedPath = join(tempDir, "never-created.json");

    expect(parseMcpConfig(`--mcp-config ${neverCreatedPath}`)).toBe(
      neverCreatedPath,
    );
  });
});
