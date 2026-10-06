import { existsSync, readFileSync, writeFileSync } from "fs";

export type BufferedComment = {
  ts: string;
  path: string;
  line?: number;
  startLine?: number;
  side?: "LEFT" | "RIGHT";
  commit_id?: string;
  body: string;
  confirmed?: boolean;
};

export type ReadBufferedCommentsResult = {
  entries: BufferedComment[];
  malformed: number;
};

// Every component is reduced to this alphabet before it becomes part of a file
// name, so values coming from the workflow environment can never introduce
// path separators or shell metacharacters.
const UNSAFE_PATH_CHARS = /[^A-Za-z0-9_.-]/g;

function sanitizePathComponent(value: string | undefined): string {
  if (!value) {
    return "unknown";
  }
  return value.replace(UNSAFE_PATH_CHARS, "_");
}

/**
 * Location of the inline-comment buffer for the current repository, PR and
 * workflow run.
 *
 * The buffer used to be a single fixed file under /tmp. On non-ephemeral
 * (self-hosted) runners that file survived from one job to the next, so
 * comments buffered for one PR were replayed onto whichever PR ran next, and
 * concurrent jobs on the same runner appended into each other's buffer. Keying
 * the file by repository, PR and run id makes each job's buffer private.
 *
 * Both the MCP server (writer) and the post-step (reader) derive the path from
 * the same environment variables, so they must receive identical values for
 * REPO_OWNER, REPO_NAME, PR_NUMBER, RUNNER_TEMP and GITHUB_RUN_ID. The
 * sanitized components are embedded between fixed separators, so the resulting
 * file name can never collapse to "." or "..".
 */
export function getInlineCommentBufferPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const root = env.RUNNER_TEMP || "/tmp";
  const owner = sanitizePathComponent(env.REPO_OWNER);
  const repo = sanitizePathComponent(env.REPO_NAME);
  const pr = sanitizePathComponent(env.PR_NUMBER);
  const runId = env.GITHUB_RUN_ID
    ? sanitizePathComponent(env.GITHUB_RUN_ID)
    : "local";
  return `${root}/claude-inline-comments/${owner}__${repo}__pr${pr}__run${runId}.jsonl`;
}

function isBufferedComment(value: unknown): value is BufferedComment {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.path === "string" && typeof record.body === "string";
}

/**
 * Read the JSONL buffer, tolerating damaged lines.
 *
 * The buffer is appended to by a separate process while the session runs, so a
 * truncated or interleaved write must not take every other comment down with
 * it: unparsable lines and lines that are not comment objects are counted in
 * `malformed` and skipped instead of aborting the whole read. A missing file
 * simply means nothing was buffered.
 */
export function readBufferedComments(path: string): ReadBufferedCommentsResult {
  if (!existsSync(path)) {
    return { entries: [], malformed: 0 };
  }

  const entries: BufferedComment[] = [];
  let malformed = 0;

  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }

    if (isBufferedComment(parsed)) {
      entries.push(parsed);
    } else {
      malformed++;
    }
  }

  return { entries, malformed };
}

export type BufferedCommentMatch = {
  path: string;
  line?: number;
  startLine?: number;
  body: string;
};

/**
 * Remove any buffered inline comment that matches an already-posted comment.
 *
 * When a comment is posted live (confirmed=true), an earlier buffered copy of
 * the same comment must be dropped so the post-session replay step does not
 * post it a second time. The model frequently re-issues a buffered call with
 * confirmed=true after reading the "Set confirmed=true to post immediately"
 * reply; previously the original buffered entry was left behind and replayed,
 * producing duplicate inline comments.
 *
 * Entries are matched on path, line, startLine and body. Lines that cannot be
 * parsed are kept untouched.
 */
export function removeBufferedComment(
  match: BufferedCommentMatch,
  bufferPath: string,
): void {
  if (!existsSync(bufferPath)) {
    return;
  }

  const remaining = readFileSync(bufferPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .filter((line) => {
      let entry: BufferedCommentMatch;
      try {
        entry = JSON.parse(line);
      } catch {
        // Keep anything we cannot parse rather than silently dropping it.
        return true;
      }
      const isSameComment =
        entry.path === match.path &&
        entry.line === match.line &&
        entry.startLine === match.startLine &&
        entry.body === match.body;
      return !isSameComment;
    });

  writeFileSync(
    bufferPath,
    remaining.length > 0 ? remaining.join("\n") + "\n" : "",
  );
}
