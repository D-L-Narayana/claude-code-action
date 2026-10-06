#!/usr/bin/env bun
/**
 * Reads buffered inline-comment calls from this run's buffer file (see
 * getInlineCommentBufferPath), classifies each as "real review" vs
 * "test/probe" using Haiku, and posts only the real ones. Calls with
 * confirmed=false are never posted.
 *
 * If the Anthropic API is unavailable (Bedrock/Vertex users without a direct
 * key), falls back to posting everything with confirmed !== false. This
 * preserves backward compatibility — before this change, all unconfirmed
 * calls posted immediately.
 *
 * The buffer file is deleted once it has been processed so a later job on the
 * same (non-ephemeral) runner can never replay it.
 */
import { rmSync } from "fs";
import { createOctokit } from "../github/api/client";
import { truncateForGitHubComment } from "../github/operations/comment-logic";
import { redactSecrets } from "../github/utils/sanitizer";
import {
  getInlineCommentBufferPath,
  readBufferedComments,
  type BufferedComment,
} from "../mcp/inline-comment-buffer";

type ReviewCommentParams = NonNullable<
  Parameters<
    ReturnType<typeof createOctokit>["rest"]["pulls"]["createReviewComment"]
  >[0]
>;

/** The slice of the Octokit REST client this step needs. */
export type PostBufferedOctokit = {
  pulls: {
    get: (params: {
      owner: string;
      repo: string;
      pull_number: number;
    }) => Promise<{ data: { head: { sha: string } } }>;
    createReviewComment: (params: ReviewCommentParams) => Promise<unknown>;
  };
};

/** The slice of `fetch` the default classifier needs (global fetch fits). */
export type ClassifierFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export type PostBufferedDeps = {
  env?: NodeJS.ProcessEnv;
  octokit?: PostBufferedOctokit;
  classify?: (
    bodies: string[],
    apiKey: string,
    model: string,
  ) => Promise<boolean[] | null>;
  fetchFn?: ClassifierFetch;
  log?: (message: string) => void;
};

export type PostBufferedResult = {
  /** Well-formed entries read from the buffer (before de-duplication). */
  found: number;
  /** Lines that could not be parsed as buffered comments and were skipped. */
  malformed: number;
  /** Entries buffered with confirmed=false. */
  neverPost: number;
  /** Candidates the classifier marked as test/probe. */
  filtered: number;
  posted: number;
  failed: number;
  bufferPath: string;
};

export const DEFAULT_CLASSIFIER_MODEL = "claude-haiku-4-5";

const CLASSIFICATION_PROMPT = `You are classifying PR inline comments as either REAL code review feedback or TEST/PROBE calls.

A TEST/PROBE call is when an automated agent is checking whether a commenting tool works. These typically:
- Start with phrases like "Test comment", "Testing if", "Can I", "Does this work", "Checking if"
- Have generic/placeholder content not specific to any code
- Exist to verify tool functionality, not to provide review feedback

A REAL review comment:
- Discusses specific code, logic, bugs, or style
- Provides actionable feedback for the PR author
- References concrete aspects of the change

For each numbered comment body below, respond with ONLY a JSON array of booleans where true = REAL review comment, false = test/probe. No other text.

Comments:
`;

function isBooleanArray(value: unknown): value is boolean[] {
  return (
    Array.isArray(value) && value.every((v: unknown) => typeof v === "boolean")
  );
}

async function classifyWithAnthropic(
  bodies: string[],
  apiKey: string,
  model: string,
  fetchFn: ClassifierFetch,
  log: (message: string) => void,
): Promise<boolean[] | null> {
  const prompt =
    CLASSIFICATION_PROMPT +
    bodies.map((b, i) => `${i + 1}. ${JSON.stringify(b)}`).join("\n");

  try {
    const res = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      log(
        `Classification API returned ${res.status} — posting all unconfirmed comments`,
      );
      return null;
    }

    const data = (await res.json()) as {
      content: { type: string; text: string }[];
    };
    const text = data.content.find((c) => c.type === "text")?.text ?? "";
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) {
      log(
        "Could not parse classification response — posting all unconfirmed comments",
      );
      return null;
    }
    const parsed: unknown = JSON.parse(match[0]);
    if (!isBooleanArray(parsed) || parsed.length !== bodies.length) {
      log(
        "Classification response shape mismatch — posting all unconfirmed comments",
      );
      return null;
    }
    return parsed;
  } catch (e) {
    log(
      `Classification failed (${e instanceof Error ? e.message : String(e)}) — posting all unconfirmed comments`,
    );
    return null;
  }
}

/**
 * Final body sent to GitHub: secrets redacted (the server already redacts
 * before buffering; this is defense-in-depth for anything written to the
 * buffer by other means) and bounded to the API's maximum comment length so a
 * single oversized comment cannot fail with a 422 after classification. The
 * shared truncation helper is used so every comment the action posts carries
 * the same "…[truncated N characters]…" marker described in docs/limits.md.
 */
function prepareBody(body: string): string {
  return truncateForGitHubComment(redactSecrets(body));
}

// The model often re-issues the same buffered call several times (and the
// server appends every call), so identical comments collapse to one post.
function dedupeKey(c: BufferedComment): string {
  return JSON.stringify([c.path, c.line ?? null, c.startLine ?? null, c.body]);
}

