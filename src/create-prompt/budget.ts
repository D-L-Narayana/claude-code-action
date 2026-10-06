// Prompt size budget for tag mode.
//
// A long thread or a big PR can carry far more text than fits in the model's
// context window. Every GitHub-derived section of the prompt is bounded here so
// the prompt stays usable. The instruction tail is never cut (see
// create-prompt/index.ts), so a budget that is too small only trims context.

export type PromptBudget = {
  /** Upper bound for the whole prompt. */
  maxTotalChars: number;
  /** The issue/PR body. */
  maxBodyChars: number;
  /** A single comment, review body or inline review comment. */
  maxCommentChars: number;
  /** The whole <comments> section. */
  maxCommentsChars: number;
  /** The whole <review_comments> section. */
  maxReviewsChars: number;
  /** The diff hunk attached to an inline review comment. */
  maxDiffHunkChars: number;
  /** Entries in the changed-files list. */
  maxChangedFiles: number;
};

export const DEFAULT_PROMPT_BUDGET: PromptBudget = {
  maxTotalChars: 300_000,
  maxBodyChars: 40_000,
  maxCommentChars: 10_000,
  maxCommentsChars: 120_000,
  maxReviewsChars: 120_000,
  maxDiffHunkChars: 2_000,
  maxChangedFiles: 300,
};

export const PROMPT_BUDGET_ENV_VAR = "CLAUDE_PROMPT_MAX_CHARS";

// Floors below which a section cannot carry anything meaningful: a truncation
// marker alone is about 40 chars, and an empty file list helps nobody.
const MIN_CHARS = 100;
const MIN_FILES = 1;

const SEPARATOR = "\n\n";

/**
 * Resolves the budget, scaling every field proportionally when
 * CLAUDE_PROMPT_MAX_CHARS overrides the default total. An invalid value is
 * reported and ignored rather than failing the run: a bad knob should not
 * stop Claude from responding.
 */
export function resolvePromptBudget(
  env: NodeJS.ProcessEnv = process.env,
): PromptBudget {
  const raw = env[PROMPT_BUDGET_ENV_VAR];
  if (raw === undefined || raw.trim() === "") {
    return { ...DEFAULT_PROMPT_BUDGET };
  }

  const value = raw.trim();
  const total = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(total) || total <= 0) {
    console.warn(
      `Ignoring ${PROMPT_BUDGET_ENV_VAR}=${JSON.stringify(raw)}: expected a positive integer; using the default prompt budget (${DEFAULT_PROMPT_BUDGET.maxTotalChars} chars)`,
    );
    return { ...DEFAULT_PROMPT_BUDGET };
  }

  const base = DEFAULT_PROMPT_BUDGET.maxTotalChars;
  // Multiply before dividing: a precomputed ratio (total / base) is inexact in
  // binary and could land e.g. 120_000 * (100_000 / 300_000) a hair under
  // 40_000 before flooring.
  const scaleChars = (chars: number): number =>
    Math.max(MIN_CHARS, Math.floor((chars * total) / base));

  return {
    maxTotalChars: scaleChars(DEFAULT_PROMPT_BUDGET.maxTotalChars),
    maxBodyChars: scaleChars(DEFAULT_PROMPT_BUDGET.maxBodyChars),
    maxCommentChars: scaleChars(DEFAULT_PROMPT_BUDGET.maxCommentChars),
    maxCommentsChars: scaleChars(DEFAULT_PROMPT_BUDGET.maxCommentsChars),
    maxReviewsChars: scaleChars(DEFAULT_PROMPT_BUDGET.maxReviewsChars),
    maxDiffHunkChars: scaleChars(DEFAULT_PROMPT_BUDGET.maxDiffHunkChars),
    maxChangedFiles: Math.max(
      MIN_FILES,
      Math.floor((DEFAULT_PROMPT_BUDGET.maxChangedFiles * total) / base),
    ),
  };
}

function truncationMarker(dropped: number, label: string): string {
  return `\n[… truncated ${dropped} chars of ${label} …]`;
}

/**
 * Keeps a prefix of `text` and appends a marker naming how much was dropped,
 * so that the result is never longer than `max`. Callers must sanitize before
 * truncating: a cut could otherwise leave an unterminated HTML comment or tag
 * that the sanitizer would no longer recognize.
 */
export function truncateText(text: string, max: number, label: string): string {
  if (text.length <= max) {
    return text;
  }

  // The marker's length depends on the digit count of the dropped total, so
  // start from the shortest prefix that is certainly within budget (a marker
  // sized for dropping everything) and grow it while the result still fits.
  let keep = Math.max(0, max - truncationMarker(text.length, label).length);
  while (
    keep < text.length &&
    keep + 1 + truncationMarker(text.length - keep - 1, label).length <= max
  ) {
    keep += 1;
  }

  const marker = truncationMarker(text.length - keep, label);
  if (keep + marker.length > max) {
    // Too little room for any marker: a bare ellipsis still signals the cut.
    return max > 0 ? `${text.slice(0, max - 1)}…` : "";
  }
  return text.slice(0, keep) + marker;
}

function omittedPrefix(count: number, noun: string): string {
  return `[… ${count} earlier ${noun} omitted …]${SEPARATOR}`;
}

/**
 * Renders chronologically ordered items and, when the joined text exceeds
 * `max`, drops the OLDEST items first. GitHub returns threads oldest-first and
 * the trigger usually refers to the most recent discussion, so the newest items
 * are the ones worth keeping. The prefix announcing the omission counts against
 * the same budget. `noun` names the items in that prefix.
 */
export function keepNewest<T>(
  items: T[],
  render: (item: T) => string,
  max: number,
  noun: string = "comments",
): { text: string; omitted: number } {
  const rendered = items.map(render);

  // Walk newest to oldest, keeping items while the running total still fits
  // alongside the prefix that would announce the omission of everything older.
  let kept = 0;
  let length = 0;
  for (let i = rendered.length - 1; i >= 0; i--) {
    const item = rendered[i] ?? "";
    const withItem = length + item.length + (kept > 0 ? SEPARATOR.length : 0);
    const prefixLength = i > 0 ? omittedPrefix(i, noun).length : 0;
    if (withItem + prefixLength > max) {
      break;
    }
    length = withItem;
    kept += 1;
  }

  if (kept === rendered.length) {
    return { text: rendered.join(SEPARATOR), omitted: 0 };
  }

  if (kept === 0) {
    // Even the newest item alone does not fit: keep a truncated copy of it
    // rather than an empty section.
    const omitted = rendered.length - 1;
    const prefix = omittedPrefix(omitted, noun);
    const newest = rendered[rendered.length - 1] ?? "";
    const singular = noun.endsWith("s") ? noun.slice(0, -1) : noun;
    return {
      text:
        prefix +
        truncateText(newest, Math.max(0, max - prefix.length), singular),
      omitted,
    };
  }

  const omitted = rendered.length - kept;
  return {
    text:
      omittedPrefix(omitted, noun) + rendered.slice(omitted).join(SEPARATOR),
    omitted,
  };
}
