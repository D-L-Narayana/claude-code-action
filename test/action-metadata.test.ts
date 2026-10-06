import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const readRepoFile = (relativePath: string): string =>
  readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");

const actionMetadata = readRepoFile("action.yml");
const baseActionMetadata = readRepoFile("base-action/action.yml");
const usageDoc = readRepoFile("docs/usage.md");
const runEntrypoint = readRepoFile("src/entrypoints/run.ts");
const ciWorkflow = readRepoFile(".github/workflows/ci.yml");
const projectGuide = readRepoFile("CLAUDE.md");

const CI_FILE = ".github/workflows/ci.yml";
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const BUN_VERSION_PATTERN = /^\s*bun-version:\s*([^\s#]+)/gm;
const SETUP_BUN_PATTERN = /^\s*uses:\s*oven-sh\/setup-bun@([^\s#]+)/gm;

type DeclaredInput = { name: string; line: number };

/**
 * Inputs declared under the top-level `inputs:` block: two-space-indented
 * `  name:` keys between the `inputs:` line and the `outputs:` line. Nested
 * fields, multi-line `description: |` bodies and `# comments` never match the
 * key pattern, so they are skipped.
 */
function declaredInputs(metadata: string, file: string): DeclaredInput[] {
  const lines = metadata.split("\n");
  const start = lines.findIndex((line) => /^inputs:\s*$/.test(line));
  const end = lines.findIndex((line) => /^outputs:\s*$/.test(line));
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `${file} must declare a top-level \`inputs:\` block followed by \`outputs:\``,
    );
  }

  const inputs: DeclaredInput[] = [];
  for (let index = start + 1; index < end; index++) {
    const match = lines[index]?.match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (match?.[1]) {
      inputs.push({ name: match[1], line: index + 1 });
    }
  }
  if (inputs.length === 0) {
    throw new Error(`${file}: no inputs found under \`inputs:\``);
  }
  return inputs;
}

/**
 * One problem per `inputs.NAME` expression reference whose NAME is not a
 * declared input. The `(?<![\w.])` lookbehind keeps `github.event.inputs.x`
 * (workflow_dispatch inputs) out of the scan.
 */
function undeclaredInputReferences(metadata: string, file: string): string[] {
  const declared = new Set(
    declaredInputs(metadata, file).map((input) => input.name),
  );
  const problems: string[] = [];
  metadata.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(/(?<![\w.])inputs\.([A-Za-z0-9_-]+)/g)) {
      const name = match[1];
      if (name && !declared.has(name)) {
        problems.push(
          `${file}:${index + 1} references undeclared input \`${name}\` (no \`  ${name}:\` key under inputs:): ${line.trim()}`,
        );
      }
    }
  });
  return problems;
}

/** Returns the single `KEY: value` pin in a file, or throws naming the file. */
function singlePin(metadata: string, file: string, pattern: RegExp): string {
  const pins = [...metadata.matchAll(pattern)]
    .map((match) => match[1])
    .filter((pin): pin is string => pin !== undefined);
  if (pins.length !== 1) {
    throw new Error(
      `${file} must contain exactly one match for ${pattern}, found ${pins.length}: ${pins.join(", ")}`,
    );
  }
  return pins[0] ?? "";
}

// Synthetic metadata used to prove the scanners behave as intended regardless
// of the current state of action.yml: a block-scalar description, a comment
// at key indentation, an undeclared `inputs.mode` reference (line 14) and a
// `github.event.inputs.*` reference that must be ignored.
const SAMPLE_METADATA = [
  "name: sample",
  "inputs:",
  "  prompt:",
  "    description: |",
  "      Multi-line description; indented body lines are not input keys.",
  '    default: ""',
  "  # mode was removed in v1 and is intentionally not declared",
  "outputs:",
  "  conclusion:",
  "    value: ${{ steps.run.outputs.conclusion }}",
  "runs:",
  "  steps:",
  "    - env:",
  "        MODE: ${{ inputs.mode }}",
  "        PROMPT: ${{ inputs.prompt }}",
  "        DISPATCH: ${{ github.event.inputs.analysis_type }}",
].join("\n");

// ---------------------------------------------------------------------------
// .github/workflows/ci.yml — triggers, permissions, action pins and commands.
// Scanned line by line (no YAML library): `key:` entries at a fixed
// indentation own the deeper-indented lines that follow them.
// ---------------------------------------------------------------------------

