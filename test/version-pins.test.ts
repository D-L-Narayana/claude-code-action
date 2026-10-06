import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { CLAUDE_CODE_VERSION } from "../src/install/claude-code-installer";
import * as collectInputs from "../src/entrypoints/collect-inputs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const readRepoFile = (relativePath: string): string =>
  readFileSync(join(repoRoot, relativePath), "utf8");

// Looked up on the module namespace rather than named in the import list so
// that, if collect-inputs.ts stops exporting it, this file still loads and
// the test below fails with a message naming the missing export (a named
// import of a missing binding would abort the whole file at link time).
const collectInputsExports: Record<string, unknown> = { ...collectInputs };

/** Inputs declared in action.yml; bump when inputs are added or removed. */
const EXPECTED_INPUT_COUNT = 39;

const INSTALLER_MODULE = "src/install/claude-code-installer.ts";

type ParsedInput = { name: string; line: number; defaultValue: string };
type SourceFile = { path: string; content: string };

function unescapeDoubleQuoted(value: string): string {
  return value.replace(/\\(.)/g, (_, char: string) => {
    switch (char) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      default:
        return char;
    }
  });
}

function parseScalar(raw: string, file: string, lineNumber: number): string {
  const value = raw.trim();
  if (value.startsWith('"')) {
    const inner = value.match(/^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/)?.[1];
    if (inner === undefined) {
      throw new Error(
        `${file}:${lineNumber}: cannot parse double-quoted scalar: ${raw}`,
      );
    }
    return unescapeDoubleQuoted(inner);
  }
  if (value.startsWith("'")) {
    const inner = value.match(/^'((?:[^']|'')*)'\s*(?:#.*)?$/)?.[1];
    if (inner === undefined) {
      throw new Error(
        `${file}:${lineNumber}: cannot parse single-quoted scalar: ${raw}`,
      );
    }
    return inner.replace(/''/g, "'");
  }
  return value.replace(/\s+#.*$/, "").trim();
}

/**
 * Parses `{ name, default }` for every input under the `inputs:` block by
 * line scanning: `  name:` keys at two spaces, `    field: value` at four.
 * `description: |` block bodies and `# comment` lines are skipped; a missing
 * `default:` means "".
 */
