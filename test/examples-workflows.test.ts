import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

/**
 * Drift guards for the workflow files users copy from this repository.
 *
 * YAML is read with a small indentation-aware line scanner (no YAML library):
 * enough to find jobs, their `permissions:` blocks, their steps, and each
 * step's `uses`, `with` and `run` fields, including `|`/`>` block scalars.
 */

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const SHA_PATTERN = /^[0-9a-f]{40}$/;

function listYaml(
  dir: string,
  accept: (name: string) => boolean = () => true,
): string[] {
  return readdirSync(join(repoRoot, dir))
    .filter((name) => /\.ya?ml$/.test(name) && accept(name))
    .sort()
    .map((name) => `${dir}/${name}`);
}

const workflowFiles = [
  ...listYaml("examples"),
  ...listYaml("base-action/examples"),
  ...listYaml(".github/workflows", (name) => name.startsWith("claude")),
];

const readRepoFile = (relativePath: string): string =>
  readFileSync(join(repoRoot, relativePath), "utf8");

type RawLine = {
  number: number;
  indent: number;
  text: string;
  blank: boolean;
  comment: boolean;
};

type Entry = {
  /** Mapping key, or null for a sequence item / bare scalar. */
  key: string | null;
  /** Inline scalar (trailing comment stripped, quotes kept); "" if none. */
  value: string;
  /** Dedented body of a `|` / `>` block scalar, or null. */
  blockText: string | null;
  line: number;
  children: Entry[];
  /** True when this entry is a `- ` sequence item (fields in children). */
  item: boolean;
};

function toLines(source: string): RawLine[] {
  return source.split("\n").map((raw, index) => {
    const text = raw.replace(/\r$/, "");
    const trimmed = text.trim();
    return {
      number: index + 1,
      indent: text.length - text.trimStart().length,
      text,
      blank: trimmed === "",
      comment: trimmed.startsWith("#"),
    };
  });
}

