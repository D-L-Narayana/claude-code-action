#!/usr/bin/env bun

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { preparePrompt, type PreparePromptInput } from "../src/prepare-prompt";
import { mkdtemp, rm, unlink, writeFile, readFile, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// Only used when RUNNER_TEMP is unset (e.g. when running outside GitHub Actions)
const FALLBACK_PROMPT_PATH = "/tmp/claude-action/prompt.txt";

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Ignore if file doesn't exist
  }
}

describe("preparePrompt integration tests", () => {
  const originalRunnerTemp = process.env.RUNNER_TEMP;
  let runnerTemp: string;

  beforeEach(async () => {
    // Inline prompts are written under RUNNER_TEMP; use a fresh directory per
    // test so nothing depends on or leaks into the shared /tmp.
    runnerTemp = await mkdtemp(join(tmpdir(), "prepare-prompt-"));
    process.env.RUNNER_TEMP = runnerTemp;
  });

  afterEach(async () => {
    await rm(runnerTemp, { recursive: true, force: true });
    if (originalRunnerTemp === undefined) {
      delete process.env.RUNNER_TEMP;
    } else {
      process.env.RUNNER_TEMP = originalRunnerTemp;
    }
  });

  test("should create temporary prompt file under RUNNER_TEMP when only prompt is provided", async () => {
    const input: PreparePromptInput = {
      prompt: "This is a test prompt",
      promptFile: "",
    };

    const config = await preparePrompt(input);

    expect(config.path).toBe(`${runnerTemp}/claude-action/prompt.txt`);
    expect(config.type).toBe("inline");

    const fileContent = await readFile(config.path, "utf-8");
    expect(fileContent).toBe("This is a test prompt");

    const fileStat = await stat(config.path);
    expect(fileStat.size).toBeGreaterThan(0);
  });

  test("should fall back to /tmp for the inline prompt file when RUNNER_TEMP is unset", async () => {
    delete process.env.RUNNER_TEMP;
    await removeIfPresent(FALLBACK_PROMPT_PATH);
    const input: PreparePromptInput = {
      prompt: "Prompt without RUNNER_TEMP",
      promptFile: "",
    };

    try {
      const config = await preparePrompt(input);

      expect(config.path).toBe(FALLBACK_PROMPT_PATH);
      expect(config.type).toBe("inline");

      const fileContent = await readFile(config.path, "utf-8");
      expect(fileContent).toBe("Prompt without RUNNER_TEMP");
    } finally {
      await removeIfPresent(FALLBACK_PROMPT_PATH);
    }
  });

  test("should use existing file when promptFile is provided", async () => {
    const testFilePath = join(runnerTemp, "test-prompt.txt");
    await writeFile(testFilePath, "Prompt from file");

    const input: PreparePromptInput = {
      prompt: "",
      promptFile: testFilePath,
    };

    const config = await preparePrompt(input);

    expect(config.path).toBe(testFilePath);
    expect(config.type).toBe("file");
  });

  test("should fail when neither prompt nor promptFile is provided", async () => {
    const input: PreparePromptInput = {
      prompt: "",
      promptFile: "",
    };

    await expect(preparePrompt(input)).rejects.toThrow(
      "Neither 'prompt' nor 'prompt_file' was provided",
    );
  });

  test("should fail when promptFile points to non-existent file", async () => {
    const input: PreparePromptInput = {
      prompt: "",
      promptFile: "/tmp/non-existent-file.txt",
    };

    await expect(preparePrompt(input)).rejects.toThrow(
      "Prompt file '/tmp/non-existent-file.txt' does not exist.",
    );
  });

  test("should fail when prompt is empty", async () => {
    const emptyFilePath = join(runnerTemp, "empty-prompt.txt");
    await writeFile(emptyFilePath, "");

    const input: PreparePromptInput = {
      prompt: "",
      promptFile: emptyFilePath,
    };

    await expect(preparePrompt(input)).rejects.toThrow("Prompt file is empty");
  });

  test("should fail when both prompt and promptFile are provided", async () => {
    const testFilePath = join(runnerTemp, "test-prompt.txt");
    await writeFile(testFilePath, "Prompt from file");

    const input: PreparePromptInput = {
      prompt: "This should cause an error",
      promptFile: testFilePath,
    };

    await expect(preparePrompt(input)).rejects.toThrow(
      "Both 'prompt' and 'prompt_file' were provided. Please specify only one.",
    );
  });
});
