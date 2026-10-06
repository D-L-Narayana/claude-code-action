import { describe, expect, it } from "bun:test";
import { GITHUB_API_URL } from "../src/github/api/config";
import {
  buildTreeEntry,
  createBlob,
  createCommit,
  createTree,
  getBaseTreeSha,
  getOrCreateBranchRef,
  githubHeaders,
  type GitHubApiFetch,
  type GitHubTreeEntry,
} from "../src/mcp/github-file-ops-api";

type RecordedCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};

type ScriptedResponse = { status: number; body?: unknown; text?: string };

/**
 * Builds a fetch replacement that answers from a fixed list of responses and
 * records every request so tests can assert URLs, methods, headers and bodies.
 */
function scriptedFetch(responses: ScriptedResponse[]) {
  const calls: RecordedCall[] = [];
  const fetchFn: GitHubApiFetch = async (url, init) => {
    const next = responses.shift();
    if (!next) {
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    }
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers as Record<string, string> | undefined) ?? {},
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => next.text ?? JSON.stringify(next.body ?? ""),
      json: async () => next.body,
    };
  };
  return { fetchFn, calls };
}

const target = { owner: "o", repo: "r", githubToken: "tok" };
const API = `${GITHUB_API_URL}/repos/o/r`;
const AUTH_HEADERS = {
  Accept: "application/vnd.github+json",
  Authorization: "Bearer tok",
  "X-GitHub-Api-Version": "2022-11-28",
};

describe("githubHeaders", () => {
  it("returns the GitHub REST headers for a token", () => {
    expect(githubHeaders("tok")).toEqual(AUTH_HEADERS);
  });

  it("adds a JSON content type for request bodies", () => {
    expect(githubHeaders("tok", { json: true })).toEqual({
      ...AUTH_HEADERS,
      "Content-Type": "application/json",
    });
  });
});