function matchKey(content: string): { key: string; rest: string } | null {
  const match = content.match(/^([^\s#:][^:#]*?)\s*:(?:\s+(.*))?$/);
  const key = match?.[1];
  if (match === null || key === undefined) return null;
  return { key, rest: match[2] ?? "" };
}

function stripComment(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"')) {
    return value.match(/^"(?:[^"\\]|\\.)*"/)?.[0] ?? value;
  }
  if (value.startsWith("'")) {
    return value.match(/^'(?:[^']|'')*'/)?.[0] ?? value;
  }
  return value.replace(/\s+#.*$/, "").trim();
}

function unquote(value: string): string {
  const quoted =
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")));
  return quoted ? value.slice(1, -1) : value;
}

const isBlockIndicator = (rest: string): boolean =>
  /^[|>][-+0-9]*(?:\s+#.*)?$/.test(rest.trim());

/** Index just past the lines belonging to the entry starting at `start`. */
function rangeEnd(
  lines: RawLine[],
  start: number,
  end: number,
  indent: number,
): number {
  let index = start + 1;
  while (index < end) {
    const line = lines[index];
    if (line === undefined) break;
    if (line.blank || line.indent > indent || line.comment) {
      index++;
      continue;
    }
    break;
  }
  return index;
}

function dedent(bodyLines: string[]): string {
  const indents = bodyLines
    .filter((line) => line.trim() !== "")
    .map((line) => line.length - line.trimStart().length);
  const minimum = indents.length > 0 ? Math.min(...indents) : 0;
  return bodyLines.map((line) => line.slice(minimum)).join("\n");
}

function buildKeyEntry(
  lines: RawLine[],
  start: number,
  end: number,
  indent: number,
  key: string,
  rest: string,
): Entry {
  const lineNumber = lines[start]?.number ?? start + 1;
  if (isBlockIndicator(rest)) {
    const body: string[] = [];
    for (let index = start + 1; index < end; index++) {
      const line = lines[index];
      if (line === undefined) break;
      if (line.blank) {
        body.push("");
        continue;
      }
      if (line.indent > indent) {
        body.push(line.text);
        continue;
      }
      break;
    }
    return {
      key,
      value: "",
      blockText: dedent(body),
      line: lineNumber,
      children: [],
      item: false,
    };
  }
  return {
    key,
    value: stripComment(rest),
    blockText: null,
    line: lineNumber,
    children: parseEntries(lines, start + 1, end, indent),
    item: false,
  };
}

function parseEntry(
  lines: RawLine[],
  start: number,
  end: number,
): [Entry, number] {
  const line = lines[start];
  if (line === undefined) {
    throw new Error(`YAML scanner: line index ${start} out of range`);
  }
  const content = line.text.trim();
  const next = rangeEnd(lines, start, end, line.indent);

  if (content === "-" || content.startsWith("- ")) {
    const inner = content === "-" ? "" : content.slice(2).trim();
    const innerIndent = line.indent + 2;
    const children: Entry[] = [];
    let fieldsStart = start + 1;
    let value = "";
    const inlineKey = inner === "" ? null : matchKey(inner);
    if (inlineKey !== null) {
      // First field of the item sits on the dash line itself.
      const innerEnd = rangeEnd(lines, start, next, innerIndent);
      children.push(
        buildKeyEntry(
          lines,
          start,
          innerEnd,
          innerIndent,
          inlineKey.key,
          inlineKey.rest,
        ),
      );
      fieldsStart = innerEnd;
    } else {
      value = stripComment(inner);
    }
    children.push(...parseEntries(lines, fieldsStart, next, line.indent));
    return [
      {
        key: null,
        value,
        blockText: null,
        line: line.number,
        children,
        item: true,
      },
      next,
    ];
  }

  const keyed = matchKey(content);
  if (keyed === null) {
    return [
      {
        key: null,
        value: stripComment(content),
        blockText: null,
        line: line.number,
        children: [],
        item: false,
      },
      next,
    ];
  }
  return [
    buildKeyEntry(lines, start, next, line.indent, keyed.key, keyed.rest),
    next,
  ];
}

function parseEntries(
  lines: RawLine[],
  start: number,
  end: number,
  parentIndent: number,
): Entry[] {
  const entries: Entry[] = [];
  let childIndent: number | undefined;
  let index = start;
  while (index < end) {
    const line = lines[index];
    if (line === undefined) break;
    if (line.blank || line.comment) {
      index++;
      continue;
    }
    if (line.indent <= parentIndent) break;
    childIndent ??= line.indent;
    if (line.indent !== childIndent) {
      // Continuation of a multi-line plain scalar; not a sibling entry.
      index++;
      continue;
    }
    const [entry, next] = parseEntry(lines, index, end);
    entries.push(entry);
    index = next;
  }
  return entries;
}

type Step = {
  line: number;
  uses: string | null;
  withKeys: string[];
  claudeArgs: string;
  prompt: string;
  run: string;
};

type Job = {
  id: string;
  line: number;
  permissions: Entry | undefined;
  steps: Step[];
};

type Workflow = { permissions: Entry | undefined; jobs: Job[] };

const field = (entry: Entry, key: string): Entry | undefined =>
  entry.children.find((child) => child.key === key);

const textOf = (entry: Entry | undefined): string =>
  entry === undefined ? "" : (entry.blockText ?? unquote(entry.value));

function parseWorkflow(source: string): Workflow {
  const lines = toLines(source);
  const top = parseEntries(lines, 0, lines.length, -1);
  const jobsEntry = top.find((entry) => entry.key === "jobs");
  const jobs: Job[] = [];
  for (const jobEntry of jobsEntry?.children ?? []) {
    if (jobEntry.key === null) continue;
    const stepsEntry = field(jobEntry, "steps");
    const steps: Step[] = (stepsEntry?.children ?? [])
      .filter((item) => item.item)
      .map((item) => {
        const withEntry = field(item, "with");
        const usesEntry = field(item, "uses");
        return {
          line: item.line,
          uses: usesEntry === undefined ? null : unquote(usesEntry.value),
          withKeys: (withEntry?.children ?? []).flatMap((child) =>
            child.key === null ? [] : [child.key],
          ),
          claudeArgs: textOf(
            withEntry === undefined
              ? undefined
              : field(withEntry, "claude_args"),
          ),
          prompt: textOf(
            withEntry === undefined ? undefined : field(withEntry, "prompt"),
          ),
          run: textOf(field(item, "run")),
        };
      });
    jobs.push({
      id: jobEntry.key,
      line: jobEntry.line,
      permissions: field(jobEntry, "permissions"),
      steps,
    });
  }
  return {
    permissions: top.find((entry) => entry.key === "permissions"),
    jobs,
  };
}

type Grants = {
  source: string;
  scalar: "write-all" | "read-all" | null;
  map: Map<string, string>;
};

/**
 * Permissions in effect for a job: a job-level `permissions:` block replaces
 * the workflow-level one entirely; with neither, nothing beyond GitHub's
 * defaults is granted (and `id-token` defaults to none).
 */
function grantsFor(job: Job, workflow: Workflow): Grants | undefined {
  const entry = job.permissions ?? workflow.permissions;
  if (entry === undefined) return undefined;
  const source = `${job.permissions === undefined ? "workflow-level" : "job-level"} permissions: block at line ${entry.line}`;
  const scalar = unquote(entry.value);
  if (scalar === "write-all" || scalar === "read-all") {
    return { source, scalar, map: new Map() };
  }
  const map = new Map<string, string>();
  for (const child of entry.children) {
    if (child.key !== null) map.set(child.key, unquote(child.value));
  }
  return { source, scalar: null, map };
}

const grantsWrite = (grants: Grants | undefined, scope: string): boolean =>
  grants !== undefined &&
  (grants.scalar === "write-all" || grants.map.get(scope) === "write");

function describeGrants(grants: Grants | undefined): string {
  if (grants === undefined) {
    return "no permissions: block is declared at job or workflow level";
  }
  if (grants.scalar !== null) return `${grants.source} grants ${grants.scalar}`;
  const listed = [...grants.map]
    .map(([scope, level]) => `${scope}: ${level}`)
    .join(", ");
  return `${grants.source} grants {${listed || "nothing"}}`;
}

type UsesRef = { line: number; action: string; ref: string };

function scanUses(source: string): UsesRef[] {
  const refs: UsesRef[] = [];
  source.split("\n").forEach((text, index) => {
    const match = text.match(
      /^\s*(?:-\s+)?uses:\s*["']?([^\s"'@#]+)@([^\s"'#]+)/,
    );
    const action = match?.[1];
    const ref = match?.[2];
    if (action !== undefined && ref !== undefined) {
      refs.push({ line: index + 1, action, ref });
    }
  });
  return refs;
}

/** `uses:` owner/repo[/path] → metadata file of that action in this repository. */
const LOCAL_ACTIONS: Record<string, string> = {
  "anthropics/claude-code-action": "action.yml",
  "anthropics/claude-code-base-action": "base-action/action.yml",
  "anthropics/claude-code-action/agent-approval-check":
    "agent-approval-check/action.yml",
};

/** Two-space-indented keys of the top-level `inputs:` block. */
function declaredInputNames(metadataPath: string): Set<string> {
  const lines = readRepoFile(metadataPath).split("\n");
  const start = lines.findIndex((line) => /^inputs:\s*$/.test(line));
  if (start === -1) {
    throw new Error(`${metadataPath} has no top-level inputs: block`);
  }
  const names = new Set<string>();
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (/^[A-Za-z]/.test(line)) break; // next top-level key
    const name = line.match(/^  ([A-Za-z0-9_-]+):\s*(?:#.*)?$/)?.[1];
    if (name !== undefined) names.add(name);
  }
  if (names.size === 0) {
    throw new Error(`${metadataPath}: no inputs found under inputs:`);
  }
  return names;
}

describe("example workflows", () => {
  test("every with: key passed to this repository's actions is a declared input", () => {
    const problems: string[] = [];
    let checked = 0;
    for (const file of workflowFiles) {
      const workflow = parseWorkflow(readRepoFile(file));
      for (const job of workflow.jobs) {
        for (const step of job.steps) {
          if (step.uses === null) continue;
          const metadataPath = LOCAL_ACTIONS[step.uses.split("@")[0] ?? ""];
          if (metadataPath === undefined) continue;
          const declared = declaredInputNames(metadataPath);
          checked++;
          for (const key of step.withKeys) {
            if (declared.has(key)) continue;
            problems.push(
              `${file}:${step.line} passes \`${key}:\` to ${step.uses}, but ${metadataPath} declares no such input (GitHub Actions drops it with an "Unexpected input" warning)`,
            );
          }
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(10);
    expect(problems).toEqual([]);
  });

  test("discovers the example and claude workflow files", () => {
    expect(workflowFiles).toContain("examples/claude.yml");
    expect(workflowFiles).toContain("base-action/examples/issue-triage.yml");
    expect(workflowFiles).toContain(".github/workflows/claude.yml");
    expect(workflowFiles.length).toBeGreaterThanOrEqual(10);
  });

  test("the YAML scanner finds every job, step and uses: reference", () => {
    const problems: string[] = [];
    for (const file of workflowFiles) {
      const source = readRepoFile(file);
      const workflow = parseWorkflow(source);
      if (workflow.jobs.length === 0) {
        problems.push(`${file}: scanner found no jobs under jobs:`);
      }
      for (const job of workflow.jobs) {
        if (job.steps.length === 0) {
          problems.push(
            `${file}:${job.line} scanner found no steps in job "${job.id}"`,
          );
        }
      }
      const structural = workflow.jobs
        .flatMap((job) => job.steps)
        .filter((step) => step.uses !== null).length;
      const textual = source
        .split("\n")
        .filter((line) => /^\s*(?:-\s+)?uses:\s*\S/.test(line)).length;
      if (structural !== textual) {
        problems.push(
          `${file}: scanner found ${structural} step uses: fields but the file has ${textual} uses: lines`,
        );
      }
    }
    expect(problems).toEqual([]);
  });

  test("steps on the GitHub App auth path (no github_token) run with id-token: write", () => {
    const problems: string[] = [];
    for (const file of workflowFiles) {
      const workflow = parseWorkflow(readRepoFile(file));
      for (const job of workflow.jobs) {
        const grants = grantsFor(job, workflow);
        for (const step of job.steps) {
          if (
            step.uses === null ||
            !step.uses.startsWith("anthropics/claude-code-action@")
          ) {
            continue;
          }
          if (step.withKeys.includes("github_token")) continue;
          if (grantsWrite(grants, "id-token")) continue;
          problems.push(
            `${file}:${step.line} step \`uses: ${step.uses}\` has no github_token: under with: (GitHub App OIDC auth path), so job "${job.id}" needs \`id-token: write\`; ${describeGrants(grants)}`,
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });

  test("steps that allow or run `gh pr comment` have pull-requests: write", () => {
    const problems: string[] = [];
    for (const file of workflowFiles) {
      const workflow = parseWorkflow(readRepoFile(file));
      for (const job of workflow.jobs) {
        const grants = grantsFor(job, workflow);
        for (const step of job.steps) {
          const usage = step.claudeArgs.includes("Bash(gh pr comment")
            ? "claude_args allows Bash(gh pr comment ...)"
            : step.run.includes("gh pr comment")
              ? "run: invokes gh pr comment"
              : step.prompt.includes("gh pr comment")
                ? "prompt: instructs Claude to use gh pr comment"
                : null;
          if (usage === null) continue;
          if (grantsWrite(grants, "pull-requests")) continue;
          problems.push(
            `${file}:${step.line} ${usage} but job "${job.id}" lacks \`pull-requests: write\`; ${describeGrants(grants)}`,
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });

  test("actions/checkout is pinned to v6 or a full commit SHA", () => {
    const problems: string[] = [];
    for (const file of workflowFiles) {
      for (const ref of scanUses(readRepoFile(file))) {
        if (ref.action !== "actions/checkout") continue;
        if (ref.ref === "v6" || SHA_PATTERN.test(ref.ref)) continue;
        problems.push(
          `${file}:${ref.line} uses actions/checkout@${ref.ref}; pin to actions/checkout@v6 or a 40-hex commit SHA`,
        );
      }
    }
    expect(problems).toEqual([]);
  });

  test("examples reference anthropics/claude-code-action@v1", () => {
    const problems: string[] = [];
    for (const file of workflowFiles.filter((f) => f.startsWith("examples/"))) {
      for (const ref of scanUses(readRepoFile(file))) {
        if (ref.action !== "anthropics/claude-code-action") continue;
        if (ref.ref === "v1") continue;
        problems.push(
          `${file}:${ref.line} uses anthropics/claude-code-action@${ref.ref}; examples must reference the v1 release tag, not ${ref.ref}`,
        );
      }
    }
    expect(problems).toEqual([]);
  });
});
