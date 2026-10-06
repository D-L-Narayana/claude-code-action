import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

/**
 * Drift guards for the markdown documentation. Markdown is scanned line by
 * line (no parser library): fenced code blocks, ATX headings, `**Label:**`
 * paragraphs and `# comment` lines inside YAML fences provide the context
 * used to decide whether a legacy example is legitimately "before" material.
 */

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const readRepoFile = (relativePath: string): string =>
  readFileSync(join(repoRoot, relativePath), "utf8");

const docFiles: string[] = [
  "README.md",
  ...readdirSync(join(repoRoot, "docs"), { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".md"))
    .sort()
    .map((entry) => `docs/${entry.split(sep).join("/")}`),
];

const SHA_PATTERN = /^[0-9a-f]{40}$/;

/** Inputs removed in v1.0; they must not appear as keys in current examples. */
const LEGACY_INPUTS = [
  "allowed_tools",
  "disallowed_tools",
  "max_turns",
  "mcp_config",
  "system_prompt",
  "append_system_prompt",
  "claude_env",
  "model",
  "anthropic_model",
  "fallback_model",
  "direct_prompt",
  "override_prompt",
  "custom_instructions",
  "mode",
  "timeout_minutes",
];
const legacyKeyPattern = new RegExp(
  `^\\s*(?:-\\s+)?(${LEGACY_INPUTS.join("|")}):(?=\\s|$)`,
);

const LEGACY_CONTEXT = /\b(before|deprecated|migration|old)\b/i;
const MODERN_CONTEXT = /\b(after|new)\b/i;

/** Events that can appear under `on:` in a GitHub Actions workflow. */
const GITHUB_WORKFLOW_EVENTS = new Set([
  "branch_protection_rule",
  "check_run",
  "check_suite",
  "create",
  "delete",
  "deployment",
  "deployment_status",
  "discussion",
  "discussion_comment",
  "fork",
  "gollum",
  "issue_comment",
  "issues",
  "label",
  "merge_group",
  "milestone",
  "page_build",
  "public",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "pull_request_target",
  "push",
  "registry_package",
  "release",
  "repository_dispatch",
  "schedule",
  "status",
  "watch",
  "workflow_call",
  "workflow_dispatch",
  "workflow_run",
]);

type DocLine = {
  number: number;
  text: string;
  inFence: boolean;
  fenceLang: string;
  /** Heading path in effect (index = heading level - 1; "" for skipped levels). */
  headings: string[];
  /** Nearest `**Label:**` paragraph since the last heading, if any. */
  label: string | null;
  /** Nearest `# comment` line earlier in the same fenced block, if any. */
  fenceComment: string | null;
};

type Doc = { file: string; lines: DocLine[]; slugs: Set<string> };

/**
 * GitHub's heading anchor algorithm: lowercase, drop HTML tags, drop
 * punctuation and symbols, keep letters, numbers and marks (`\p{M}`), then
 * turn whitespace into hyphens. Keeping marks matters for emoji headings:
 * the warning sign is U+26A0 (a symbol, dropped) followed by U+FE0F
 * VARIATION SELECTOR-16 (a mark, kept), so "## <U+26A0><U+FE0F> Prompt
 * Injection Risks" anchors to "#\uFE0F-prompt-injection-risks" — which is
 * exactly what the existing docs link to.
 */
function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function analyzeMarkdown(file: string, source: string): Doc {
  const lines: DocLine[] = [];
  const slugs = new Set<string>();
  const headings: string[] = [];
  let label: string | null = null;
  let fence: { marker: string; lang: string } | null = null;
  let fenceComment: string | null = null;

  source.split("\n").forEach((raw, index) => {
    const text = raw.replace(/\r$/, "");
    const trimmed = text.trim();
    const number = index + 1;

    if (fence !== null) {
      const closes =
        trimmed.startsWith(fence.marker) && /^[`~]+$/.test(trimmed);
      if (closes) {
        fence = null;
        fenceComment = null;
        lines.push({
          number,
          text,
          inFence: false,
          fenceLang: "",
          headings: [...headings],
          label,
          fenceComment: null,
        });
        return;
      }
      const comment = text.match(/^\s*#\s*(.*)$/);
      if (comment !== null) fenceComment = comment[1] ?? "";
      lines.push({
        number,
        text,
        inFence: true,
        fenceLang: fence.lang,
        headings: [...headings],
        label,
        fenceComment,
      });
      return;
    }

    const opens = text.match(/^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_+.-]*)/);
    if (opens !== null) {
      fence = {
        marker: opens[1] ?? "```",
        lang: (opens[2] ?? "").toLowerCase(),
      };
      fenceComment = null;
    } else {
      const heading = text.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading !== null) {
        const level = (heading[1] ?? "#").length;
        const title = heading[2] ?? "";
        headings.splice(level - 1);
        while (headings.length < level - 1) headings.push("");
        headings.push(title);
        slugs.add(slugify(title));
        label = null;
      } else {
        const labelMatch = text.match(/^\*\*(.+?)\*\*:?\s*$/);
        if (labelMatch !== null) label = labelMatch[1] ?? "";
      }
    }
    lines.push({
      number,
      text,
      inFence: false,
      fenceLang: "",
      headings: [...headings],
      label,
      fenceComment: null,
    });
  });

  return { file, lines, slugs };
}

