/**
 * GitHub-related constants used throughout the application
 */

/**
 * Claude App bot user ID
 */
export const CLAUDE_APP_BOT_ID = 41898282;

/**
 * Claude bot username
 */
export const CLAUDE_BOT_LOGIN = "claude[bot]";

/**
 * Maximum length of an issue/PR comment body accepted by the GitHub API.
 * Longer bodies are rejected with HTTP 422 ("Body is too long").
 */
export const GITHUB_COMMENT_MAX_LENGTH = 65536;

/**
 * Maximum size (in bytes) of the GitHub Actions step summary file.
 * Larger summaries are dropped by the runner with an error.
 */
export const GITHUB_STEP_SUMMARY_MAX_BYTES = 1048576;

export const CLAUDE_GITHUB_APP_USER_ID = 209825114; // GitHub user id of the Claude app's bot account used for sticky-comment author matching (distinct from CLAUDE_APP_BOT_ID used for git identity)
