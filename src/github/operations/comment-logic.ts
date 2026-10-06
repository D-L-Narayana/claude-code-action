import { GITHUB_SERVER_URL } from "../api/config";
import { GITHUB_COMMENT_MAX_LENGTH } from "../constants";
import { redactSecrets } from "../utils/sanitizer";
import { encodeBranchNameForUrl, openCodeFence } from "./comments/common";

function truncationMarker(droppedCharacters: number): string {
  return `\n\n…[truncated ${droppedCharacters} characters]…`;
}

/** Step `index` back by one if it would split a UTF-16 surrogate pair. */
function alignToCodePoint(text: string, index: number): number {
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  const splitsPair =
    before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
  return splitsPair ? index - 1 : index;
}

/**
 * Cut `body` so it fits GitHub's comment size limit, which the API enforces
 * with a 422 on the final update. The leading header block that
 * updateCommentBody emits (status line, links and any error code block,
 * everything through the first "\n\n---\n" separator) survives whenever it
 * fits; the trailing content is dropped behind a marker that says how many
 * characters are missing. When even the header does not fit, it is hard-cut
 * the same way. A code block the cut lands inside is closed first so the
 * marker renders as text instead of as more code.
 *
 * Length is measured in UTF-16 code units (String.length). GitHub counts
 * characters, and a code unit count is never smaller than a character count,
 * so a body that passes this check cannot exceed the limit however GitHub
 * tallies it; it is also the native string length, so the only cut-site
 * concern is not splitting a surrogate pair.
 */
export function truncateForGitHubComment(
  body: string,
  maxLength: number = GITHUB_COMMENT_MAX_LENGTH,
): string {
  if (body.length <= maxLength) {
    return body;
  }

  // Reserve room for the longest marker that could be emitted so the exact
  // count can be filled in after the cut without pushing past the limit.
  const reserved = truncationMarker(body.length).length;
  let cut = alignToCodePoint(body, Math.max(0, maxLength - reserved));
  let closer = "";
  for (;;) {
    const fence = openCodeFence(body.slice(0, cut));
    closer = fence ? `\n${fence}` : "";
    if (cut === 0 || cut + closer.length + reserved <= maxLength) {
      break;
    }
    // The closer needs room of its own; move the cut back and re-check, since
    // the block it closes may itself have started inside the removed span.
    cut = alignToCodePoint(body, Math.max(0, cut - closer.length));
  }

  return `${body.slice(0, cut)}${closer}${truncationMarker(body.length - cut)}`;
}

export type ExecutionDetails = {
  total_cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
};

export type CommentUpdateInput = {
  currentBody: string;
  actionFailed: boolean;
  executionDetails: ExecutionDetails | null;
  jobUrl: string;
  branchLink?: string;
  prLink?: string;
  branchName?: string;
  triggerUsername?: string;
  errorDetails?: string;
};

export function ensureProperlyEncodedUrl(url: string): string | null {
  try {
    // First, try to parse the URL to see if it's already properly encoded
    new URL(url);
    if (url.includes(" ")) {
      const [baseUrl, queryString] = url.split("?");
      if (queryString) {
        // Parse query parameters and re-encode them properly
        const params = new URLSearchParams();
        const pairs = queryString.split("&");
        for (const pair of pairs) {
          const [key, value = ""] = pair.split("=");
          if (key) {
            // Decode first in case it's partially encoded, then encode properly
            params.set(key, decodeURIComponent(value));
          }
        }
        return `${baseUrl}?${params.toString()}`;
      }
      // If no query string, just encode spaces
      return url.replace(/ /g, "%20");
    }
    return url;
  } catch (e) {
    // If URL parsing fails, try basic fixes
    try {
      // Replace spaces with %20
      let fixedUrl = url.replace(/ /g, "%20");

      // Ensure colons in parameter values are encoded (but not in http:// or after domain)
      const urlParts = fixedUrl.split("?");
      if (urlParts.length > 1 && urlParts[1]) {
        const [baseUrl, queryString] = urlParts;
        // Encode colons in the query string that aren't already encoded
        const fixedQuery = queryString.replace(/([^%]|^):(?!%2F%2F)/g, "$1%3A");
        fixedUrl = `${baseUrl}?${fixedQuery}`;
      }

      // Try to validate the fixed URL
      new URL(fixedUrl);
      return fixedUrl;
    } catch {
      // If we still can't create a valid URL, return null
      return null;
    }
  }
}

