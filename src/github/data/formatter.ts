import type {
  GitHubPullRequest,
  GitHubIssue,
  GitHubComment,
  GitHubFile,
  GitHubReview,
} from "../types";
import type { GitHubFileWithSHA } from "./fetcher";
import { sanitizeContent } from "../utils/sanitizer";
import {
  DEFAULT_PROMPT_BUDGET,
  keepNewest,
  truncateText,
  type PromptBudget,
} from "../../create-prompt/budget";

// Every formatter sanitizes GitHub content BEFORE truncating it. Cutting
// first could leave an unterminated HTML comment or tag that the sanitizer no
// longer recognizes, reopening the hidden-content channel it exists to close.

function formatLabels(labelNodes: Array<{ name: string }>): string {
  if (labelNodes.length === 0) return "none";
  return labelNodes.map((l) => l.name).join(", ");
}

function replaceImageUrls(
  text: string,
  imageUrlMap: Map<string, string> | undefined,
): string {
  if (!imageUrlMap) return text;
  let processed = text;
  for (const [originalUrl, localPath] of imageUrlMap) {
    processed = processed.replaceAll(originalUrl, localPath);
  }
  return processed;
}

export function formatContext(
  contextData: GitHubPullRequest | GitHubIssue,
  isPR: boolean,
): string {
  if (isPR) {
    const prData = contextData as GitHubPullRequest;
    const sanitizedTitle = sanitizeContent(prData.title);
    return `PR Title: ${sanitizedTitle}
PR Author: ${prData.author?.login ?? "ghost"}
PR Branch: ${prData.headRefName} -> ${prData.baseRefName}
PR State: ${prData.state}
PR Labels: ${formatLabels(prData.labels.nodes)}
PR Additions: ${prData.additions}
PR Deletions: ${prData.deletions}
Total Commits: ${prData.commits.totalCount}
Changed Files: ${prData.files ? `${prData.files.nodes.length} files` : "unknown (file list unavailable)"}`;
  } else {
    const issueData = contextData as GitHubIssue;
    const sanitizedTitle = sanitizeContent(issueData.title);
    return `Issue Title: ${sanitizedTitle}
Issue Author: ${issueData.author?.login ?? "ghost"}
Issue State: ${issueData.state}
Issue Labels: ${formatLabels(issueData.labels.nodes)}`;
  }
}

export function formatBody(
  body: string,
  imageUrlMap: Map<string, string>,
  maxChars: number = DEFAULT_PROMPT_BUDGET.maxBodyChars,
): string {
  const processedBody = sanitizeContent(replaceImageUrls(body, imageUrlMap));
  return truncateText(processedBody, maxChars, "body");
}

export function formatComments(
  comments: GitHubComment[],
  imageUrlMap?: Map<string, string>,
  budget: Pick<
    PromptBudget,
    "maxCommentChars" | "maxCommentsChars"
  > = DEFAULT_PROMPT_BUDGET,
): string {
  const visibleComments = comments.filter((comment) => !comment.isMinimized);

  const renderComment = (comment: GitHubComment): string => {
    const body = truncateText(
      sanitizeContent(replaceImageUrls(comment.body, imageUrlMap)),
      budget.maxCommentChars,
      "comment",
    );
    return `[${comment.author?.login ?? "ghost"} at ${comment.createdAt}]: ${body}`;
  };

  // Chronological order is kept; when the section overflows, the oldest
  // comments are the ones dropped.
  return keepNewest(
    visibleComments,
    renderComment,
    budget.maxCommentsChars,
    "comments",
  ).text;
}

export function formatReviewComments(
  reviewData: { nodes: GitHubReview[] } | null,
  imageUrlMap?: Map<string, string>,
  budget: Pick<
    PromptBudget,
    "maxCommentChars" | "maxReviewsChars" | "maxDiffHunkChars"
  > = DEFAULT_PROMPT_BUDGET,
): string {
  if (!reviewData || !reviewData.nodes) {
    return "";
  }

  const renderReview = (review: GitHubReview): string => {
    let reviewOutput = `[Review by ${review.author?.login ?? "ghost"} at ${review.submittedAt}]: ${review.state}`;

    if (review.body && review.body.trim()) {
      const body = truncateText(
        sanitizeContent(replaceImageUrls(review.body, imageUrlMap)),
        budget.maxCommentChars,
        "review",
      );
      reviewOutput += `\n${body}`;
    }

    const inlineComments = (review.comments?.nodes ?? [])
      .filter((comment) => !comment.isMinimized)
      .map((comment) => {
        const body = truncateText(
          sanitizeContent(replaceImageUrls(comment.body, imageUrlMap)),
          budget.maxCommentChars,
          "comment",
        );

        let formatted = `  [Comment on ${comment.path}:${comment.line || "?"}]: ${body}`;

        // The diff hunk is the code the comment was left on. Without it the
        // comment arrives without the context it was written against.
        if (comment.diffHunk) {
          const diffHunk = truncateText(
            sanitizeContent(comment.diffHunk),
            budget.maxDiffHunkChars,
            "diff hunk",
          );
          formatted += `\n  Diff context:\n\`\`\`diff\n${diffHunk}\n\`\`\``;
        }

        return formatted;
      })
      .join("\n");
    if (inlineComments) {
      reviewOutput += `\n${inlineComments}`;
    }

    return reviewOutput;
  };

  return keepNewest(
    reviewData.nodes,
    renderReview,
    budget.maxReviewsChars,
    "reviews",
  ).text;
}

function joinFileLines(
  lines: string[],
  totalFiles: number,
  maxFiles: number,
): string {
  if (totalFiles <= maxFiles) {
    return lines.join("\n");
  }
  return [...lines, `[… ${totalFiles - maxFiles} more files …]`].join("\n");
}

export function formatChangedFiles(
  changedFiles: GitHubFile[],
  maxFiles: number = DEFAULT_PROMPT_BUDGET.maxChangedFiles,
): string {
  const lines = changedFiles
    .slice(0, maxFiles)
    .map(
      (file) =>
        `- ${file.path} (${file.changeType}) +${file.additions}/-${file.deletions}`,
    );
  return joinFileLines(lines, changedFiles.length, maxFiles);
}

export function formatChangedFilesWithSHA(
  changedFiles: GitHubFileWithSHA[],
  maxFiles: number = DEFAULT_PROMPT_BUDGET.maxChangedFiles,
): string {
  const lines = changedFiles
    .slice(0, maxFiles)
    .map(
      (file) =>
        `- ${file.path} (${file.changeType}) +${file.additions}/-${file.deletions} SHA: ${file.sha}`,
    );
  return joinFileLines(lines, changedFiles.length, maxFiles);
}