/**
 * Legacy inputs/refs are allowed where the nearest context marker says the
 * example shows the old way: a `# Old (v0.x)` comment in the same fence, a
 * `**Before (v0.x):**` label, or a heading containing Before / Deprecated /
 * Migration / Old. A nearer `# New` / `**After**` marker wins over a farther
 * legacy one, so "After (v1.0)" examples inside the migration guide are
 * still checked.
 */
function inLegacyContext(line: DocLine): boolean {
  for (const marker of [line.fenceComment, line.label]) {
    if (marker === null) continue;
    if (LEGACY_CONTEXT.test(marker)) return true;
    if (MODERN_CONTEXT.test(marker)) return false;
  }
  return line.headings.some((heading) => LEGACY_CONTEXT.test(heading));
}

const isYamlFence = (lang: string): boolean =>
  lang === "yaml" || lang === "yml" || lang === "";

const sectionOf = (line: DocLine): string =>
  line.headings.filter((heading) => heading !== "").join(" > ") || "(top)";

const docs: Doc[] = docFiles.map((file) =>
  analyzeMarkdown(file, readRepoFile(file)),
);

const docCache = new Map<string, Doc>(docs.map((doc) => [doc.file, doc]));
function docFor(file: string): Doc {
  let doc = docCache.get(file);
  if (doc === undefined) {
    doc = analyzeMarkdown(file, readRepoFile(file));
    docCache.set(file, doc);
  }
  return doc;
}

// Synthetic markdown exercising every scanner branch: a legacy key under a
// current heading (must be reported), the same key under a "Before" label
// and under a "Deprecated" heading (exempt), an "After" label inside the
// deprecated section (checked again), a `# Old` fence comment (exempt), a
// non-YAML fence (ignored) and a heading whose anchor needs the `\p{M}` rule.
const SAMPLE_MARKDOWN = [
  "# Guide",
  "",
  "## Current usage",
  "",
  "```yaml",
  "- uses: anthropics/claude-code-action@v1",
  "  with:",
  '    max_turns: "10"',
  "```",
  "",
  "**Before (v0.x):**",
  "",
  "```yaml",
  '    direct_prompt: "exempt via label"',
  "```",
  "",
  "## Deprecated inputs",
  "",
  "```yaml",
  '    mode: "exempt via heading"',
  "```",
  "",
  "**After (v1.0):**",
  "",
  "```yaml",
  '    model: "reported: After label overrides Deprecated heading"',
  "```",
  "",
  "```yaml",
  "# Old (v0.x)",
  '    allowed_tools: "exempt via fence comment"',
  "# New (v1.0)",
  '    claude_env: "reported: New comment is nearer"',
  "```",
  "",
  "```json",
  '{ "model": "ignored: not a yaml fence" }',
  "```",
  "",
  "## \u26A0\uFE0F Prompt Injection Risks",
].join("\n");

/** Legacy-input findings for one analyzed document, as `line:key` pairs. */
function legacyFindings(doc: Doc): string[] {
  const findings: string[] = [];
  for (const line of doc.lines) {
    if (!line.inFence || !isYamlFence(line.fenceLang)) continue;
    const legacy = line.text.match(legacyKeyPattern)?.[1];
    if (legacy === undefined || inLegacyContext(line)) continue;
    findings.push(`${line.number}:${legacy}`);
  }
  return findings;
}

