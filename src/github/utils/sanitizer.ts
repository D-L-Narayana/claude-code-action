export function stripInvisibleCharacters(content: string): string {
  // Zero-width space / non-joiner / joiner and the BOM: invisible separators
  // that split a word so it slips past keyword matching, or hide text.
  content = content.replace(/[\u200B\u200C\u200D\uFEFF]/g, "");
  // C0/C1 control characters (keeping \t, \n and \r): never legitimate in
  // prose, and confuse terminals and parsers.
  content = content.replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g,
    "",
  );
  // Soft hyphen: invisible unless a line happens to break there.
  content = content.replace(/\u00AD/g, "");
  // Bidi overrides and isolates: reorder the rendered text so what a reviewer
  // sees differs from the code points the model reads (Trojan Source).
  content = content.replace(/[\u202A-\u202E\u2066-\u2069]/g, "");
  // Word joiner, Mongolian vowel separator and combining grapheme joiner:
  // zero-width format/combining characters outside the ranges above that
  // serve the same word-splitting and hiding purpose.
  content = content.replace(/[\u2060\u180E\u034F]/g, "");
  // Variation selectors VS1-VS16: invisible on their own, and a run of them
  // after one visible base character can encode arbitrary hidden data. Emoji
  // keep their base code point and lose only the presentation selector
  // (e.g. U+FE0F), which does not change what they mean.
  content = content.replace(/[\uFE00-\uFE0F]/g, "");
  // Unicode TAG block (U+E0000-U+E007F): a complete invisible copy of ASCII
  // ("ASCII smuggling"). A model that reads raw code points can decode a
  // whole hidden instruction while a human reviewer sees nothing. These are
  // astral code points, hence the `u` flag.
  content = content.replace(/[\u{E0000}-\u{E007F}]/gu, "");
  return content;
}

export function stripMarkdownImageAltText(content: string): string {
  // Inline images: ![alt](url) -> ![](url)
  content = content.replace(/!\[[^\]]*\]\(/g, "![](");
  // Reference-style images: ![alt][ref] -> ![][ref] (keep the label, drop the
  // alt text, which is otherwise a hidden-instruction channel just like the
  // inline form above).
  content = content.replace(/!\[[^\]]*\](\[[^\]]*\])/g, "![]$1");
  return content;
}

export function stripMarkdownLinkTitles(content: string): string {
  content = content.replace(/(\[[^\]]*\]\([^)]+)\s+"[^"]*"/g, "$1");
  content = content.replace(/(\[[^\]]*\]\([^)]+)\s+'[^']*'/g, "$1");
  return content;
}

export function stripHiddenAttributes(content: string): string {
  // Quoted values are matched per quote type so that a value containing the
  // other quote character (e.g. an apostrophe inside a double-quoted value)
  // does not terminate the match early and mangle surrounding content (#1366).
  content = content.replace(/\salt\s*=\s*"[^"]*"/gi, "");
  content = content.replace(/\salt\s*=\s*'[^']*'/gi, "");
  content = content.replace(/\salt\s*=\s*[^\s>]+/gi, "");
  content = content.replace(/\stitle\s*=\s*"[^"]*"/gi, "");
  content = content.replace(/\stitle\s*=\s*'[^']*'/gi, "");
  content = content.replace(/\stitle\s*=\s*[^\s>]+/gi, "");
  content = content.replace(/\saria-label\s*=\s*"[^"]*"/gi, "");
  content = content.replace(/\saria-label\s*=\s*'[^']*'/gi, "");
  content = content.replace(/\saria-label\s*=\s*[^\s>]+/gi, "");
  content = content.replace(/\sdata-[a-zA-Z0-9-]+\s*=\s*"[^"]*"/gi, "");
  content = content.replace(/\sdata-[a-zA-Z0-9-]+\s*=\s*'[^']*'/gi, "");
  content = content.replace(/\sdata-[a-zA-Z0-9-]+\s*=\s*[^\s>]+/gi, "");
  content = content.replace(/\splaceholder\s*=\s*"[^"]*"/gi, "");
  content = content.replace(/\splaceholder\s*=\s*'[^']*'/gi, "");
  content = content.replace(/\splaceholder\s*=\s*[^\s>]+/gi, "");
  return content;
}

export function normalizeHtmlEntities(content: string): string {
  content = content.replace(/&#(\d+);/g, (_, dec) => {
    const num = parseInt(dec, 10);
    if (num >= 32 && num <= 126) {
      return String.fromCharCode(num);
    }
    return "";
  });
  content = content.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
    const num = parseInt(hex, 16);
    if (num >= 32 && num <= 126) {
      return String.fromCharCode(num);
    }
    return "";
  });
  return content;
}

export function sanitizeContent(content: string): string {
  content = stripHtmlComments(content);
  content = stripInvisibleCharacters(content);
  content = stripMarkdownImageAltText(content);
  content = stripMarkdownLinkTitles(content);
  content = stripHiddenAttributes(content);
  content = normalizeHtmlEntities(content);
  content = redactGitHubTokens(content);
  return content;
}