type ScannedLine = { text: string; number: number };
type KeyBlock = {
  name: string;
  value: string;
  line: number;
  body: ScannedLine[];
};
type UsesRef = { line: number; action: string; ref: string; comment: string };

const REQUIRED_TRIGGERS = [
  "pull_request",
  "workflow_call",
  "workflow_dispatch",
];
const VERSION_COMMENT = /^#\s*v\d+(?:\.\d+)*\s*$/;

const indentOf = (text: string): number =>
  text.length - text.trimStart().length;
const isBlankOrComment = (text: string): boolean =>
  text.trim() === "" || text.trim().startsWith("#");
const stripInlineComment = (value: string): string =>
  value.replace(/\s+#.*$/, "").trim();

const toLines = (source: string): ScannedLine[] =>
  source.split("\n").map((raw, index) => ({
    text: raw.replace(/\r$/, ""),
    number: index + 1,
  }));

/**
 * `key:` entries at exactly `indent` spaces, each owning the lines nested
 * under it (deeper indentation, blanks and comments) up to the next entry at
 * the same or a shallower indentation.
 */
function keyBlocks(lines: ScannedLine[], indent: number): KeyBlock[] {
  const blocks: KeyBlock[] = [];
  let current: KeyBlock | undefined;
  const keyPattern = new RegExp(`^ {${indent}}([^\\s#-][^:]*):(?:\\s+(.*))?$`);
  for (const line of lines) {
    const match = line.text.match(keyPattern);
    if (match?.[1] !== undefined) {
      current = {
        name: match[1].trim(),
        value: stripInlineComment(match[2] ?? ""),
        line: line.number,
        body: [],
      };
      blocks.push(current);
      continue;
    }
    if (!isBlankOrComment(line.text) && indentOf(line.text) <= indent) {
      current = undefined;
      continue;
    }
    current?.body.push(line);
  }
  return blocks;
}

function usesRefs(lines: ScannedLine[]): UsesRef[] {
  const refs: UsesRef[] = [];
  for (const line of lines) {
    const match = line.text.match(
      /^\s*(?:-\s+)?uses:\s*["']?([^\s"'@#]+)@([^\s"'#]+)["']?\s*(#.*)?$/,
    );
    if (match?.[1] !== undefined && match[2] !== undefined) {
      refs.push({
        line: line.number,
        action: match[1],
        ref: match[2],
        comment: (match[3] ?? "").trim(),
      });
    }
  }
  return refs;
}

/** `run:` commands in a job body; `run: |` block scalars are joined with newlines. */
function runCommands(body: ScannedLine[]): string[] {
  const commands: string[] = [];
  let index = 0;
  while (index < body.length) {
    const line = body[index];
    index++;
    if (line === undefined) break;
    const match = line.text.match(/^\s*(?:-\s+)?run:(?:\s+(.*))?$/);
    if (match === null) continue;
    const value = (match[1] ?? "").trim();
    if (!/^[|>][-+0-9]*\s*(?:#.*)?$/.test(value)) {
      commands.push(value);
      continue;
    }
    const keyIndent = line.text.indexOf("run:");
    const block: string[] = [];
    while (index < body.length) {
      const next = body[index];
      if (next === undefined) break;
      if (next.text.trim() === "") {
        block.push("");
        index++;
        continue;
      }
      if (indentOf(next.text) <= keyIndent) break;
      block.push(next.text.trim());
      index++;
    }
    commands.push(block.join("\n").trim());
  }
  return commands;
}

/** (a) `on:` lists pull_request, workflow_call and an input-less workflow_dispatch. */
function triggerProblems(source: string, file: string): string[] {
  const top = keyBlocks(toLines(source), 0);
  const on = top.find((block) => block.name === "on");
  if (on === undefined) return [`${file}: no top-level on: block`];
  if (on.value !== "") {
    return [
      `${file}:${on.line} on: must list each trigger on its own line so it can be inspected, got inline value "${on.value}"`,
    ];
  }
  const triggers = keyBlocks(on.body, 2);
  const declared = triggers.map((trigger) => trigger.name).join(", ");
  const problems = REQUIRED_TRIGGERS.filter(
    (name) => !triggers.some((trigger) => trigger.name === name),
  ).map(
    (name) =>
      `${file}:${on.line} on: lacks the \`${name}\` trigger (declared: ${declared || "none"})`,
  );
  const dispatch = triggers.find(
    (trigger) => trigger.name === "workflow_dispatch",
  );
  if (dispatch !== undefined) {
    const inputs = keyBlocks(dispatch.body, 4).find(
      (entry) => entry.name === "inputs",
    );
    if (inputs !== undefined) {
      problems.push(
        `${file}:${inputs.line} workflow_dispatch must stay a bare manual trigger; remove its inputs:`,
      );
    } else if (dispatch.value !== "" && dispatch.value !== "{}") {
      problems.push(
        `${file}:${dispatch.line} workflow_dispatch must stay a bare manual trigger, got inline value "${dispatch.value}"`,
      );
    }
  }
  return problems;
}

/** (b) workflow-level permissions are exactly `contents: read`; jobs add none. */
function permissionProblems(source: string, file: string): string[] {
  const top = keyBlocks(toLines(source), 0);
  const problems: string[] = [];
  const permissions = top.find((block) => block.name === "permissions");
  if (permissions === undefined) {
    problems.push(
      `${file}: no workflow-level permissions: block; expected exactly \`contents: read\``,
    );
  } else {
    const grants = keyBlocks(permissions.body, 2).map(
      (grant) => `${grant.name}: ${grant.value}`,
    );
    if (permissions.value !== "" || grants.join(", ") !== "contents: read") {
      const actual =
        permissions.value !== "" ? permissions.value : `{${grants.join(", ")}}`;
      problems.push(
        `${file}:${permissions.line} workflow-level permissions must be exactly \`contents: read\`, got ${actual}`,
      );
    }
  }
  const jobs = top.find((block) => block.name === "jobs");
  for (const job of jobs === undefined ? [] : keyBlocks(jobs.body, 2)) {
    const own = keyBlocks(job.body, 4).find(
      (entry) => entry.name === "permissions",
    );
    if (own !== undefined) {
      problems.push(
        `${file}:${own.line} job "${job.name}" declares its own permissions:; the workflow-level \`contents: read\` must be the only grant`,
      );
    }
  }
  return problems;
}

/** (c) every `uses:` is a 40-hex commit SHA followed by a `# vX.Y.Z` comment. */
function usesPinProblems(source: string, file: string): string[] {
  const lines = toLines(source);
  const refs = usesRefs(lines);
  const usesLines = lines.filter((line) =>
    /^\s*(?:-\s+)?uses:\s*\S/.test(line.text),
  );
  const problems: string[] = [];
  if (usesLines.length === 0) {
    problems.push(`${file}: scanner found no uses: lines`);
  }
  for (const line of usesLines) {
    if (!refs.some((ref) => ref.line === line.number)) {
      problems.push(
        `${file}:${line.number} uses: value is not of the form owner/repo@ref: ${line.text.trim()}`,
      );
    }
  }
  for (const ref of refs) {
    if (!SHA_PATTERN.test(ref.ref)) {
      problems.push(
        `${file}:${ref.line} uses ${ref.action}@${ref.ref}; pin to a 40-hex commit SHA (tag and branch refs are mutable)`,
      );
    } else if (!VERSION_COMMENT.test(ref.comment)) {
      problems.push(
        `${file}:${ref.line} uses ${ref.action}@${ref.ref} without a trailing \`# vX.Y.Z\` comment naming the pinned release (got "${ref.comment}")`,
      );
    }
  }
  return problems;
}

function jobsOf(
  source: string,
  file: string,
): { line: number; jobs: KeyBlock[] } {
  const jobs = keyBlocks(toLines(source), 0).find(
    (block) => block.name === "jobs",
  );
  if (jobs === undefined) throw new Error(`${file}: no top-level jobs: block`);
  return { line: jobs.line, jobs: keyBlocks(jobs.body, 2) };
}

// Synthetic CI workflows proving the scanners bite. The first lacks
// workflow_dispatch and pins one action by tag and another by a bare SHA
// without a version comment; the second gives workflow_dispatch inputs,
// grants read-all at workflow level and adds job-level permissions.
const SAMPLE_CI_UNPINNED = [
  "name: sample",
  "on:",
  "  pull_request:",
  "  workflow_call:",
  "permissions:",
  "  contents: read",
  "jobs:",
  "  test:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v6",
  "      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
  "        with:",
  "          bun-version: 1.3.14",
  "      - run: |",
  "          bun install",
  "          bun test",
].join("\n");

const SAMPLE_CI_OVERGRANTED = [
  "on:",
  "  pull_request:",
  "  workflow_call:",
  "  workflow_dispatch:",
  "    inputs:",
  "      reason:",
  "        description: why",
  "permissions: read-all",
  "jobs:",
  "  test:",
  "    permissions:",
  "      contents: write",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2",
  "        with:",
  "          fetch-depth: 1",
  "      - name: Test",
  "        run: bun test",
].join("\n");

describe("action metadata", () => {
  test("should expose the conclusion output from the run step", () => {
    const metadata = readFileSync(
      new URL("../action.yml", import.meta.url),
      "utf8",
    );

    expect(metadata).toMatch(
      /^  conclusion:\n    description: .+\n    value: \$\{\{ steps\.run\.outputs\.conclusion \}\}$/m,
    );
  });

  test("the inputs scanner reports undeclared inputs.NAME references in a synthetic sample", () => {
    expect(declaredInputs(SAMPLE_METADATA, "sample.yml")).toEqual([
      { name: "prompt", line: 3 },
    ]);

    const problems = undeclaredInputReferences(SAMPLE_METADATA, "sample.yml");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("sample.yml:14");
    expect(problems[0]).toContain("`mode`");
  });

  test("every inputs.NAME reference in action.yml names a declared input", () => {
    expect(undeclaredInputReferences(actionMetadata, "action.yml")).toEqual([]);
  });

  test("docs/usage.md Inputs table documents every declared input and nothing else", () => {
    const inputsSection = usageDoc.match(
      /^## Inputs\n([\s\S]*?)(?=^#{2,3} )/m,
    )?.[1];
    if (inputsSection === undefined) {
      throw new Error(
        "docs/usage.md must contain a `## Inputs` section followed by another heading",
      );
    }

    const documented = [...inputsSection.matchAll(/^\| `([^`]+)`/gm)]
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined);
    const declared = declaredInputs(actionMetadata, "action.yml");
    const problems: string[] = [];

    for (const input of declared) {
      if (!documented.includes(input.name)) {
        problems.push(
          `docs/usage.md Inputs table lacks a row starting with "| \`${input.name}\`" (input declared at action.yml:${input.line})`,
        );
      }
    }
    for (const name of documented) {
      if (!declared.some((input) => input.name === name)) {
        problems.push(
          `docs/usage.md Inputs table documents \`${name}\`, which action.yml does not declare under inputs:`,
        );
      }
    }

    expect(problems).toEqual([]);
  });

  test("every steps.run.outputs.NAME used by action.yml is set by src/entrypoints/run.ts", () => {
    const referenced = new Map<string, number>();
    actionMetadata.split("\n").forEach((line, index) => {
      for (const match of line.matchAll(
        /steps\.run\.outputs\.([A-Za-z0-9_-]+)/g,
      )) {
        const name = match[1];
        if (name && !referenced.has(name)) {
          referenced.set(name, index + 1);
        }
      }
    });
    if (referenced.size === 0) {
      throw new Error(
        "action.yml must reference at least one steps.run.outputs.* value",
      );
    }

    const problems: string[] = [];
    for (const [name, line] of referenced) {
      if (!runEntrypoint.includes(`core.setOutput("${name}"`)) {
        problems.push(
          `action.yml:${line} references steps.run.outputs.${name}, but src/entrypoints/run.ts never calls core.setOutput("${name}", ...)`,
        );
      }
    }

    // Every declared output must be wired to the run step output of the same name.
    const outputsBlock =
      actionMetadata.match(/^outputs:\n([\s\S]*?)^runs:/m)?.[1] ?? "";
    const declaredOutputs = [
      ...outputsBlock.matchAll(/^  ([A-Za-z0-9_-]+):\s*$/gm),
    ]
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined);
    if (declaredOutputs.length === 0) {
      throw new Error("action.yml must declare outputs under `outputs:`");
    }
    for (const name of declaredOutputs) {
      if (!outputsBlock.includes(`value: \${{ steps.run.outputs.${name} }}`)) {
        problems.push(
          `action.yml output \`${name}\` must have value: \${{ steps.run.outputs.${name} }}`,
        );
      }
    }

    expect(problems).toEqual([]);
  });

  test("action.yml and base-action/action.yml install the same Bun toolchain", () => {
    const actionBun = singlePin(
      actionMetadata,
      "action.yml",
      BUN_VERSION_PATTERN,
    );
    const baseBun = singlePin(
      baseActionMetadata,
      "base-action/action.yml",
      BUN_VERSION_PATTERN,
    );
    const actionSetupBun = singlePin(
      actionMetadata,
      "action.yml",
      SETUP_BUN_PATTERN,
    );
    const baseSetupBun = singlePin(
      baseActionMetadata,
      "base-action/action.yml",
      SETUP_BUN_PATTERN,
    );

    const problems: string[] = [];
    if (!/^\d+\.\d+\.\d+$/.test(actionBun)) {
      problems.push(
        `action.yml bun-version must be an exact x.y.z version, got "${actionBun}"`,
      );
    }
    if (baseBun !== actionBun) {
      problems.push(
        `base-action/action.yml pins bun-version ${baseBun} but action.yml pins ${actionBun}`,
      );
    }
    if (!SHA_PATTERN.test(actionSetupBun)) {
      problems.push(
        `action.yml must pin oven-sh/setup-bun to a 40-hex commit SHA, got "${actionSetupBun}"`,
      );
    }
    if (baseSetupBun !== actionSetupBun) {
      problems.push(
        `base-action/action.yml uses oven-sh/setup-bun@${baseSetupBun} but action.yml uses @${actionSetupBun}`,
      );
    }

    expect(problems).toEqual([]);
  });
});