describe("getOrCreateBranchRef", () => {
  it("returns the sha of an existing branch without creating anything", async () => {
    const { fetchFn, calls } = scriptedFetch([
      { status: 200, body: { object: { sha: "abc" } } },
    ]);

    const sha = await getOrCreateBranchRef({
      ...target,
      branch: "feature",
      baseBranch: "main",
      fetchFn,
    });

    expect(sha).toBe("abc");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: `${API}/git/refs/heads/feature`,
      method: "GET",
      headers: AUTH_HEADERS,
    });
  });

  it("creates the branch from the base branch when it does not exist", async () => {
    const { fetchFn, calls } = scriptedFetch([
      { status: 404, body: { message: "Not Found" } },
      { status: 200, body: { object: { sha: "base" } } },
      { status: 201, body: { ref: "refs/heads/feature" } },
    ]);

    const sha = await getOrCreateBranchRef({
      ...target,
      branch: "feature",
      baseBranch: "main",
      fetchFn,
    });

    expect(sha).toBe("base");
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["GET", `${API}/git/refs/heads/feature`],
      ["GET", `${API}/git/refs/heads/main`],
      ["POST", `${API}/git/refs`],
    ]);
    expect(calls[2]).toMatchObject({
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      body: { ref: "refs/heads/feature", sha: "base" },
    });
  });

  it("falls back to the repository default branch when the base branch is missing", async () => {
    const { fetchFn, calls } = scriptedFetch([
      { status: 404, body: { message: "Not Found" } },
      { status: 404, body: { message: "Not Found" } },
      { status: 200, body: { default_branch: "develop" } },
      { status: 200, body: { object: { sha: "def" } } },
      { status: 201, body: { ref: "refs/heads/feature" } },
    ]);

    const sha = await getOrCreateBranchRef({
      ...target,
      branch: "feature",
      baseBranch: "gone",
      fetchFn,
    });

    expect(sha).toBe("def");
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["GET", `${API}/git/refs/heads/feature`],
      ["GET", `${API}/git/refs/heads/gone`],
      ["GET", API],
      ["GET", `${API}/git/refs/heads/develop`],
      ["POST", `${API}/git/refs`],
    ]);
    expect(calls[4]?.body).toEqual({ ref: "refs/heads/feature", sha: "def" });
  });

  it("requires BASE_BRANCH when the branch has to be created", async () => {
    const { fetchFn, calls } = scriptedFetch([
      { status: 404, body: { message: "Not Found" } },
    ]);

    await expect(
      getOrCreateBranchRef({
        ...target,
        branch: "feature",
        baseBranch: undefined,
        fetchFn,
      }),
    ).rejects.toThrow(
      "BASE_BRANCH environment variable is required to create branch 'feature'",
    );
    // Nothing may be created from a guessed base.
    expect(calls).toHaveLength(1);
  });

  it("treats an empty BASE_BRANCH like a missing one", async () => {
    const { fetchFn } = scriptedFetch([
      { status: 404, body: { message: "Not Found" } },
    ]);

    await expect(
      getOrCreateBranchRef({
        ...target,
        branch: "feature",
        baseBranch: "",
        fetchFn,
      }),
    ).rejects.toThrow(
      "BASE_BRANCH environment variable is required to create branch 'feature'",
    );
  });

  it("reports a non-404 failure while reading the branch", async () => {
    const { fetchFn } = scriptedFetch([{ status: 500, text: "boom" }]);

    await expect(
      getOrCreateBranchRef({
        ...target,
        branch: "feature",
        baseBranch: "main",
        fetchFn,
      }),
    ).rejects.toThrow("Failed to get branch reference: 500");
  });

  it("reports a failure while reading the repository info", async () => {
    const { fetchFn } = scriptedFetch([
      { status: 404 },
      { status: 404 },
      { status: 500, text: "boom" },
    ]);

    await expect(
      getOrCreateBranchRef({
        ...target,
        branch: "feature",
        baseBranch: "gone",
        fetchFn,
      }),
    ).rejects.toThrow("Failed to get repository info: 500");
  });

  it("reports a failure while reading the default branch reference", async () => {
    const { fetchFn } = scriptedFetch([
      { status: 404 },
      { status: 404 },
      { status: 200, body: { default_branch: "develop" } },
      { status: 500, text: "boom" },
    ]);

    await expect(
      getOrCreateBranchRef({
        ...target,
        branch: "feature",
        baseBranch: "gone",
        fetchFn,
      }),
    ).rejects.toThrow("Failed to get default branch reference: 500");
  });

  it("includes the response body when creating the branch fails", async () => {
    const { fetchFn } = scriptedFetch([
      { status: 404 },
      { status: 200, body: { object: { sha: "base" } } },
      { status: 422, text: "Reference already exists" },
    ]);

    await expect(
      getOrCreateBranchRef({
        ...target,
        branch: "feature",
        baseBranch: "main",
        fetchFn,
      }),
    ).rejects.toThrow(
      "Failed to create branch: 422 - Reference already exists",
    );
  });
});

describe("getBaseTreeSha", () => {
  it("reads the tree sha of a commit", async () => {
    const { fetchFn, calls } = scriptedFetch([
      { status: 200, body: { tree: { sha: "tree1" } } },
    ]);

    const sha = await getBaseTreeSha({
      ...target,
      commitSha: "abc",
      fetchFn,
    });

    expect(sha).toBe("tree1");
    expect(calls).toEqual([
      {
        url: `${API}/git/commits/abc`,
        method: "GET",
        headers: AUTH_HEADERS,
        body: undefined,
      },
    ]);
  });

  it("reports a failure while reading the commit", async () => {
    const { fetchFn } = scriptedFetch([{ status: 500, text: "boom" }]);

    await expect(
      getBaseTreeSha({ ...target, commitSha: "abc", fetchFn }),
    ).rejects.toThrow("Failed to get base commit: 500");
  });
});

describe("createBlob", () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);

  it("uploads the bytes base64-encoded and returns the blob sha", async () => {
    const { fetchFn, calls } = scriptedFetch([
      { status: 201, body: { sha: "blob1" } },
    ]);

    const sha = await createBlob({
      ...target,
      path: "bin/x.png",
      content: bytes,
      fetchFn,
    });

    expect(sha).toBe("blob1");
    expect(calls).toEqual([
      {
        url: `${API}/git/blobs`,
        method: "POST",
        headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
        body: { content: bytes.toString("base64"), encoding: "base64" },
      },
    ]);
  });

  it("names the file and includes the response body when the upload fails", async () => {
    const { fetchFn } = scriptedFetch([{ status: 500, text: "boom" }]);

    await expect(
      createBlob({ ...target, path: "bin/x.png", content: bytes, fetchFn }),
    ).rejects.toThrow("Failed to create blob for bin/x.png: 500 - boom");
  });
});

