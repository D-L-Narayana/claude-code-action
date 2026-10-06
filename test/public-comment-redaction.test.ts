import { describe, expect, it } from "bun:test";
import { redactSecrets, sanitizeContent } from "../src/github/utils/sanitizer";

describe("Public Comment Output Sanitization & Redaction", () => {
  it("redacts all credential types from public comment output", () => {
    const rawComment = [
      "Here is the summary of the work done:",
      "- GitHub Token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
      "- Anthropic Key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890",
      "- AWS Access Key: AKIAIOSFODNN7EXAMPLE",
      "- Slack Bot Token: xoxb-1234567890-abcdefghijkl-mnopqrstuvwx",
      "- JWT Bearer: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "<!-- Hidden instruction injection -->",
      "Invisible\u200Bzero-width chars",
      "![Image Alt Injection](https://example.com/pic.png)",
    ].join("\n");

    const sanitizedOutput = redactSecrets(sanitizeContent(rawComment));

    // Ensure all secret types are redacted
    expect(sanitizedOutput).not.toContain(
      "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
    );
    expect(sanitizedOutput).not.toContain(
      "sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890",
    );
    expect(sanitizedOutput).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(sanitizedOutput).not.toContain(
      "xoxb-1234567890-abcdefghijkl-mnopqrstuvwx",
    );
    expect(sanitizedOutput).not.toContain(
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    );

    expect(sanitizedOutput).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(sanitizedOutput).toContain("[REDACTED_ANTHROPIC_KEY]");
    expect(sanitizedOutput).toContain("[REDACTED_AWS_KEY_ID]");
    expect(sanitizedOutput).toContain("[REDACTED_SLACK_TOKEN]");
    expect(sanitizedOutput).toContain("[REDACTED_JWT]");

    // Ensure prompt injection / invisible chars / hidden tags are also sanitized
    expect(sanitizedOutput).not.toContain(
      "<!-- Hidden instruction injection -->",
    );
    expect(sanitizedOutput).not.toContain("\u200B");
    expect(sanitizedOutput).not.toContain("Image Alt Injection");
    expect(sanitizedOutput).toContain("![](https://example.com/pic.png)");
  });

  it("ensures public comments have the same secret redaction coverage as logs/errors", () => {
    const errorDetails =
      "Error: failed to connect with sk-ant-abcdefghijklmnopqrstuvwxyz123456 and AKIAIOSFODNN7EXAMPLE";
    const commentBody =
      "Report: encountered sk-ant-abcdefghijklmnopqrstuvwxyz123456 and AKIAIOSFODNN7EXAMPLE";

    const redactedError = redactSecrets(errorDetails);
    const redactedComment = redactSecrets(sanitizeContent(commentBody));

    expect(redactedError).toContain("[REDACTED_ANTHROPIC_KEY]");
    expect(redactedError).toContain("[REDACTED_AWS_KEY_ID]");
    expect(redactedComment).toContain("[REDACTED_ANTHROPIC_KEY]");
    expect(redactedComment).toContain("[REDACTED_AWS_KEY_ID]");
  });
});