export function updateCommentBody(input: CommentUpdateInput): string {
  const originalBody = input.currentBody;
  const {
    executionDetails,
    jobUrl,
    branchLink,
    prLink,
    actionFailed,
    branchName,
    triggerUsername,
    errorDetails,
  } = input;

  // Extract content from the original comment body
  // First, remove the "Claude Code is working…" or "Claude Code is working..." message
  const workingPattern = /Claude Code is working[…\.]{1,3}(?:\s*<img[^>]*>)?/i;
  let bodyContent = originalBody.replace(workingPattern, "").trim();

  // Check if there's a PR link in the content
  let prLinkFromContent = "";

  // Match the entire markdown link structure
  const prLinkPattern = /\[Create .* PR\]\((.*)\)$/m;
  const prLinkMatch = bodyContent.match(prLinkPattern);

  if (prLinkMatch && prLinkMatch[1]) {
    const encodedUrl = ensureProperlyEncodedUrl(prLinkMatch[1]);
    if (encodedUrl) {
      prLinkFromContent = encodedUrl;
      // Remove the PR link from the content
      bodyContent = bodyContent.replace(prLinkMatch[0], "").trim();
    }
  }

  // Calculate duration string if available
  let durationStr = "";
  if (executionDetails?.duration_ms !== undefined) {
    const totalSeconds = Math.round(executionDetails.duration_ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    durationStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
  }

  // Build the header
  let header = "";

  if (actionFailed) {
    header = "**Claude encountered an error";
    if (durationStr) {
      header += ` after ${durationStr}`;
    }
    header += "**";
  } else {
    // Get the username from triggerUsername or extract from content
    const usernameMatch = bodyContent.match(/@([a-zA-Z0-9-]+)/);
    const username =
      triggerUsername || (usernameMatch ? usernameMatch[1] : "user");

    header = `**Claude finished @${username}'s task`;
    if (durationStr) {
      header += ` in ${durationStr}`;
    }
    header += "**";
  }

  // Add links section
  let links = ` —— [View job](${jobUrl})`;

  // Add branch name with link
  if (branchName || branchLink) {
    let finalBranchName = branchName;
    let branchUrl = "";

    if (branchLink) {
      // Extract the branch URL from the link
      const urlMatch = branchLink.match(/\((https:\/\/.*)\)/);
      if (urlMatch && urlMatch[1]) {
        branchUrl = urlMatch[1];
      }

      // Extract branch name from link if not provided
      if (!finalBranchName) {
        const branchNameMatch = branchLink.match(/tree\/([^"'\)]+)/);
        if (branchNameMatch) {
          finalBranchName = branchNameMatch[1];
        }
      }
    }

    // If we don't have a URL yet but have a branch name, construct it
    if (!branchUrl && finalBranchName) {
      // Extract owner/repo from jobUrl
      const repoMatch = jobUrl.match(/github\.com\/([^\/]+)\/([^\/]+)\//);
      if (repoMatch) {
        branchUrl = `${GITHUB_SERVER_URL}/${repoMatch[1]}/${repoMatch[2]}/tree/${encodeBranchNameForUrl(finalBranchName)}`;
      }
    }

    if (finalBranchName && branchUrl) {
      links += ` • [\`${finalBranchName}\`](${branchUrl})`;
    } else if (finalBranchName) {
      links += ` • \`${finalBranchName}\``;
    }
  }

  // Add PR link (either from content or provided)
  const prUrl =
    prLinkFromContent || (prLink ? prLink.match(/\(([^)]+)\)/)?.[1] : "");
  if (prUrl) {
    links += ` • [Create PR ➔](${prUrl})`;
  }

  // Build the new body with blank line between header and separator
  let newBody = `${header}${links}`;

  // Add error details if available. The message may embed runtime credentials
  // (e.g. a token in a git remote URL) that are not registered as workflow
  // secrets, so redact known formats before posting.
  if (actionFailed && errorDetails) {
    newBody += `\n\n\`\`\`\n${redactSecrets(errorDetails)}\n\`\`\``;
  }

  newBody += `\n\n---\n`;

  // Clean up the body content
  // Remove any existing View job run, branch links from the bottom
  bodyContent = bodyContent.replace(/\n?\[View job run\]\([^\)]+\)/g, "");
  bodyContent = bodyContent.replace(/\n?\[View branch\]\([^\)]+\)/g, "");

  // Remove any existing duration info at the bottom
  bodyContent = bodyContent.replace(/\n*---\n*Duration: [0-9]+m? [0-9]+s/g, "");

  // Add the cleaned body content
  newBody += bodyContent;

  // Claude's progress updates can grow the tracked body right up to the
  // limit; adding the header on top must not turn the final PATCH into a 422.
  return truncateForGitHubComment(newBody.trim());
}