describe("buildTreeEntry", () => {
  it("inlines text files as content without any API call", async () => {
    const { fetchFn, calls } = scriptedFetch([]);

    const entry = await buildTreeEntry({
      ...target,
      path: "src/a.ts",
      mode: "100644",
      content: Buffer.from("const a = 1;\n"),
      fetchFn,
    });

    expect(entry).toEqual({
      path: "src/a.ts",
      mode: "100644",
      type: "blob",
      content: "const a = 1;\n",
    });
    expect(calls).toHaveLength(0);
  });

  it("uploads binary files as blobs and references them by sha", async () => {
    const { fetchFn, calls } = scriptedFetch([
      { status: 201, body: { sha: "blob1" } },
    ]);
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);

    const entry = await buildTreeEntry({
      ...target,
      path: "img.png",
      mode: "100755",
      content: bytes,
      fetchFn,
    });

    expect(entry).toEqual({
      path: "img.png",
      mode: "100755",
      type: "blob",
      sha: "blob1",
    });
    expect(entry).not.toHaveProperty("content");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: `${API}/git/blobs`,
      method: "POST",
      body: { content: bytes.toString("base64"), encoding: "base64" },
    });
  });
});

describe("createTree", () => {
  const entries: GitHubTreeEntry[] = [
    { path: "src/a.ts", mode: "100644", type: "blob", content: "text" },
    { path: "img.png", mode: "100644", type: "blob", sha: "blob1" },
    { path: "old.txt", mode: "100644", type: "blob", sha: null },
  ];

  it("posts the entries on top of the base tree and returns the new tree sha", async () => {
    const { fetchFn, calls } = scriptedFetch([
      { status: 201, body: { sha: "tree2" } },
    ]);

    const sha = await createTree({
      ...target,
      baseTreeSha: "tree1",
      entries,
      fetchFn,
    });

    expect(sha).toBe("tree2");
    expect(calls).toEqual([
      {
        url: `${API}/git/trees`,
        method: "POST",
        headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
        body: { base_tree: "tree1", tree: entries },
      },
    ]);
  });

  it("includes the response body when creating the tree fails", async () => {
    const { fetchFn } = scriptedFetch([{ status: 500, text: "boom" }]);

    await expect(
      createTree({ ...target, baseTreeSha: "tree1", entries, fetchFn }),
    ).rejects.toThrow("Failed to create tree: 500 - boom");
  });
});

describe("createCommit", () => {
  it("creates a commit for the tree with the parent and returns its details", async () => {
    const { fetchFn, calls } = scriptedFetch([
      {
        status: 201,
        body: {
          sha: "c1",
          message: "msg",
          author: { name: "bot", date: "2026-10-06T00:00:00Z" },
          extra: "ignored",
        },
      },
    ]);

    const commit = await createCommit({
      ...target,
      message: "msg",
      treeSha: "tree2",
      parentSha: "abc",
      fetchFn,
    });

    expect(commit).toEqual({
      sha: "c1",
      message: "msg",
      author: { name: "bot", date: "2026-10-06T00:00:00Z" },
    });
    expect(calls).toEqual([
      {
        url: `${API}/git/commits`,
        method: "POST",
        headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
        body: { message: "msg", tree: "tree2", parents: ["abc"] },
      },
    ]);
  });

  it("includes the response body when creating the commit fails", async () => {
    const { fetchFn } = scriptedFetch([{ status: 500, text: "boom" }]);

    await expect(
      createCommit({
        ...target,
        message: "msg",
        treeSha: "tree2",
        parentSha: "abc",
        fetchFn,
      }),
    ).rejects.toThrow("Failed to create commit: 500 - boom");
  });
});