describe("redactSecrets additional credential formats", () => {
  // AIza + 35 characters
  const googleKey = "AIzaSyD0123456789abcdefghijklmnopqrstuv";
  // npm_ + 36 alphanumerics
  const npmToken = "npm_abcdefghijklmnopqrstuvwxyz0123456789";
  const gitlabToken = "glpat-ABCDEFGHIJKLMNOPQRST";
  const anthropicOAuthToken =
    "sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdefgh";
  const githubInstallationToken = "ghs_xz7yzju2SZjGPa0dUNMAx0SH4xDOCS31LXQW";

  it("redacts Google API keys", () => {
    expect(redactSecrets(`GOOGLE_API_KEY=${googleKey}`)).toBe(
      "GOOGLE_API_KEY=[REDACTED_GOOGLE_KEY]",
    );
    expect(redactSecrets(`"key":"${googleKey}"`)).toBe(
      '"key":"[REDACTED_GOOGLE_KEY]"',
    );
  });

  it("does not redact AIza strings that are too short to be keys", () => {
    const content = "AIzaShort and AIza_only_a_few_chars";
    expect(redactSecrets(content)).toBe(content);
  });

  it("redacts GitLab personal access tokens", () => {
    expect(redactSecrets(`token ${gitlabToken} end`)).toBe(
      "token [REDACTED_GITLAB_TOKEN] end",
    );
    expect(redactSecrets("glpat-abcdefghijklmnopqrstuvwxyz_-0123456789")).toBe(
      "[REDACTED_GITLAB_TOKEN]",
    );
  });

  it("does not redact glpat- strings shorter than 20 characters", () => {
    // 19 characters after the prefix
    const content = "glpat-short glpat-abcdefghijklmnopqrs";
    expect(redactSecrets(content)).toBe(content);
  });

  it("redacts npm access tokens", () => {
    expect(redactSecrets(`//registry.npmjs.org/:_authToken=${npmToken}`)).toBe(
      "//registry.npmjs.org/:_authToken=[REDACTED_NPM_TOKEN]",
    );
  });

  it("does not redact npm_ identifiers that are not tokens", () => {
    const content = "npm_config_registry npm_short npm_install";
    expect(redactSecrets(content)).toBe(content);
  });

  it("redacts Anthropic OAuth tokens with their own label", () => {
    expect(
      redactSecrets(`CLAUDE_CODE_OAUTH_TOKEN=${anthropicOAuthToken}`),
    ).toBe("CLAUDE_CODE_OAUTH_TOKEN=[REDACTED_ANTHROPIC_OAUTH_TOKEN]");
  });

  it("still labels Anthropic API keys as API keys", () => {
    const key = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdefgh";
    expect(redactSecrets(`ANTHROPIC_API_KEY=${key}`)).toBe(
      "ANTHROPIC_API_KEY=[REDACTED_ANTHROPIC_KEY]",
    );
  });

  it("redacts credentials embedded in URLs, as printed by git", () => {
    expect(
      redactSecrets(
        `fatal: unable to access 'https://x-access-token:${githubInstallationToken}@github.com/o/r.git/': The requested URL returned error: 403`,
      ),
    ).toBe(
      "fatal: unable to access 'https://[REDACTED_URL_CREDENTIAL]@github.com/o/r.git/': The requested URL returned error: 403",
    );
    expect(
      redactSecrets("remote: https://deploy:p4ssw0rd@example.com/repo.git"),
    ).toBe("remote: https://[REDACTED_URL_CREDENTIAL]@example.com/repo.git");
    expect(redactSecrets("http://user:secret@host:8080/path")).toBe(
      "http://[REDACTED_URL_CREDENTIAL]@host:8080/path",
    );
  });

  it("does not touch URLs with a port but no credentials", () => {
    const content =
      "see http://host:8080/path and https://example.com:443/x?y=1";
    expect(redactSecrets(content)).toBe(content);
  });

  it("does not touch URLs with a user but no password", () => {
    const content = "git@github.com:o/r.git and https://user@example.com/repo";
    expect(redactSecrets(content)).toBe(content);
  });

  it("redacts the newer credential formats from public comment output", () => {
    const rawComment = [
      "Summary:",
      `- Google: ${googleKey}`,
      `- GitLab: ${gitlabToken}`,
      `- npm: ${npmToken}`,
      `- Anthropic OAuth: ${anthropicOAuthToken}`,
      `- Remote: https://x-access-token:${githubInstallationToken}@github.com/o/r.git`,
    ].join("\n");

    const sanitizedOutput = redactSecrets(sanitizeContent(rawComment));

    expect(sanitizedOutput).not.toContain(googleKey);
    expect(sanitizedOutput).not.toContain(gitlabToken);
    expect(sanitizedOutput).not.toContain(npmToken);
    expect(sanitizedOutput).not.toContain(anthropicOAuthToken);
    expect(sanitizedOutput).not.toContain(githubInstallationToken);
    expect(sanitizedOutput).not.toContain("x-access-token:");

    expect(sanitizedOutput).toContain("[REDACTED_GOOGLE_KEY]");
    expect(sanitizedOutput).toContain("[REDACTED_GITLAB_TOKEN]");
    expect(sanitizedOutput).toContain("[REDACTED_NPM_TOKEN]");
    expect(sanitizedOutput).toContain("[REDACTED_ANTHROPIC_OAUTH_TOKEN]");
    expect(sanitizedOutput).toContain(
      "https://[REDACTED_URL_CREDENTIAL]@github.com/o/r.git",
    );
  });
});