/**
 * Redact well-known credential formats (GitHub, Anthropic, Google, GitLab,
 * npm, AWS, Slack, JWTs, URL-embedded credentials) from arbitrary text.
 * Callers don't need to know which vendor a value belongs to.
 *
 * Vendor-prefixed formats are matched without a leading word boundary: the
 * prefix already anchors them, and runtime output frequently puts a word
 * character directly against the value (e.g. an ANSI color code ending in `m`,
 * or a serialized JSON escape such as `\n`).
 */
export function redactSecrets(content: string): string {
  content = redactGitHubTokens(content);

  // Anthropic OAuth tokens: sk-ant-oat01-... This has to run before the
  // generic sk-ant- rule below, which would otherwise consume these under the
  // API-key label; the distinct label tells an operator which credential
  // actually leaked.
  content = content.replace(
    /sk-ant-oat01-[A-Za-z0-9_-]{20,}/g,
    "[REDACTED_ANTHROPIC_OAUTH_TOKEN]",
  );

  // Anthropic API keys: sk-ant-...
  content = content.replace(
    /sk-ant-[A-Za-z0-9_-]{20,}/g,
    "[REDACTED_ANTHROPIC_KEY]",
  );

  // AWS access key ids: AKIA/ASIA followed by 16 uppercase alphanumerics. All
  // uppercase alphanumeric, so keep a leading boundary to avoid matching inside
  // larger blobs; also treat a JSON escape or ANSI color code as a boundary.
  content = content.replace(
    /(?:\b|(?<=\\(?:[nrtbf"\\/]|u[0-9a-fA-F]{4}))|(?<=\[[0-9;]*m))(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    "[REDACTED_AWS_KEY_ID]",
  );

  // Google API keys: AIza followed by 35 URL-safe base64 characters.
  content = content.replace(/AIza[0-9A-Za-z_-]{35}/g, "[REDACTED_GOOGLE_KEY]");

  // GitLab personal access tokens: glpat-...
  content = content.replace(
    /glpat-[0-9A-Za-z_-]{20,}/g,
    "[REDACTED_GITLAB_TOKEN]",
  );

  // npm access tokens: npm_ followed by 36 alphanumerics.
  content = content.replace(/npm_[A-Za-z0-9]{36}/g, "[REDACTED_NPM_TOKEN]");

  // Slack tokens: xoxb-, xoxp-, xoxa-, xoxs-, xoxr-
  content = content.replace(
    /xox[abpsr]-[A-Za-z0-9-]{10,}/g,
    "[REDACTED_SLACK_TOKEN]",
  );

  // JWT-shaped strings: three base64url segments, the first two starting
  // with eyJ (base64 of `{"`).
  content = content.replace(
    /eyJ[A-Za-z0-9_-]{10,2000}\.eyJ[A-Za-z0-9_-]{10,4000}\.[A-Za-z0-9_-]{10,2000}\b/g,
    "[REDACTED_JWT]",
  );

  // Credentials embedded in URLs (https://user:password@host). git prints
  // the remote URL verbatim in its error output, e.g.
  //   fatal: unable to access 'https://x-access-token:ghs_...@github.com/o/r.git/'
  // and that output ends up in comments. The whole userinfo is replaced, not
  // just the password: the user name may itself be a secret. A ":" that is
  // not followed by "@" (a port, "http://host:8080/path") does not match.
  content = content.replace(
    /(https?:\/\/)[^\s/:@]+:[^\s/@]+@/g,
    "$1[REDACTED_URL_CREDENTIAL]@",
  );

  return content;
}

export function redactGitHubTokens(content: string): string {
  // GitHub Personal Access Tokens (classic): ghp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX (40 chars)
  content = content.replace(
    /ghp_[A-Za-z0-9]{36}\b/g,
    "[REDACTED_GITHUB_TOKEN]",
  );

  // GitHub OAuth tokens: gho_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX (40 chars)
  content = content.replace(
    /gho_[A-Za-z0-9]{36}\b/g,
    "[REDACTED_GITHUB_TOKEN]",
  );

  // GitHub user-to-server tokens: ghu_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX (40 chars)
  content = content.replace(
    /ghu_[A-Za-z0-9]{36}\b/g,
    "[REDACTED_GITHUB_TOKEN]",
  );

  // GitHub installation tokens: ghs_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX (40 chars)
  content = content.replace(
    /ghs_[A-Za-z0-9]{36}\b/g,
    "[REDACTED_GITHUB_TOKEN]",
  );

  // GitHub refresh tokens: ghr_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX (40 chars)
  content = content.replace(
    /ghr_[A-Za-z0-9]{36}\b/g,
    "[REDACTED_GITHUB_TOKEN]",
  );

  // GitHub fine-grained personal access tokens: github_pat_XXXXXXXXXX (up to 255 chars)
  content = content.replace(
    /github_pat_[A-Za-z0-9_]{11,221}\b/g,
    "[REDACTED_GITHUB_TOKEN]",
  );

  return content;
}

export const stripHtmlComments = (content: string) =>
  content.replace(/<!--[\s\S]*?-->/g, "");