describe("ci workflow", () => {
  test("the CI scanners report missing triggers, loose pins and extra grants in synthetic samples", () => {
    const missingDispatch = triggerProblems(SAMPLE_CI_UNPINNED, "sample.yml");
    expect(missingDispatch).toHaveLength(1);
    expect(missingDispatch[0]).toContain("sample.yml:2");
    expect(missingDispatch[0]).toContain("`workflow_dispatch`");
    expect(permissionProblems(SAMPLE_CI_UNPINNED, "sample.yml")).toEqual([]);

    const loosePins = usesPinProblems(SAMPLE_CI_UNPINNED, "sample.yml");
    expect(loosePins).toHaveLength(2);
    expect(loosePins[0]).toContain("sample.yml:11 uses actions/checkout@v6");
    expect(loosePins[1]).toContain(
      "sample.yml:12 uses oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 without",
    );
    expect(
      jobsOf(SAMPLE_CI_UNPINNED, "sample.yml").jobs.map((job) => [
        job.name,
        runCommands(job.body),
      ]),
    ).toEqual([["test", ["bun install\nbun test"]]]);

    const dispatchInputs = triggerProblems(SAMPLE_CI_OVERGRANTED, "sample.yml");
    expect(dispatchInputs).toHaveLength(1);
    expect(dispatchInputs[0]).toContain("sample.yml:5");
    expect(dispatchInputs[0]).toContain("inputs");

    const grants = permissionProblems(SAMPLE_CI_OVERGRANTED, "sample.yml");
    expect(grants).toHaveLength(2);
    expect(grants[0]).toContain("sample.yml:8");
    expect(grants[0]).toContain("read-all");
    expect(grants[1]).toContain('sample.yml:11 job "test"');
    expect(usesPinProblems(SAMPLE_CI_OVERGRANTED, "sample.yml")).toEqual([]);
    expect(
      jobsOf(SAMPLE_CI_OVERGRANTED, "sample.yml").jobs.map((job) =>
        runCommands(job.body),
      ),
    ).toEqual([["bun test"]]);
  });

  test("on: declares pull_request, workflow_call and an input-less workflow_dispatch", () => {
    expect(triggerProblems(ciWorkflow, CI_FILE)).toEqual([]);
  });

  test("workflow-level permissions are exactly contents: read and no job overrides them", () => {
    expect(permissionProblems(ciWorkflow, CI_FILE)).toEqual([]);
  });

  test("every uses: is pinned to a commit SHA with a version comment", () => {
    expect(usesPinProblems(ciWorkflow, CI_FILE)).toEqual([]);
  });

  test("ci.yml pins the same Bun toolchain as action.yml and the same checkout as the other workflows", () => {
    const lines = toLines(ciWorkflow);
    const refs = usesRefs(lines);
    const problems: string[] = [];

    const actionSetupBun = singlePin(
      actionMetadata,
      "action.yml",
      SETUP_BUN_PATTERN,
    );
    const actionBun = singlePin(
      actionMetadata,
      "action.yml",
      BUN_VERSION_PATTERN,
    );
    const setupBunRefs = refs.filter(
      (ref) => ref.action === "oven-sh/setup-bun",
    );
    if (setupBunRefs.length === 0) {
      problems.push(`${CI_FILE}: no oven-sh/setup-bun step found`);
    }
    for (const ref of setupBunRefs) {
      if (ref.ref !== actionSetupBun) {
        problems.push(
          `${CI_FILE}:${ref.line} uses oven-sh/setup-bun@${ref.ref} but action.yml pins @${actionSetupBun}`,
        );
      }
    }
    const bunVersions = lines.flatMap((line) => {
      const version = line.text.match(/^\s*bun-version:\s*([^\s#]+)/)?.[1];
      return version === undefined ? [] : [{ line: line.number, version }];
    });
    if (bunVersions.length !== setupBunRefs.length) {
      problems.push(
        `${CI_FILE}: ${setupBunRefs.length} setup-bun step(s) but ${bunVersions.length} bun-version pin(s); every setup-bun step must pin bun-version`,
      );
    }
    for (const pin of bunVersions) {
      if (pin.version !== actionBun) {
        problems.push(
          `${CI_FILE}:${pin.line} pins bun-version ${pin.version} but action.yml pins ${actionBun}`,
        );
      }
    }

    // action.yml is a composite action and never checks out code, so the
    // checkout pin is compared with the SHA the repository's other workflows
    // agree on.
    const workflowsDir = new URL("../.github/workflows/", import.meta.url);
    const siblingShas = new Map<string, string[]>();
    for (const name of readdirSync(workflowsDir).sort()) {
      if (!/\.ya?ml$/.test(name) || name === "ci.yml") continue;
      const source = readFileSync(new URL(name, workflowsDir), "utf8");
      for (const ref of usesRefs(toLines(source))) {
        if (ref.action === "actions/checkout" && SHA_PATTERN.test(ref.ref)) {
          siblingShas.set(ref.ref, [
            ...(siblingShas.get(ref.ref) ?? []),
            `${name}:${ref.line}`,
          ]);
        }
      }
    }
    if (siblingShas.size !== 1) {
      problems.push(
        `expected the other workflows to agree on one SHA-pinned actions/checkout, found ${siblingShas.size}: ${[...siblingShas].map(([sha, where]) => `${sha} (${where.join(", ")})`).join("; ") || "none"}`,
      );
    }
    const siblingSha = [...siblingShas.keys()][0];
    const checkoutRefs = refs.filter(
      (ref) => ref.action === "actions/checkout",
    );
    if (checkoutRefs.length === 0) {
      problems.push(`${CI_FILE}: no actions/checkout step found`);
    }
    for (const ref of checkoutRefs) {
      if (siblingSha !== undefined && ref.ref !== siblingSha) {
        problems.push(
          `${CI_FILE}:${ref.line} uses actions/checkout@${ref.ref} but the other workflows pin @${siblingSha}`,
        );
      }
    }

    expect(problems).toEqual([]);
  });

  test("the four CI jobs run the documented commands", () => {
    const { line: jobsLine, jobs } = jobsOf(ciWorkflow, CI_FILE);

    // The Python command is read from CLAUDE.md so the two cannot drift apart.
    const documentedUv = [...projectGuide.matchAll(/`(uv run [^`]+)`/g)]
      .map((match) => match[1])
      .filter((command): command is string => command !== undefined);
    if (documentedUv.length !== 1) {
      throw new Error(
        `CLAUDE.md must document exactly one backticked \`uv run …\` command for the agent-approval-check tests, found ${documentedUv.length}`,
      );
    }
    const uvCommand = documentedUv[0] ?? "";

    const expected: [string, string][] = [
      ["test", "bun test"],
      ["prettier", "bun run format:check"],
      ["typecheck", "bun run typecheck"],
      ["python-tests", uvCommand],
    ];
    const problems: string[] = [];
    for (const [jobName, command] of expected) {
      const job = jobs.find((entry) => entry.name === jobName);
      if (job === undefined) {
        problems.push(
          `${CI_FILE}:${jobsLine} jobs: lacks the "${jobName}" job (found: ${jobs.map((entry) => entry.name).join(", ") || "none"})`,
        );
        continue;
      }
      const commands = runCommands(job.body);
      if (!commands.includes(command)) {
        problems.push(
          `${CI_FILE}:${job.line} job "${jobName}" has no step with \`run: ${command}\` (run steps: ${commands.map((entry) => JSON.stringify(entry)).join(", ") || "none"})`,
        );
      }
    }
    for (const path of uvCommand.match(/agent-approval-check\/\S+/g) ?? []) {
      if (!existsSync(new URL(`../${path}`, import.meta.url))) {
        problems.push(
          `CLAUDE.md's uv command references ${path}, which does not exist in the repository`,
        );
      }
    }

    expect(problems).toEqual([]);
  });
});