async function postComment(
  octokit: PostBufferedOctokit,
  owner: string,
  repo: string,
  pull_number: number,
  headSha: string,
  c: BufferedComment,
  log: (message: string) => void,
): Promise<boolean> {
  const params: ReviewCommentParams = {
    owner,
    repo,
    pull_number,
    body: prepareBody(c.body),
    path: c.path,
    side: c.side || "RIGHT",
    commit_id: c.commit_id || headSha,
  };
  if (c.startLine) {
    params.start_line = c.startLine;
    params.start_side = c.side || "RIGHT";
    params.line = c.line;
  } else {
    params.line = c.line;
  }
  try {
    await octokit.pulls.createReviewComment(params);
    return true;
  } catch (e) {
    log(
      `  failed ${c.path}:${c.line}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}

export async function postBufferedInlineComments(
  deps: PostBufferedDeps = {},
): Promise<PostBufferedResult> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? console.log;
  const fetchFn = deps.fetchFn ?? fetch;
  const classify =
    deps.classify ??
    ((bodies: string[], apiKey: string, model: string) =>
      classifyWithAnthropic(bodies, apiKey, model, fetchFn, log));

  const bufferPath = getInlineCommentBufferPath(env);
  const { entries, malformed } = readBufferedComments(bufferPath);
  const result: PostBufferedResult = {
    found: entries.length,
    malformed,
    neverPost: 0,
    filtered: 0,
    posted: 0,
    failed: 0,
    bufferPath,
  };

  if (malformed > 0) {
    log(
      `::warning::Skipped ${malformed} malformed line(s) in the inline comment buffer (${bufferPath})`,
    );
  }

  if (entries.length === 0) {
    log("No buffered inline comments");
    // Nothing usable is lost by discarding a buffer with no valid entries.
    rmSync(bufferPath, { force: true });
    return result;
  }

  log(`Found ${entries.length} buffered inline comment(s)`);

  const githubToken = env.GITHUB_TOKEN;
  const owner = env.REPO_OWNER;
  const repo = env.REPO_NAME;
  const prNumber = env.PR_NUMBER;

  if (!githubToken || !owner || !repo || !prNumber) {
    // Nothing was posted, so the buffer is deliberately left in place: deleting
    // it here would silently discard the comments, whereas keeping it lets a
    // re-run of this job (same run id) post them and keeps them inspectable.
    log(
      `::warning::Missing GITHUB_TOKEN/REPO_OWNER/REPO_NAME/PR_NUMBER — cannot post buffered comments; keeping ${bufferPath}`,
    );
    return result;
  }

  // Partition: confirmed=false are never posted; everything else is a
  // candidate. Identical calls collapse to a single candidate, and an explicit
  // confirmed=false on any copy vetoes the whole group.
  result.neverPost = entries.filter((c) => c.confirmed === false).length;
  if (result.neverPost > 0) {
    log(`  ${result.neverPost} with confirmed=false — not posting`);
  }

  const groups = new Map<string, BufferedComment[]>();
  for (const entry of entries) {
    const key = dedupeKey(entry);
    const group = groups.get(key);
    if (group) {
      group.push(entry);
    } else {
      groups.set(key, [entry]);
    }
  }
  if (groups.size < entries.length) {
    log(
      `  ${entries.length - groups.size} duplicate buffered call(s) collapsed`,
    );
  }

  const candidates: BufferedComment[] = [];
  for (const group of groups.values()) {
    const [first] = group;
    if (first && !group.some((c) => c.confirmed === false)) {
      candidates.push(first);
    }
  }

  if (candidates.length === 0) {
    rmSync(bufferPath, { force: true });
    return result;
  }

  // Classify candidates
  const apiKey = env.ANTHROPIC_API_KEY;
  const model = env.CLAUDE_INLINE_CLASSIFIER_MODEL || DEFAULT_CLASSIFIER_MODEL;
  let verdicts: boolean[] | null = null;
  if (apiKey) {
    verdicts = await classify(
      candidates.map((c) => c.body),
      apiKey,
      model,
    );
  } else {
    log(
      "ANTHROPIC_API_KEY not set — skipping classification, posting all unconfirmed comments",
    );
  }

  const toPost =
    verdicts === null
      ? candidates
      : candidates.filter((_, i) => verdicts[i] === true);
  const filtered =
    verdicts === null ? [] : candidates.filter((_, i) => verdicts[i] === false);
  result.filtered = filtered.length;

  if (filtered.length > 0) {
    log(
      `::warning::${filtered.length} buffered comment(s) classified as test/probe — NOT posted:`,
    );
    for (const c of filtered) {
      log(`  [${c.path}:${c.line}] ${redactSecrets(c.body).slice(0, 120)}`);
    }
  }

  if (toPost.length === 0) {
    log("No real comments to post");
    rmSync(bufferPath, { force: true });
    return result;
  }

  const octokit: PostBufferedOctokit =
    deps.octokit ?? createOctokit(githubToken).rest;
  const pull_number = parseInt(prNumber, 10);
  const pr = await octokit.pulls.get({ owner, repo, pull_number });
  const headSha = pr.data.head.sha;

  log(`Posting ${toPost.length} classified-as-real comment(s)`);
  for (const c of toPost) {
    if (await postComment(octokit, owner, repo, pull_number, headSha, c, log)) {
      log(`  posted ${c.path}:${c.line}`);
      result.posted++;
    } else {
      result.failed++;
    }
  }
  log(`Posted ${result.posted}/${toPost.length}`);

  // Processed: remove the buffer so a later job on this runner cannot replay it.
  rmSync(bufferPath, { force: true });
  return result;
}

async function main(): Promise<void> {
  await postBufferedInlineComments();
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("post-buffered-inline-comments failed:", e);
    process.exit(1);
  });
}
