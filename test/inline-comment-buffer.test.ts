import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  getInlineCommentBufferPath,
  readBufferedComments,
  removeBufferedComment,
  type BufferedComment,
} from "../src/mcp/inline-comment-buffer";

describe("getInlineCommentBufferPath", () => {
  it("builds a per-repository, per-PR, per-run path under RUNNER_TEMP", () => {
    expect(
      getInlineCommentBufferPath({
        RUNNER_TEMP: "/r",
        REPO_OWNER: "o",
        REPO_NAME: "n",
        PR_NUMBER: "7",
        GITHUB_RUN_ID: "42",
      }),
    ).toBe("/r/claude-inline-comments/o__n__pr7__run42.jsonl");
  });

  it("replaces characters outside [A-Za-z0-9_.-] with underscores", () => {
    expect(
      getInlineCommentBufferPath({
        RUNNER_TEMP: "/r",
        REPO_OWNER: "own/er",
        REPO_NAME: "na me",
        PR_NUMBER: "7",
        GITHUB_RUN_ID: "4:2",
      }),
    ).toBe("/r/claude-inline-comments/own_er__na_me__pr7__run4_2.jsonl");
  });

  it("falls back to /tmp, 'unknown' components and a 'local' run id", () => {
    expect(getInlineCommentBufferPath({})).toBe(
      "/tmp/claude-inline-comments/unknown__unknown__prunknown__runlocal.jsonl",
    );
  });

  it("treats empty strings like missing variables", () => {
    expect(
      getInlineCommentBufferPath({
        RUNNER_TEMP: "",
        REPO_OWNER: "",
        REPO_NAME: "n",
        PR_NUMBER: "",
        GITHUB_RUN_ID: "",
      }),
    ).toBe("/tmp/claude-inline-comments/unknown__n__prunknown__runlocal.jsonl");
  });

  it("gives different PRs of the same repository different buffers", () => {
    const base = {
      RUNNER_TEMP: "/r",
      REPO_OWNER: "o",
      REPO_NAME: "n",
      GITHUB_RUN_ID: "42",
    };
    expect(getInlineCommentBufferPath({ ...base, PR_NUMBER: "1" })).not.toBe(
      getInlineCommentBufferPath({ ...base, PR_NUMBER: "2" }),
    );
  });
});

describe("readBufferedComments", () => {
  let dir: string;
  let bufferPath: string;

  const entryA: BufferedComment = {
    ts: "2026-06-13T00:00:00.000Z",
    path: "src/index.ts",
    line: 10,
    side: "RIGHT",
    body: "Comment A",
  };
  const entryB: BufferedComment = {
    ts: "2026-06-13T00:00:01.000Z",
    path: "src/other.ts",
    startLine: 18,
    line: 20,
    side: "LEFT",
    commit_id: "c0ffee",
    body: "Comment B",
    confirmed: false,
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "inline-buffer-read-"));
    bufferPath = join(dir, "buffer.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns no entries and no malformed count when the file is missing", () => {
    expect(readBufferedComments(join(dir, "missing.jsonl"))).toEqual({
      entries: [],
      malformed: 0,
    });
  });

  it("parses one entry per line and ignores blank lines", () => {
    writeFileSync(
      bufferPath,
      `\n${JSON.stringify(entryA)}\n\n   \n${JSON.stringify(entryB)}\n`,
    );

    expect(readBufferedComments(bufferPath)).toEqual({
      entries: [entryA, entryB],
      malformed: 0,
    });
  });

  it("counts unparsable lines as malformed and keeps the valid ones", () => {
    writeFileSync(
      bufferPath,
      ["{not json", JSON.stringify(entryA), '{"truncated": '].join("\n") + "\n",
    );

    expect(readBufferedComments(bufferPath)).toEqual({
      entries: [entryA],
      malformed: 2,
    });
  });

  it("counts lines that are not comment objects as malformed", () => {
    writeFileSync(
      bufferPath,
      [
        "null",
        "42",
        '"a string"',
        "[1,2]",
        JSON.stringify({ body: "no path" }),
        JSON.stringify({ path: "src/x.ts" }),
        JSON.stringify({ path: 1, body: "path has the wrong type" }),
        JSON.stringify({ path: "src/x.ts", body: 2 }),
        JSON.stringify(entryB),
      ].join("\n") + "\n",
    );

    expect(readBufferedComments(bufferPath)).toEqual({
      entries: [entryB],
      malformed: 8,
    });
  });
});

describe("removeBufferedComment", () => {
  let dir: string;
  let bufferPath: string;

  const entryA = {
    ts: "2026-06-13T00:00:00.000Z",
    path: "src/index.ts",
    line: 10,
    startLine: undefined,
    side: "RIGHT",
    body: "Comment A",
  };
  const entryB = {
    ts: "2026-06-13T00:00:01.000Z",
    path: "src/other.ts",
    line: 20,
    startLine: undefined,
    side: "RIGHT",
    body: "Comment B",
  };

  const writeBuffer = (entries: object[]): void => {
    writeFileSync(
      bufferPath,
      entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
  };

  const readBuffer = (): Array<{ body: string }> => {
    if (!existsSync(bufferPath)) {
      return [];
    }
    return readFileSync(bufferPath, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "inline-buffer-"));
    bufferPath = join(dir, "buffer.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("removes the matching buffered entry and keeps the others", () => {
    writeBuffer([entryA, entryB]);

    removeBufferedComment(
      {
        path: "src/index.ts",
        line: 10,
        startLine: undefined,
        body: "Comment A",
      },
      bufferPath,
    );

    const remaining = readBuffer();
    expect(remaining.map((e) => e.body)).toEqual(["Comment B"]);
  });

  it("removes every copy when the same comment was buffered more than once", () => {
    writeBuffer([entryA, entryA, entryB]);

    removeBufferedComment(
      {
        path: "src/index.ts",
        line: 10,
        startLine: undefined,
        body: "Comment A",
      },
      bufferPath,
    );

    expect(readBuffer().map((e) => e.body)).toEqual(["Comment B"]);
  });

  it("leaves the buffer untouched when nothing matches", () => {
    writeBuffer([entryA, entryB]);

    removeBufferedComment(
      {
        path: "src/index.ts",
        line: 999,
        startLine: undefined,
        body: "Comment A",
      },
      bufferPath,
    );

    expect(readBuffer().map((e) => e.body)).toEqual(["Comment A", "Comment B"]);
  });

  it("does nothing when the buffer file does not exist", () => {
    expect(() =>
      removeBufferedComment(
        { path: "src/index.ts", line: 10, body: "Comment A" },
        bufferPath,
      ),
    ).not.toThrow();
    expect(existsSync(bufferPath)).toBe(false);
  });

  it("keeps lines that cannot be parsed as JSON", () => {
    writeFileSync(
      bufferPath,
      ["not json", JSON.stringify(entryA)].join("\n") + "\n",
    );

    removeBufferedComment(
      {
        path: "src/index.ts",
        line: 10,
        startLine: undefined,
        body: "Comment A",
      },
      bufferPath,
    );

    const raw = readFileSync(bufferPath, "utf8");
    expect(raw).toContain("not json");
    expect(raw).not.toContain("Comment A");
  });
});