function parseActionInputDefaults(
  metadata: string,
  file = "action.yml",
): ParsedInput[] {
  const lines = metadata.split("\n");
  const start = lines.findIndex((line) => /^inputs:\s*$/.test(line));
  const end = lines.findIndex((line) => /^outputs:\s*$/.test(line));
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `${file} must declare a top-level \`inputs:\` block followed by \`outputs:\``,
    );
  }

  const inputs: ParsedInput[] = [];
  let current: ParsedInput | undefined;
  let blockScalarIndent: number | undefined;

  for (let index = start + 1; index < end; index++) {
    const line = lines[index] ?? "";
    const lineNumber = index + 1;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (blockScalarIndent !== undefined) {
      if (trimmed === "" || indent > blockScalarIndent) continue;
      blockScalarIndent = undefined;
    }
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const inputName = line.match(/^  ([A-Za-z0-9_-]+):\s*(?:#.*)?$/)?.[1];
    if (inputName !== undefined) {
      current = { name: inputName, line: lineNumber, defaultValue: "" };
      inputs.push(current);
      continue;
    }

    const fieldMatch = line.match(/^    ([A-Za-z0-9_-]+):(?:\s+(.*))?$/);
    const fieldName = fieldMatch?.[1];
    if (fieldMatch === null || fieldName === undefined) {
      throw new Error(
        `${file}:${lineNumber}: unexpected line inside the inputs block: ${line}`,
      );
    }
    if (current === undefined) {
      throw new Error(
        `${file}:${lineNumber}: input field appears before any input name`,
      );
    }
    const rawValue = fieldMatch[2] ?? "";
    if (/^[|>][-+0-9]*\s*(?:#.*)?$/.test(rawValue.trim())) {
      blockScalarIndent = indent;
      continue;
    }
    if (fieldName === "default") {
      current.defaultValue = parseScalar(rawValue, file, lineNumber);
    }
  }
  return inputs;
}

/** One problem per difference between the exported record and action.yml. */
function compareDefaults(
  parsed: ParsedInput[],
  exported: Record<string, string>,
  file = "action.yml",
): string[] {
  const problems: string[] = [];
  for (const input of parsed) {
    if (!Object.hasOwn(exported, input.name)) {
      problems.push(
        `ACTION_INPUT_DEFAULTS lacks \`${input.name}\` (declared at ${file}:${input.line} with default ${JSON.stringify(input.defaultValue)})`,
      );
    } else if (exported[input.name] !== input.defaultValue) {
      problems.push(
        `ACTION_INPUT_DEFAULTS.${input.name} is ${JSON.stringify(exported[input.name])} but ${file}:${input.line} declares default ${JSON.stringify(input.defaultValue)}`,
      );
    }
  }
  for (const name of Object.keys(exported)) {
    if (!parsed.some((input) => input.name === name)) {
      problems.push(
        `ACTION_INPUT_DEFAULTS has \`${name}\`, which ${file} does not declare under inputs: (remove legacy entries)`,
      );
    }
  }
  return problems;
}

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Lines (outside `exemptPath`) that quote the CLI version as a literal. */
function hardcodedVersionLines(
  files: SourceFile[],
  version: string,
  exemptPath: string,
): string[] {
  const literal = new RegExp(`(["'])${escapeRegExp(version)}\\1`);
  const problems: string[] = [];
  for (const file of files) {
    if (file.path === exemptPath) continue;
    file.content.split("\n").forEach((line, index) => {
      if (literal.test(line)) {
        problems.push(
          `${file.path}:${index + 1} hard-codes the Claude Code version "${version}"; import CLAUDE_CODE_VERSION from ${exemptPath} instead: ${line.trim()}`,
        );
      }
    });
  }
  return problems;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function listTypeScriptFiles(dir: string): SourceFile[] {
  return readdirSync(join(repoRoot, dir), {
    recursive: true,
    encoding: "utf8",
  })
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => `${dir}/${entry.split(sep).join("/")}`)
    .sort()
    .map((path) => ({ path, content: readRepoFile(path) }));
}

// Exercises every parser branch: block-scalar description containing a
// `default:` lookalike, comments at key indentation, trailing comments,
// single-quote escaping, plain scalars, escapes and a missing default.
const SAMPLE_METADATA = [
  "inputs:",
  "  trigger_phrase:",
  '    description: "The trigger phrase"',
  "    required: false",
  '    default: "@claude"',
  "  notes:",
  "    description: |",
  "      Multi-line body.",
  "",
  '      default: "inside the block scalar, must be ignored"',
  "    required: false",
  '    default: ""',
  "",
  "  # a comment at key indentation is not an input",
  "  bot_id:",
  '    default: "41898282" # trailing comment',
  "  quoted_single:",
  "    default: 'it''s'",
  "  plain:",
  "    default: false # comment",
  "  escaped:",
  '    default: "a\\nb"',
  "  no_default:",
  '    description: "none"',
  "outputs:",
  "  conclusion:",
  "    value: x",
].join("\n");

describe("version pins", () => {
  test("src and base-action/action.yml pin the same Claude Code CLI version", () => {
    const baseAction = readRepoFile("base-action/action.yml");
    const pins = baseAction
      .split("\n")
      .map((line, index) => ({
        line: index + 1,
        version: line.match(/^\s*CLAUDE_CODE_VERSION="([^"]*)"/)?.[1],
      }))
      .filter(
        (pin): pin is { line: number; version: string } =>
          pin.version !== undefined,
      );
    const pin = pins[0];
    if (pins.length !== 1 || pin === undefined) {
      throw new Error(
        `base-action/action.yml must contain exactly one CLAUDE_CODE_VERSION="x.y.z" literal, found ${pins.length}`,
      );
    }

    const problems: string[] = [];
    if (!/^\d+\.\d+\.\d+$/.test(CLAUDE_CODE_VERSION)) {
      problems.push(
        `${INSTALLER_MODULE} exports CLAUDE_CODE_VERSION = ${JSON.stringify(CLAUDE_CODE_VERSION)}, expected an exact x.y.z version`,
      );
    }
    if (pin.version !== CLAUDE_CODE_VERSION) {
      problems.push(
        `base-action/action.yml:${pin.line} pins CLAUDE_CODE_VERSION="${pin.version}" but ${INSTALLER_MODULE} exports CLAUDE_CODE_VERSION = "${CLAUDE_CODE_VERSION}"`,
      );
    }
    expect(problems).toEqual([]);
  });

  test("the version-literal scanner reports duplicated pins in a synthetic sample", () => {
    const problems = hardcodedVersionLines(
      [
        {
          path: INSTALLER_MODULE,
          content: 'export const CLAUDE_CODE_VERSION = "9.9.9";',
        },
        {
          path: "src/entrypoints/run.ts",
          content: 'import x from "y";\nconst claudeCodeVersion = "9.9.9";',
        },
        { path: "src/other.ts", content: 'const unrelated = "9.9.90";' },
      ],
      "9.9.9",
      INSTALLER_MODULE,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("src/entrypoints/run.ts:2");
  });

  test("the Claude Code version literal lives only in the installer module", () => {
    const files = [
      ...listTypeScriptFiles("src"),
      ...listTypeScriptFiles("base-action/src"),
    ];
    const paths = files.map((file) => file.path);
    expect(paths).toContain("src/entrypoints/run.ts");
    expect(paths).toContain(INSTALLER_MODULE);

    expect(
      hardcodedVersionLines(files, CLAUDE_CODE_VERSION, INSTALLER_MODULE),
    ).toEqual([]);
  });

  test("the inputs parser handles comments, quotes and block scalars in a synthetic sample", () => {
    const parsed = parseActionInputDefaults(SAMPLE_METADATA, "sample.yml");
    expect(parsed.map((input) => [input.name, input.defaultValue])).toEqual([
      ["trigger_phrase", "@claude"],
      ["notes", ""],
      ["bot_id", "41898282"],
      ["quoted_single", "it's"],
      ["plain", "false"],
      ["escaped", "a\nb"],
      ["no_default", ""],
    ]);
    expect(parsed.map((input) => input.line)).toEqual([
      2, 6, 15, 17, 19, 21, 23,
    ]);
  });

  test("the inputs parser finds every input declared in action.yml", () => {
    const parsed = parseActionInputDefaults(readRepoFile("action.yml"));
    const byName = new Map(parsed.map((input) => [input.name, input]));

    // Spot checks against known declarations so a parser bug cannot pass vacuously.
    expect(byName.get("trigger_phrase")?.defaultValue).toBe("@claude");
    // `default: "41898282" # Claude's bot ID ...` — trailing comment must be stripped.
    expect(byName.get("bot_id")?.defaultValue).toBe("41898282");
    // `description: |` block body must not be mistaken for fields or inputs.
    expect(byName.get("allowed_non_write_users")?.defaultValue).toBe("");
    // No `default:` at all means "".
    expect(byName.get("anthropic_api_key")?.defaultValue).toBe("");
    expect(byName.get("classify_inline_comments")?.defaultValue).toBe("true");

    const duplicates = parsed
      .map((input) => input.name)
      .filter((name, index, names) => names.indexOf(name) !== index);
    expect(duplicates).toEqual([]);
    if (parsed.length !== EXPECTED_INPUT_COUNT) {
      throw new Error(
        `action.yml inputs parser found ${parsed.length} inputs, expected ${EXPECTED_INPUT_COUNT} (update EXPECTED_INPUT_COUNT in test/version-pins.test.ts when inputs are added or removed). Found: ${parsed.map((input) => input.name).join(", ")}`,
      );
    }
  });

  test("the defaults comparison reports missing, stale and legacy entries", () => {
    const parsed = parseActionInputDefaults(readRepoFile("action.yml"));
    const drifted: Record<string, string> = Object.fromEntries(
      parsed.map((input) => [input.name, input.defaultValue]),
    );
    expect(compareDefaults(parsed, drifted)).toEqual([]);

    // The shape of the pre-upgrade record: legacy v0 keys present, current
    // inputs missing, and a default that no longer matches action.yml.
    drifted.mode = "tag";
    drifted.trigger_phrase = "@bot";
    delete drifted.prompt;

    const problems = compareDefaults(parsed, drifted);
    expect(problems).toHaveLength(3);
    expect(problems.some((p) => p.includes("lacks `prompt`"))).toBe(true);
    expect(
      problems.some((p) =>
        p.includes('ACTION_INPUT_DEFAULTS.trigger_phrase is "@bot"'),
      ),
    ).toBe(true);
    expect(problems.some((p) => p.includes("has `mode`"))).toBe(true);
  });

  test("ACTION_INPUT_DEFAULTS mirrors the defaults declared in action.yml", () => {
    const parsed = parseActionInputDefaults(readRepoFile("action.yml"));
    if (parsed.length !== EXPECTED_INPUT_COUNT) {
      throw new Error(
        `action.yml inputs parser found ${parsed.length} inputs, expected ${EXPECTED_INPUT_COUNT}`,
      );
    }

    const exported = collectInputsExports.ACTION_INPUT_DEFAULTS;
    if (!isStringRecord(exported)) {
      throw new Error(
        `src/entrypoints/collect-inputs.ts must export ACTION_INPUT_DEFAULTS as a { [inputName]: defaultValue } record of strings (got ${exported === undefined ? "no such export" : typeof exported})`,
      );
    }

    expect(compareDefaults(parsed, exported)).toEqual([]);
    expect(exported).toEqual(
      Object.fromEntries(
        parsed.map((input) => [input.name, input.defaultValue]),
      ),
    );
  });
});
