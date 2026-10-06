import fetch, { type RequestInit, type Response } from "node-fetch";
import { GITHUB_API_URL } from "../github/api/config";
import { isBinaryContent } from "./binary-detection";

/**
 * Thin, dependency-injectable wrappers around the GitHub Git Data API calls the
 * file-ops MCP server performs. Keeping them here (rather than inline in the
 * server) lets the request shapes and error texts be unit-tested with a
 * scripted `fetchFn` while the server stays a thin tool-dispatch layer.
 */

export type GitHubApiResponse = Pick<
  Response,
  "ok" | "status" | "text" | "json"
>;

export type GitHubApiFetch = (
  url: string,
  init?: RequestInit,
) => Promise<GitHubApiResponse>;

type RepoTarget = {
  owner: string;
  repo: string;
  githubToken: string;
  fetchFn?: GitHubApiFetch;
};

export type GetOrCreateBranchRefOptions = RepoTarget & {
  branch: string;
  /** Branch to fork from when `branch` does not exist yet (BASE_BRANCH). */
  baseBranch?: string;
};

export type GetBaseTreeShaOptions = RepoTarget & { commitSha: string };

export type CreateBlobOptions = RepoTarget & { path: string; content: Buffer };

export type BuildTreeEntryOptions = CreateBlobOptions & { mode: string };

export type GitHubTreeEntry = {
  path: string;
  mode: string;
  type: "blob";
  /** Blob sha for binary files; `null` deletes the path from the tree. */
  sha?: string | null;
  /** Inline UTF-8 content for text files. */
  content?: string;
};

export type CreateTreeOptions = RepoTarget & {
  baseTreeSha: string;
  entries: GitHubTreeEntry[];
};

export type CreateCommitOptions = RepoTarget & {
  message: string;
  treeSha: string;
  parentSha: string;
};

export type GitHubNewCommit = {
  sha: string;
  message: string;
  author: { name: string; date: string };
};

type GitHubRef = { object: { sha: string } };