describe("documentation consistency", () => {
  test("slugify matches GitHub's heading anchors, including emoji headings", () => {
    // U+26A0 WARNING SIGN (symbol, dropped) + U+FE0F VARIATION SELECTOR-16
    // (mark, kept): the anchor starts with the bare variation selector.
    expect(slugify("\u26A0\uFE0F Prompt Injection Risks")).toBe(
      "\uFE0F-prompt-injection-risks",
    );
    expect(slugify("\u26A0\uFE0F Full Output Security Warning")).toBe(
      "\uFE0F-full-output-security-warning",
    );
    expect(slugify("\u{1F4E6} Upgrading from v0.x?")).toBe(
      "-upgrading-from-v0x",
    );
    expect(
      slugify("Using this action with `pull_request_target` or `workflow_run`"),
    ).toBe("using-this-action-with-pull_request_target-or-workflow_run");
    expect(slugify("Additional Permissions for CI/CD Integration")).toBe(
      "additional-permissions-for-cicd-integration",
    );
  });

  test("the markdown scanner reports legacy inputs only outside before/migration material", () => {
    const doc = analyzeMarkdown("sample.md", SAMPLE_MARKDOWN);
    expect(legacyFindings(doc)).toEqual([
      "8:max_turns",
      "26:model",
      "33:claude_env",
    ]);
    expect(doc.slugs.has("\uFE0F-prompt-injection-risks")).toBe(true);
    expect(doc.slugs.has("current-usage")).toBe(true);
  });

  test("discovers the documentation files", () => {
    expect(docFiles).toContain("README.md");
    expect(docFiles).toContain("docs/usage.md");
    expect(docFiles).toContain("docs/faq.md");
    expect(docFiles).toContain("docs/migration-guide.md");
    expect(docFiles).toContain("docs/custom-automations.md");
  });

  test("YAML examples do not use removed legacy inputs outside before/migration material", () => {
    const problems: string[] = [];
    let exempt = 0;
    let yamlLines = 0;
    for (const doc of docs) {
      for (const line of doc.lines) {
        if (!line.inFence || !isYamlFence(line.fenceLang)) continue;
        yamlLines++;
        const legacy = line.text.match(legacyKeyPattern)?.[1];
        if (legacy === undefined) continue;
        if (inLegacyContext(line)) {
          exempt++;
          continue;
        }
        problems.push(
          `${doc.file}:${line.number} YAML example uses removed input \`${legacy}\` (section: ${sectionOf(line)}); use prompt / claude_args / settings instead: ${line.text.trim()}`,
        );
      }
    }
    if (yamlLines === 0) {
      problems.push(
        "scanner sanity check: no fenced YAML lines found in docs — fence detection is broken",
      );
    }
    if (exempt === 0) {
      problems.push(
        "scanner sanity check: expected the migration guide's Before (v0.x) examples to contain legacy inputs in an exempt context, found none — heading/label detection is broken",
      );
    }
    expect(problems).toEqual([]);
  });

  test("YAML examples pin actions/checkout to v6 or a SHA and reference claude-code-action@v1", () => {
    const problems: string[] = [];
    for (const doc of docs) {
      for (const line of doc.lines) {
        if (!line.inFence || !isYamlFence(line.fenceLang)) continue;
        const checkoutRef = line.text.match(
          /\buses:\s*["']?actions\/checkout@([^\s"'#]+)/,
        )?.[1];
        if (
          checkoutRef !== undefined &&
          checkoutRef !== "v6" &&
          !SHA_PATTERN.test(checkoutRef)
        ) {
          problems.push(
            `${doc.file}:${line.number} YAML example uses actions/checkout@${checkoutRef}; pin to v6 or a 40-hex commit SHA`,
          );
        }
        const actionRef = line.text.match(
          /\buses:\s*["']?anthropics\/claude-code-action@([^\s"'#]+)/,
        )?.[1];
        if (
          actionRef !== undefined &&
          actionRef !== "v1" &&
          !inLegacyContext(line)
        ) {
          problems.push(
            `${doc.file}:${line.number} YAML example references anthropics/claude-code-action@${actionRef} (section: ${sectionOf(line)}); current examples must reference @v1`,
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });

  test("docs/faq.md names every built-in MCP server", () => {
    const installer = readRepoFile("src/mcp/install-mcp-server.ts");
    const builtInServers = [
      ...installer.matchAll(/mcpServers\.([a-z_]+)\s*=/g),
    ].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
    // Keep in sync with src/mcp/install-mcp-server.ts; the assertion keeps
    // the source scan from passing vacuously if the code style changes.
    expect([...builtInServers].sort()).toEqual([
      "github",
      "github_ci",
      "github_comment",
      "github_file_ops",
      "github_inline_comment",
    ]);

    const faq = readRepoFile("docs/faq.md");
    const problems: string[] = [];
    for (const name of builtInServers) {
      // "GitHub" appears everywhere, so the plain `github` server must be
      // named as code, in bold, or via its mcp__github__ tool prefix.
      const mentioned =
        name === "github"
          ? /`github`|\*\*github\*\*|mcp__github__/.test(faq)
          : new RegExp(`(?<![A-Za-z0-9])${name}(?![A-Za-z0-9])`).test(faq);
      if (!mentioned) {
        problems.push(
          `docs/faq.md does not mention the built-in MCP server \`${name}\` (defined in src/mcp/install-mcp-server.ts)`,
        );
      }
    }
    faq.split("\n").forEach((line, index) => {
      if (/\b(two|2)\s+MCP\s+servers\b/i.test(line)) {
        problems.push(
          `docs/faq.md:${index + 1} still says there are two MCP servers; the action defines ${builtInServers.length} built-in servers (${builtInServers.join(", ")}): ${line.trim()}`,
        );
      }
    });
    expect(problems).toEqual([]);
  });

  test("docs/custom-automations.md lists only real GitHub workflow events", () => {
    const file = "docs/custom-automations.md";
    const doc = docFor(file);
    const problems: string[] = [];
    let listed = 0;
    for (const line of doc.lines) {
      const mentionsFakeEvent = line.text.includes("pull_request_comment");
      if (mentionsFakeEvent) {
        problems.push(
          `${file}:${line.number} mentions \`pull_request_comment\`, which is not a GitHub event (pull_request_review_comment covers comments on PR diffs): ${line.text.trim()}`,
        );
      }
      if (line.inFence) continue;
      if (!line.headings.some((h) => /supported github events/i.test(h))) {
        continue;
      }
      if (!/^\s*[-*]\s+`/.test(line.text)) continue;
      for (const match of line.text.matchAll(/`([a-z_]+)`/g)) {
        const event = match[1];
        if (event === undefined) continue;
        listed++;
        if (!GITHUB_WORKFLOW_EVENTS.has(event) && !mentionsFakeEvent) {
          problems.push(
            `${file}:${line.number} lists \`${event}\`, which is not a GitHub Actions workflow event`,
          );
        }
      }
    }
    if (listed === 0) {
      problems.push(
        `${file}: found no \`event\` bullets under the "Supported GitHub Events" heading — heading detection is broken or the section was renamed`,
      );
    }
    expect(problems).toEqual([]);
  });

  test("relative markdown links in docs and README resolve to existing files and headings", () => {
    const problems: string[] = [];
    let checked = 0;
    for (const doc of docs) {
      for (const line of doc.lines) {
        if (line.inFence) continue;
        for (const match of line.text.matchAll(/\]\(([^)\s]+)\)/g)) {
          const target = match[1];
          if (target === undefined) continue;
          if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) {
            continue; // absolute URL
          }
          checked++;
          const hashIndex = target.indexOf("#");
          const pathPart =
            hashIndex === -1 ? target : target.slice(0, hashIndex);
          const fragment =
            hashIndex === -1 ? null : target.slice(hashIndex + 1);
          const targetFile =
            pathPart === ""
              ? doc.file
              : relative(
                  repoRoot,
                  resolve(
                    dirname(join(repoRoot, doc.file)),
                    safeDecode(pathPart),
                  ),
                )
                  .split(sep)
                  .join("/");
          if (!existsSync(join(repoRoot, targetFile))) {
            problems.push(
              `${doc.file}:${line.number} link ${target} points to ${targetFile}, which does not exist`,
            );
            continue;
          }
          if (
            fragment === null ||
            fragment === "" ||
            !targetFile.endsWith(".md")
          ) {
            continue;
          }
          const slugs = docFor(targetFile).slugs;
          if (!slugs.has(safeDecode(fragment).toLowerCase())) {
            problems.push(
              `${doc.file}:${line.number} link ${target} anchors to #${fragment}, but ${targetFile} has no heading with that anchor (available: ${[...slugs].slice(0, 12).join(", ")}${slugs.size > 12 ? ", …" : ""})`,
            );
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(10);
    expect(problems).toEqual([]);
  });
});
