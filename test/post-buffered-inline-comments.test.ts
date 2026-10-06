import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { getInlineCommentBufferPath } from "../src/mcp/inline-comment-buffer";
import {
  postBufferedInlineComments,
  type PostBufferedDeps,
  type PostBufferedOctokit,
} from "../src/entrypoints/post-buffered-inline-comments";

type ReviewCommentParams = Parameters<
  PostBufferedOctokit["pulls"]["createReviewComment"]
>[0];

const TS = "2026-10-06T00:00:00.000Z";

describe("postBufferedInlineComments", () => {
  let runnerTemp: string;
  let env: NodeJS.ProcessEnv;
  let bufferPath: string;
  let created: ReviewCommentParams[];
  let logs: string[];
  let classifyCalls: Array<{ bodies: string[]; apiKey: string; model: string }>;

  const log = (message: string): void => {
    logs.push(message);
  };

  const fakeOctokit = (
    options: { failFor?: string } = {},
  ): PostBufferedOctokit => ({
    pulls: {
      get: async () => ({ data: { head: { sha: "headsha" } } }),
      createReviewComment: async (params: ReviewCommentParams) => {
        if (options.failFor && params.path === options.failFor) {
          throw new Error("Validation Failed");
        }
        created.push(params);
        return { data: { id: created.length } };
      },
    },
  });

  const classifyWith =
    (verdicts: boolean[] | null): NonNullable<PostBufferedDeps["classify"]> =>
    async (bodies, apiKey, model) => {
      classifyCalls.push({ bodies, apiKey, model });
      return verdicts;
    };

  const writeBuffer = (content: object[] | string): void => {
    mkdirSync(dirname(bufferPath), { recursive: true });
    writeFileSync(
      bufferPath,
      typeof content === "string"
        ? content
        : content.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
  };

  beforeEach(() => {
    runnerTemp = mkdtempSync(join(tmpdir(), "post-buffered-"));
    env = {
      RUNNER_TEMP: runnerTemp,
      REPO_OWNER: "o",
      REPO_NAME: "n",
      PR_NUMBER: "7",
      GITHUB_RUN_ID: "42",
      GITHUB_TOKEN: "test-github-token",
      ANTHROPIC_API_KEY: "test-anthropic-key",
    };
    bufferPath = getInlineCommentBufferPath(env);
    created = [];
    logs = [];
    classifyCalls = [];
  });

  afterEach(() => {
    rmSync(runnerTemp, { recursive: true, force: true });
  });

  it("posts classified-real comments with the buffered parameters", async () => {
    writeBuffer([
      { ts: TS, path: "src/a.ts", line: 10, side: "RIGHT", body: "Real A" },
      {
        ts: TS,
        path: "src/b.ts",
        startLine: 3,
        line: 5,
        side: "LEFT",
        commit_id: "c0ffee",
        body: "Real B",
      },
    ]);

    const result = await postBufferedInlineComments({
      env,
      octokit: fakeOctokit(),
      classify: classifyWith([true, true]),
      log,
    });

    expect(result).toEqual({
      found: 2,
      malformed: 0,
      neverPost: 0,
      filtered: 0,
      posted: 2,
      failed: 0,
      bufferPath,
    });
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({
      owner: "o",
      repo: "n",
      pull_number: 7,
      path: "src/a.ts",
      line: 10,
      side: "RIGHT",
      commit_id: "headsha",
      body: "Real A",
    });
    expect(created[0]).not.toHaveProperty("start_line");
    expect(created[1]).toMatchObject({
      path: "src/b.ts",
      start_line: 3,
      start_side: "LEFT",
      line: 5,
      side: "LEFT",
      commit_id: "c0ffee",
      body: "Real B",
    });
  });

  it("never posts confirmed=false entries and only classifies the candidates", async () => {
    writeBuffer([
      { ts: TS, path: "src/a.ts", line: 1, body: "Probe", confirmed: false },
      { ts: TS, path: "src/b.ts", line: 2, body: "Real B" },
    ]);

    const result = await postBufferedInlineComments({
      env,
      octokit: fakeOctokit(),
      classify: classifyWith([true]),
      log,
    });

    expect(result).toMatchObject({ found: 2, neverPost: 1, posted: 1 });
    expect(classifyCalls[0]?.bodies).toEqual(["Real B"]);
    expect(created.map((c) => c.body)).toEqual(["Real B"]);
  });

  it("drops entries the classifier marks as test/probe and warns about them", async () => {
    writeBuffer([
      { ts: TS, path: "src/a.ts", line: 1, body: "Test comment" },
      { ts: TS, path: "src/b.ts", line: 2, body: "Real B" },
    ]);

    const result = await postBufferedInlineComments({
      env,
      octokit: fakeOctokit(),
      classify: classifyWith([false, true]),
      log,
    });

    expect(result).toMatchObject({ found: 2, filtered: 1, posted: 1 });
    expect(created.map((c) => c.body)).toEqual(["Real B"]);
    expect(
      logs.some((l) => l.includes("::warning::") && l.includes("test/probe")),
    ).toBe(true);
  });

  it("skips a malformed line, warns, and still posts the valid entry", async () => {
    writeBuffer(
      `not json\n${JSON.stringify({ ts: TS, path: "src/a.ts", line: 10, body: "Real A" })}\n`,
    );

    const result = await postBufferedInlineComments({
      env,
      octokit: fakeOctokit(),
      classify: classifyWith([true]),
      log,
    });

    expect(result).toMatchObject({ found: 1, malformed: 1, posted: 1 });
    expect(created.map((c) => c.body)).toEqual(["Real A"]);
    expect(
      logs.some((l) => l.includes("::warning::") && l.includes("1 malformed")),
    ).toBe(true);
  });

  it("collapses duplicate buffered entries into a single comment", async () => {
    writeBuffer([
      { ts: TS, path: "src/a.ts", line: 10, body: "Real A" },
      {
        ts: "2026-10-06T00:00:01.000Z",
        path: "src/a.ts",
        line: 10,
        body: "Real A",
      },
    ]);

    const result = await postBufferedInlineComments({
      env,
      octokit: fakeOctokit(),
      classify: classifyWith([true]),
      log,
    });

    expect(result).toMatchObject({ found: 2, posted: 1, failed: 0 });
    expect(classifyCalls[0]?.bodies).toEqual(["Real A"]);
    expect(created).toHaveLength(1);
  });

  it("lets a confirmed=false duplicate suppress its buffered twin", async () => {
    writeBuffer([
      { ts: TS, path: "src/a.ts", line: 10, body: "Real A" },
      { ts: TS, path: "src/a.ts", line: 10, body: "Real A", confirmed: false },
    ]);

    const result = await postBufferedInlineComments({
      env,
      octokit: fakeOctokit(),
      classify: classifyWith([]),
      log,
    });

    expect(result).toMatchObject({ found: 2, neverPost: 1, posted: 0 });
    expect(classifyCalls).toHaveLength(0);
    expect(created).toHaveLength(0);
  });

  it("calls the Anthropic API with the configured model when no classifier is injected", async () => {
    env.CLAUDE_INLINE_CLASSIFIER_MODEL = "claude-test-model-2";
    writeBuffer([
      { ts: TS, path: "src/a.ts", line: 1, body: "Test comment" },
      { ts: TS, path: "src/b.ts", line: 2, body: "Real B" },
    ]);
    const requests: Array<{
      url: string;
      init: Parameters<NonNullable<PostBufferedDeps["fetchFn"]>>[1];
    }> = [];
    const fetchFn: NonNullable<PostBufferedDeps["fetchFn"]> = async (
      url,
      init,
    ) => {
      requests.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: "text", text: "[false, true]" }],
        }),
      };
    };

    const result = await postBufferedInlineComments({
      env,
      octokit: fakeOctokit(),
      fetchFn,
      log,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(requests[0]?.init?.method).toBe("POST");
    expect(requests[0]?.init?.headers).toEqual({
      "content-type": "application/json",
      "x-api-key": "test-anthropic-key",
      "anthropic-version": "2023-06-01",
    });
    const requestBody = JSON.parse(String(requests[0]?.init?.body));
    expect(requestBody.model).toBe("claude-test-model-2");
    expect(requestBody.max_tokens).toBe(1024);
    expect(requestBody.messages).toHaveLength(1);
    expect(requestBody.messages[0].role).toBe("user");
    expect(requestBody.messages[0].content).toContain('1. "Test comment"');
    expect(requestBody.messages[0].content).toContain('2. "Real B"');
    expect(result).toMatchObject({ filtered: 1, posted: 1 });
    expect(created.map((c) => c.body)).toEqual(["Real B"]);
  });

  it("deletes the buffer file after posting", async () => {
    writeBuffer([{ ts: TS, path: "src/a.ts", line: 10, body: "Real A" }]);

    await postBufferedInlineComments({
      env,
      octokit: fakeOctokit(),
      classify: classifyWith([true]),
      log,
    });

    expect(existsSync(bufferPath)).toBe(false);
  });

  it("deletes the buffer file even when nothing qualifies for posting", async () => {
    writeBuffer([
      { ts: TS, path: "src/a.ts", line: 1, body: "Probe", confirmed: false },
    ]);

    const result = await postBufferedInlineComments({
      env,
      octokit: fakeOctokit(),
      classify: classifyWith([]),
      log,
    });

    expect(result).toMatchObject({ found: 1, neverPost: 1, posted: 0 });
    expect(classifyCalls).toHaveLength(0);
    expect(created).toHaveLength(0);
    expect(existsSync(bufferPath)).toBe(false);
  });

  it("deletes a buffer that only contains malformed lines", async () => {
    writeBuffer("garbage\n");

    const result = await postBufferedInlineComments({
      env,
      octokit: fakeOctokit(),
      classify: classifyWith([]),
      log,
    });

    expect(result).toMatchObject({ found: 0, malformed: 1, posted: 0 });
    expect(existsSync(bufferPath)).toBe(false);
  });

  it("reports nothing to do when the buffer file does not exist", async () => {
    const result = await postBufferedInlineComments({
      env,
      octokit: fakeOctokit(),
      classify: classifyWith([]),
      log,
    });

    expect(result).toEqual({
      found: 0,
      malformed: 0,
      neverPost: 0,
      filtered: 0,
      posted: 0,
      failed: 0,
      bufferPath,
    });
    expect(created).toHaveLength(0);
  });

  it("passes the configured classifier model and API key to classify", async () => {
    env.CLAUDE_INLINE_CLASSIFIER_MODEL = "claude-test-model-1";
    writeBuffer([{ ts: TS, path: "src/a.ts", line: 10, body: "Real A" }]);

    await postBufferedInlineComments({
      env,
      octokit: fakeOctokit(),
      classify: classifyWith([true]),
      log,
    });

    expect(classifyCalls).toEqual([
      {
        bodies: ["Real A"],
        apiKey: "test-anthropic-key",
        model: "claude-test-model-1",
      },
    ]);
  });

  it("defaults the classifier model to claude-haiku-4-5", async () => {
    writeBuffer([{ ts: TS, path: "src/a.ts", line: 10, body: "Real A" }]);

    await postBufferedInlineComments({
      env,
      octokit: fakeOctokit(),
      classify: classifyWith([true]),
      log,
    });

    expect(classifyCalls[0]?.model).toBe("claude-haiku-4-5");
  });

  it("posts all unconfirmed comments without classifying when ANTHROPIC_API_KEY is missing", async () => {
    delete env.ANTHROPIC_API_KEY;
    writeBuffer([
      { ts: TS, path: "src/a.ts", line: 1, body: "Test comment" },
      { ts: TS, path: "src/b.ts", line: 2, body: "Real B" },
    ]);

    const result = await postBufferedInlineComments({
      env,
      octokit: fakeOctokit(),
      classify: classifyWith([false, false]),
      log,
    });

    expect(classifyCalls).toHaveLength(0);
    expect(result).toMatchObject({ found: 2, filtered: 0, posted: 2 });
    expect(created.map((c) => c.body)).toEqual(["Test comment", "Real B"]);
  });

  it("posts all candidates when the classifier gives up", async () => {
    writeBuffer([
      { ts: TS, path: "src/a.ts", line: 1, body: "Maybe A" },
      { ts: TS, path: "src/b.ts", line: 2, body: "Maybe B" },
    ]);

    const result = await postBufferedInlineComments({
      env,
      octokit: fakeOctokit(),
      classify: classifyWith(null),
      log,
    });

    expect(classifyCalls).toHaveLength(1);
    expect(result).toMatchObject({ filtered: 0, posted: 2 });
  });

  it("truncates oversized bodies to GitHub's comment limit", async () => {
    writeBuffer([
      { ts: TS, path: "src/a.ts", line: 10, body: "x".repeat(70_000) },
    ]);

    await postBufferedInlineComments({
      env,
      octokit: fakeOctokit(),
      classify: classifyWith([true]),
      log,
    });

    expect(created).toHaveLength(1);
    const body = created[0]?.body ?? "";
    expect(body.length).toBeLessThanOrEqual(65536);
    expect(body.startsWith("xxxxxxxx")).toBe(true);
    // Same marker as every other comment the action posts (docs/limits.md).
    expect(body).toContain("…[truncated ");
  });

  it("redacts credentials from buffered bodies before posting", async () => {
    const token = `ghp_${"a".repeat(36)}`;
    writeBuffer([
      { ts: TS, path: "src/a.ts", line: 10, body: `leaked ${token} here` },
    ]);

    await postBufferedInlineComments({
      env,
      octokit: fakeOctokit(),
      classify: classifyWith([true]),
      log,
    });

    expect(created[0]?.body).toBe("leaked [REDACTED_GITHUB_TOKEN] here");
  });

  it("keeps the buffer and posts nothing when GITHUB_TOKEN is missing", async () => {
    delete env.GITHUB_TOKEN;
    writeBuffer([{ ts: TS, path: "src/a.ts", line: 10, body: "Real A" }]);

    const result = await postBufferedInlineComments({
      env,
      octokit: fakeOctokit(),
      classify: classifyWith([true]),
      log,
    });

    expect(result).toMatchObject({ found: 1, posted: 0, failed: 0 });
    expect(created).toHaveLength(0);
    expect(classifyCalls).toHaveLength(0);
    expect(existsSync(bufferPath)).toBe(true);
    expect(
      logs.some((l) => l.includes("::warning::") && l.includes("GITHUB_TOKEN")),
    ).toBe(true);
  });

  it("counts failed posts without aborting the remaining comments", async () => {
    writeBuffer([
      { ts: TS, path: "src/a.ts", line: 1, body: "Real A" },
      { ts: TS, path: "src/b.ts", line: 2, body: "Real B" },
    ]);

    const result = await postBufferedInlineComments({
      env,
      octokit: fakeOctokit({ failFor: "src/a.ts" }),
      classify: classifyWith([true, true]),
      log,
    });

    expect(result).toMatchObject({ posted: 1, failed: 1 });
    expect(created.map((c) => c.body)).toEqual(["Real B"]);
    expect(existsSync(bufferPath)).toBe(false);
  });
});