export function githubHeaders(
  token: string,
  options: { json?: boolean } = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (options.json) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

type RefLookup = { status: number; sha?: string };

async function lookupRefSha(
  url: string,
  githubToken: string,
  fetchFn: GitHubApiFetch,
): Promise<RefLookup> {
  const response = await fetchFn(url, { headers: githubHeaders(githubToken) });
  if (!response.ok) {
    return { status: response.status };
  }
  const data = (await response.json()) as GitHubRef;
  return { status: response.status, sha: data.object.sha };
}

/**
 * Resolve the head sha of `branch`, creating the branch when it does not exist.
 *
 * A new branch is forked from `baseBranch`; if that branch cannot be found the
 * repository's default branch is used instead, matching what the action does
 * when it creates branches itself. Creating a branch without knowing the base
 * is refused explicitly instead of forking from an undefined ref.
 */
export async function getOrCreateBranchRef({
  owner,
  repo,
  branch,
  baseBranch,
  githubToken,
  fetchFn = fetch,
}: GetOrCreateBranchRefOptions): Promise<string> {
  const repoUrl = `${GITHUB_API_URL}/repos/${owner}/${repo}`;

  const ref = await lookupRefSha(
    `${repoUrl}/git/refs/heads/${branch}`,
    githubToken,
    fetchFn,
  );
  if (ref.sha !== undefined) {
    return ref.sha;
  }
  if (ref.status !== 404) {
    throw new Error(`Failed to get branch reference: ${ref.status}`);
  }

  if (!baseBranch) {
    throw new Error(
      `BASE_BRANCH environment variable is required to create branch '${branch}'`,
    );
  }

  let baseSha: string;
  const baseRef = await lookupRefSha(
    `${repoUrl}/git/refs/heads/${baseBranch}`,
    githubToken,
    fetchFn,
  );

  if (baseRef.sha !== undefined) {
    baseSha = baseRef.sha;
  } else {
    // The base branch does not exist; fall back to the repository default.
    const repoResponse = await fetchFn(repoUrl, {
      headers: githubHeaders(githubToken),
    });
    if (!repoResponse.ok) {
      throw new Error(`Failed to get repository info: ${repoResponse.status}`);
    }
    const repoData = (await repoResponse.json()) as { default_branch: string };

    const defaultRef = await lookupRefSha(
      `${repoUrl}/git/refs/heads/${repoData.default_branch}`,
      githubToken,
      fetchFn,
    );
    if (defaultRef.sha === undefined) {
      throw new Error(
        `Failed to get default branch reference: ${defaultRef.status}`,
      );
    }
    baseSha = defaultRef.sha;
  }

  const createRefResponse = await fetchFn(`${repoUrl}/git/refs`, {
    method: "POST",
    headers: githubHeaders(githubToken, { json: true }),
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
  });
  if (!createRefResponse.ok) {
    const errorText = await createRefResponse.text();
    throw new Error(
      `Failed to create branch: ${createRefResponse.status} - ${errorText}`,
    );
  }

  // stderr: in a stdio MCP server stdout carries the protocol stream, so a
  // plain log line there would corrupt a JSON-RPC message.
  console.error(`Successfully created branch ${branch}`);
  return baseSha;
}

/** Tree sha of the commit a new tree will be built on top of. */
export async function getBaseTreeSha({
  owner,
  repo,
  commitSha,
  githubToken,
  fetchFn = fetch,
}: GetBaseTreeShaOptions): Promise<string> {
  const response = await fetchFn(
    `${GITHUB_API_URL}/repos/${owner}/${repo}/git/commits/${commitSha}`,
    { headers: githubHeaders(githubToken) },
  );
  if (!response.ok) {
    throw new Error(`Failed to get base commit: ${response.status}`);
  }
  const data = (await response.json()) as { tree: { sha: string } };
  return data.tree.sha;
}

/**
 * Upload file bytes as a base64 blob. Only the Blobs API accepts an encoding,
 * so this is the path binary files have to take; inlining them as tree
 * `content` would run them through a lossy UTF-8 decode.
 */
export async function createBlob({
  owner,
  repo,
  path,
  content,
  githubToken,
  fetchFn = fetch,
}: CreateBlobOptions): Promise<string> {
  const response = await fetchFn(
    `${GITHUB_API_URL}/repos/${owner}/${repo}/git/blobs`,
    {
      method: "POST",
      headers: githubHeaders(githubToken, { json: true }),
      body: JSON.stringify({
        content: content.toString("base64"),
        encoding: "base64",
      }),
    },
  );
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to create blob for ${path}: ${response.status} - ${errorText}`,
    );
  }
  const data = (await response.json()) as { sha: string };
  return data.sha;
}

/**
 * Build the tree entry for one file: text is inlined, binary content is
 * uploaded as a blob and referenced by sha.
 */
export async function buildTreeEntry(
  options: BuildTreeEntryOptions,
): Promise<GitHubTreeEntry> {
  const { path, mode, content } = options;
  if (isBinaryContent(content)) {
    return { path, mode, type: "blob", sha: await createBlob(options) };
  }
  return { path, mode, type: "blob", content: content.toString("utf-8") };
}

export async function createTree({
  owner,
  repo,
  baseTreeSha,
  entries,
  githubToken,
  fetchFn = fetch,
}: CreateTreeOptions): Promise<string> {
  const response = await fetchFn(
    `${GITHUB_API_URL}/repos/${owner}/${repo}/git/trees`,
    {
      method: "POST",
      headers: githubHeaders(githubToken, { json: true }),
      body: JSON.stringify({ base_tree: baseTreeSha, tree: entries }),
    },
  );
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create tree: ${response.status} - ${errorText}`);
  }
  const data = (await response.json()) as { sha: string };
  return data.sha;
}

export async function createCommit({
  owner,
  repo,
  message,
  treeSha,
  parentSha,
  githubToken,
  fetchFn = fetch,
}: CreateCommitOptions): Promise<GitHubNewCommit> {
  const response = await fetchFn(
    `${GITHUB_API_URL}/repos/${owner}/${repo}/git/commits`,
    {
      method: "POST",
      headers: githubHeaders(githubToken, { json: true }),
      body: JSON.stringify({ message, tree: treeSha, parents: [parentSha] }),
    },
  );
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to create commit: ${response.status} - ${errorText}`,
    );
  }
  const data = (await response.json()) as GitHubNewCommit;
  return {
    sha: data.sha,
    message: data.message,
    author: { name: data.author.name, date: data.author.date },
  };
}
