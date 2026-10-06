import { GITHUB_SERVER_URL } from "../../api/config";

export const SPINNER_HTML =
  '<img src="https://github.com/user-attachments/assets/5ac382c7-e004-429b-8e35-7feb3e8f9c6f" width="14px" height="14px" style="vertical-align: middle; margin-left: 4px;" />';

export function createJobRunLink(
  owner: string,
  repo: string,
  runId: string,
): string {
  const jobRunUrl = `${GITHUB_SERVER_URL}/${owner}/${repo}/actions/runs/${runId}`;
  return `[View job run](${jobRunUrl})`;
}

// A fence line: up to three spaces of indentation, three or more backticks or
// tildes, then whatever follows (an info string on openers, nothing on closers).
const CODE_FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Return the fence sequence (for example "```" or "~~~~") of a fenced code
 * block that is still open at the end of `text`, or null when every block is
 * closed. Used when a body is cut short: a cut inside a code block would make
 * everything appended afterwards render as code.
 *
 * Follows the CommonMark rules that matter here: a backtick opener's info
 * string may not contain a backtick, a block is only closed by a fence of the
 * same character that is at least as long as its opener, and fence lines of
 * the other character inside a block are plain content.
 */
export function openCodeFence(text: string): string | null {
  let open: string | null = null;
  for (const line of text.split("\n")) {
    const match = CODE_FENCE_LINE.exec(line);
    if (!match) continue;
    const fence = match[1] ?? "";
    const rest = match[2] ?? "";
    if (open === null) {
      if (fence.startsWith("`") && rest.includes("`")) continue;
      open = fence;
    } else if (
      fence[0] === open[0] &&
      fence.length >= open.length &&
      rest.trim() === ""
    ) {
      open = null;
    }
  }
  return open;
}

export function hasUnclosedCodeFence(text: string): boolean {
  return openCodeFence(text) !== null;
}

/** Encode Git-ref path segments without turning `/` into `%2F`. */
export function encodeBranchNameForUrl(branchName: string): string {
  return branchName.split("/").map(encodeURIComponent).join("/");
}

export function createBranchLink(
  owner: string,
  repo: string,
  branchName: string,
): string {
  const branchUrl = `${GITHUB_SERVER_URL}/${owner}/${repo}/tree/${encodeBranchNameForUrl(branchName)}`;
  return `\n[View branch](${branchUrl})`;
}

export function createCommentBody(
  jobRunLink: string,
  branchLink: string = "",
): string {
  return `Claude Code is working… ${SPINNER_HTML}

I'll analyze this and get back to you.

${jobRunLink}${branchLink}`;
}
