import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import {
  startFakeGitHub,
  type FakeGitHub,
  type FakePullRequest,
} from "./fake-github";
import { E2E_SESSION_ID, type CapturedInvocation } from "./fake-run-claude";

// End-to-end coverage of the single orchestrator (src/entrypoints/run.ts) for
// the primary user workflows: a maintainer writes `@claude …` on an issue or a
// pull request, and an automation workflow runs with an explicit prompt.
//
// Each scenario spawns the orchestrator the way action.yml does
// (`bun --no-env-file run src/entrypoints/run.ts`) with a GitHub Actions
// environment pointing at an in-process fake GitHub API (./fake-github.ts), a
// real git working tree with a bare `origin`, and a preload plugin that
// replaces only the Claude SDK call (./preload-fake-claude.ts). Everything else
// — permission checks, tracking comment, GraphQL fetch, prompt generation,
// branch checkout/creation, git credential setup, base-branch config restore,
// MCP configuration, outputs, and the final comment update — is the production
// code path.
//
// The spawned process gets an unreachable HTTP(S) proxy for every host except
// the loopback fake, so an accidental call to a real endpoint (GitHub, the
// Claude API, the CLI installer) fails immediately instead of hanging or
// leaving the machine; the fake additionally records any route it does not
// know under `unexpected`, which every scenario asserts to be empty.
//
// E2E_ACTION_ROOT lets the same harness run against another checkout of the
// action (used to record failing baseline evidence for the failure contract).

const ACTION_ROOT = process.env.E2E_ACTION_ROOT
  ? resolve(process.env.E2E_ACTION_ROOT)
  : resolve(import.meta.dir, "..", "..");
const PRELOAD = join(import.meta.dir, "preload-fake-claude.ts");

const OWNER = "test-owner";
const REPO = "test-repo";
const ACTOR = "octocat";
const ENTITY_NUMBER = 42;
const RUN_ID = "424242";
const TOKEN = "e2e-github-token";
const CREATED_COMMENT_ID = 1001;
const TRIGGER_COMMENT_ID = 777;
const TRIGGER_CREATED_AT = "2026-10-01T12:00:00Z";
const TRIGGER_COMMENT = "@claude please add a setup section to the README";
const EARLIER_COMMENT = "Earlier context comment from a teammate";
const PR_HEAD_BRANCH = "feature/docs";
const RUN_TIMEOUT_MS = 180_000;
const KILL_AFTER_MS = RUN_TIMEOUT_MS - 10_000;
const COMMENT_PATH = `/repos/${OWNER}/${REPO}/issues/comments/${CREATED_COMMENT_ID}`;
// Port 9 (discard) is closed on the loopback interface, so proxied requests
// are refused at once.
const TRIPWIRE_PROXY = "http://127.0.0.1:9";
// The URL the action writes into the git remote when it replaces the
// actions/checkout credential (see src/github/operations/git-config.ts).
const TOKEN_REMOTE_URL = `https://x-access-token:${TOKEN}@github.com/${OWNER}/${REPO}.git`;

type Scenario = "issue" | "pull_request" | "workflow_dispatch";

type Harness = {
  root: string;
  workspace: string;
  home: string;
  runnerTemp: string;
  outputPath: string;
  summaryPath: string;
  capturePath: string;
  eventPath: string;
  eventName: string;
  fakeClaude: string;
  github: FakeGitHub;
};

type RunResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputs: Record<string, string>;
  summary: string;
  finalCommentBody: string;
  capture: CapturedInvocation | undefined;
};

function git(cwd: string, home: string, ...args: string[]): string {
  const result = Bun.spawnSync({
    cmd: [
      "git",
      "-c",
      "user.name=E2E Test",
      "-c",
      "user.email=e2e@example.com",
      ...args,
    ],
    cwd,
    env: { PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString().trim();
}

function tryGit(cwd: string, home: string, ...args: string[]): string {
  try {
    return git(cwd, home, ...args);
  } catch {
    return "";
  }
}

const repositoryPayload = {
  name: REPO,
  full_name: `${OWNER}/${REPO}`,
  default_branch: "main",
  owner: { login: OWNER },
};

function issuePayload(isPullRequest: boolean) {
  return {
    number: ENTITY_NUMBER,
    title: "Document the setup steps",
    body: "The README has no setup section.",
    user: { login: ACTOR, id: 583231 },
    state: "open",
    labels: [],
    created_at: "2026-10-01T10:00:00Z",
    updated_at: TRIGGER_CREATED_AT,
    html_url: `https://github.com/${OWNER}/${REPO}/${isPullRequest ? "pull" : "issues"}/${ENTITY_NUMBER}`,
    ...(isPullRequest && {
      pull_request: {
        url: `https://api.github.com/repos/${OWNER}/${REPO}/pulls/${ENTITY_NUMBER}`,
        html_url: `https://github.com/${OWNER}/${REPO}/pull/${ENTITY_NUMBER}`,
        diff_url: `https://github.com/${OWNER}/${REPO}/pull/${ENTITY_NUMBER}.diff`,
        patch_url: `https://github.com/${OWNER}/${REPO}/pull/${ENTITY_NUMBER}.patch`,
      },
    }),
  };
}

function eventPayload(scenario: Scenario): unknown {
  if (scenario === "workflow_dispatch") {
    return {
      inputs: {},
      ref: "refs/heads/main",
      repository: repositoryPayload,
      sender: { login: ACTOR },
      workflow: ".github/workflows/maintenance.yml",
    };
  }
  return {
    action: "created",
    issue: issuePayload(scenario === "pull_request"),
    comment: {
      id: TRIGGER_COMMENT_ID,
      body: TRIGGER_COMMENT,
      user: { login: ACTOR, id: 583231 },
      created_at: TRIGGER_CREATED_AT,
      updated_at: TRIGGER_CREATED_AT,
      html_url: `https://github.com/${OWNER}/${REPO}/issues/${ENTITY_NUMBER}#issuecomment-${TRIGGER_COMMENT_ID}`,
    },
    repository: repositoryPayload,
    sender: { login: ACTOR },
  };
}

function createHarness(scenario: Scenario): Harness {
  const root = mkdtempSync(join(tmpdir(), "claude-action-e2e-"));
  const workspace = join(root, "workspace");
  const remote = join(root, "origin.git");
  const home = join(root, "home");
  const runnerTemp = join(root, "runner-temp");
  for (const dir of [workspace, home, runnerTemp, join(root, "bin")]) {
    mkdirSync(dir, { recursive: true });
  }

  let headSha = "";
  let pullRequest: FakePullRequest | undefined;
  if (scenario !== "workflow_dispatch") {
    git(root, home, "init", "-q", "--bare", "--initial-branch=main", remote);
    git(root, home, "init", "-q", "-b", "main", workspace);
    writeFileSync(join(workspace, "README.md"), "# Demo\n");
    mkdirSync(join(workspace, ".claude"), { recursive: true });
    writeFileSync(
      join(workspace, ".claude", "settings.json"),
      '{"source":"base"}\n',
    );
    git(workspace, home, "add", ".");
    git(workspace, home, "commit", "-q", "-m", "initial");
    git(workspace, home, "remote", "add", "origin", remote);
    git(workspace, home, "push", "-q", "-u", "origin", "main");
    headSha = git(workspace, home, "rev-parse", "HEAD");

    if (scenario === "pull_request") {
      // The PR branch exists only on origin (like a real checkout of the base
      // branch): it modifies a Claude config file and adds documentation.
      git(workspace, home, "checkout", "-q", "-b", PR_HEAD_BRANCH);
      writeFileSync(
        join(workspace, ".claude", "settings.json"),
        '{"source":"pr"}\n',
      );
      mkdirSync(join(workspace, "docs"), { recursive: true });
      writeFileSync(join(workspace, "docs", "SETUP.md"), "# Setup\n");
      git(workspace, home, "add", ".");
      git(workspace, home, "commit", "-q", "-m", "docs: add setup section");
      git(workspace, home, "push", "-q", "-u", "origin", PR_HEAD_BRANCH);
      const prHeadSha = git(workspace, home, "rev-parse", "HEAD");
      git(workspace, home, "checkout", "-q", "main");
      git(workspace, home, "branch", "-q", "-D", PR_HEAD_BRANCH);

      // What actions/checkout leaves behind: its own credential header.
      git(
        workspace,
        home,
        "config",
        "--local",
        "http.https://github.com/.extraheader",
        "AUTHORIZATION: basic Y2hlY2tvdXQtdG9rZW4=",
      );
      // The action rewrites origin to the real GitHub URL carrying its token.
      // Map that URL back to the local bare repository so the production code
      // path (fetch/checkout through the rewritten remote) runs unmodified.
      git(
        root,
        home,
        "config",
        "--global",
        `url.${remote}.insteadOf`,
        TOKEN_REMOTE_URL,
      );

      pullRequest = {
        headRefName: PR_HEAD_BRANCH,
        baseRefName: "main",
        headSha: prHeadSha,
        additions: 3,
        deletions: 1,
        files: [
          {
            path: "docs/SETUP.md",
            additions: 1,
            deletions: 0,
            changeType: "ADDED",
          },
          {
            path: ".claude/settings.json",
            additions: 1,
            deletions: 1,
            changeType: "MODIFIED",
          },
        ],
        reviewer: "reviewer",
        reviewBody: "Looks reasonable overall.",
        inlineCommentBody: "nit: mention the required bun version here",
      };
    }
  }

  const fakeClaude = join(root, "bin", "claude");
  writeFileSync(fakeClaude, "#!/bin/sh\nexit 0\n");
  chmodSync(fakeClaude, 0o755);

  // The runner creates these files before the job starts; @actions/core
  // refuses to write outputs or summaries to a path that does not exist.
  const outputPath = join(root, "github-output.txt");
  const summaryPath = join(root, "step-summary.md");
  writeFileSync(outputPath, "");
  writeFileSync(summaryPath, "");

  const eventPath = join(root, "event.json");
  writeFileSync(eventPath, JSON.stringify(eventPayload(scenario), null, 2));

  const github = startFakeGitHub({
    owner: OWNER,
    repo: REPO,
    actor: ACTOR,
    issueNumber: ENTITY_NUMBER,
    issueTitle: "Document the setup steps",
    issueBody: "The README has no setup section.",
    triggerCommentId: TRIGGER_COMMENT_ID,
    triggerCommentBody: TRIGGER_COMMENT,
    triggerCreatedAt: TRIGGER_CREATED_AT,
    earlierCommentBody: EARLIER_COMMENT,
    defaultBranch: "main",
    headSha,
    createdCommentId: CREATED_COMMENT_ID,
    pullRequest,
  });

  return {
    root,
    workspace,
    home,
    runnerTemp,
    outputPath,
    summaryPath,
    capturePath: join(root, "claude-invocation.json"),
    eventPath,
    eventName:
      scenario === "workflow_dispatch" ? "workflow_dispatch" : "issue_comment",
    fakeClaude,
    github,
  };
}

// GITHUB_OUTPUT uses the heredoc format written by @actions/core
// (`name<<delimiter\nvalue\ndelimiter`); older code paths write `name=value`.
function parseGithubOutput(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const lines = readFileSync(path, "utf8").split("\n");
  const outputs: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const heredoc = line.match(/^([^=<]+)<<(.+)$/);
    if (heredoc) {
      const name = heredoc[1]!;
      const delimiter = heredoc[2]!;
      const value: string[] = [];
      i++;
      while (i < lines.length && lines[i] !== delimiter) {
        value.push(lines[i]!);
        i++;
      }
      outputs[name] = value.join("\n");
      continue;
    }
    const simple = line.match(/^([^=]+)=(.*)$/);
    if (simple) outputs[simple[1]!] = simple[2]!;
  }
  return outputs;
}

// The fake GitHub server runs on this process's event loop, so the action must
// be spawned asynchronously: a blocking spawnSync would deadlock on the first
// API call.
async function runAction(
  harness: Harness,
  extraEnv: Record<string, string> = {},
): Promise<RunResult> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: harness.home,
    GIT_CONFIG_NOSYSTEM: "1",
    HTTP_PROXY: TRIPWIRE_PROXY,
    HTTPS_PROXY: TRIPWIRE_PROXY,
    NO_PROXY: "127.0.0.1,localhost",
    GITHUB_ACTION_PATH: ACTION_ROOT,
    GITHUB_WORKSPACE: harness.workspace,
    GITHUB_EVENT_NAME: harness.eventName,
    GITHUB_EVENT_PATH: harness.eventPath,
    GITHUB_ACTOR: ACTOR,
    GITHUB_REPOSITORY: `${OWNER}/${REPO}`,
    GITHUB_RUN_ID: RUN_ID,
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_API_URL: harness.github.baseUrl,
    GITHUB_GRAPHQL_URL: `${harness.github.baseUrl}/graphql`,
    GITHUB_OUTPUT: harness.outputPath,
    GITHUB_STEP_SUMMARY: harness.summaryPath,
    RUNNER_TEMP: harness.runnerTemp,
    OVERRIDE_GITHUB_TOKEN: TOKEN,
    ANTHROPIC_API_KEY: "sk-ant-e2e-placeholder",
    PATH_TO_CLAUDE_CODE_EXECUTABLE: harness.fakeClaude,
    INPUT_PATH_TO_CLAUDE_CODE_EXECUTABLE: harness.fakeClaude,
    INPUT_PROMPT_FILE: join(
      harness.runnerTemp,
      "claude-prompts",
      "claude-prompt.txt",
    ),
    TRIGGER_PHRASE: "@claude",
    LABEL_TRIGGER: "claude",
    BRANCH_PREFIX: "claude/",
    BOT_ID: "41898282",
    BOT_NAME: "claude[bot]",
    USE_STICKY_COMMENT: "false",
    CLASSIFY_INLINE_COMMENTS: "true",
    USE_COMMIT_SIGNING: "false",
    TRACK_PROGRESS: "false",
    INCLUDE_FIX_LINKS: "true",
    DISPLAY_REPORT: "true",
    ALL_INPUTS: JSON.stringify({ trigger_phrase: "@claude", prompt: "" }),
    E2E_CLAUDE_OUTCOME: "success",
    E2E_CAPTURE_FILE: harness.capturePath,
    ...extraEnv,
  };

  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      "--no-env-file",
      `--preload=${PRELOAD}`,
      "run",
      join(ACTION_ROOT, "src", "entrypoints", "run.ts"),
    ],
    cwd: harness.workspace,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const killTimer = setTimeout(() => proc.kill("SIGKILL"), KILL_AFTER_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(killTimer);

  if (process.env.E2E_DEBUG) {
    console.log(`--- action stdout (exit ${exitCode}) ---\n${stdout}`);
    console.log(`--- action stderr ---\n${stderr}`);
  }

  const patches = harness.github.requests.filter(
    (request) => request.method === "PATCH" && request.path === COMMENT_PATH,
  );
  const lastPatch = patches[patches.length - 1];
  const finalCommentBody = String(
    (lastPatch?.body as { body?: string } | undefined)?.body ?? "",
  );

  return {
    exitCode,
    stdout,
    stderr,
    outputs: parseGithubOutput(harness.outputPath),
    summary: existsSync(harness.summaryPath)
      ? readFileSync(harness.summaryPath, "utf8")
      : "",
    finalCommentBody,
    capture: existsSync(harness.capturePath)
      ? (JSON.parse(
          readFileSync(harness.capturePath, "utf8"),
        ) as CapturedInvocation)
      : undefined,
  };
}

describe("run.ts orchestrator end-to-end", () => {
  let harness: Harness | undefined;

  afterEach(() => {
    harness?.github.stop();
    if (harness) rmSync(harness.root, { recursive: true, force: true });
    harness = undefined;
  });

  test(
    "@claude on an issue (success): tracking comment, prompt, branch, outputs and step summary",
    async () => {
      harness = createHarness("issue");
      const result = await runAction(harness);

      expect(result.stdout).not.toContain("::error::");
      expect(result.exitCode).toBe(0);

      // The tracking comment was created first and finalized last.
      const created = harness.github.requests.find(
        (request) =>
          request.method === "POST" &&
          request.path ===
            `/repos/${OWNER}/${REPO}/issues/${ENTITY_NUMBER}/comments`,
      );
      expect(String((created?.body as { body?: string })?.body)).toContain(
        "Claude Code is working",
      );
      expect(
        result.finalCommentBody.startsWith("**Claude finished @octocat's task"),
      ).toBe(true);
      expect(result.finalCommentBody).toContain(
        `[View job](https://github.com/${OWNER}/${REPO}/actions/runs/${RUN_ID})`,
      );
      expect(result.finalCommentBody).toContain("in 1m 1s");

      // The model saw the real generated prompt for this event.
      expect(result.capture).toBeDefined();
      const prompt = result.capture!.prompt;
      expect(prompt).toContain("<trigger_comment>");
      expect(prompt).toContain(TRIGGER_COMMENT);
      expect(prompt).toContain(EARLIER_COMMENT);
      expect(prompt).toContain("<event_type>GENERAL_COMMENT</event_type>");
      expect(prompt).toContain("<is_pr>false</is_pr>");
      expect(prompt).toContain(
        `<claude_comment_id>${CREATED_COMMENT_ID}</claude_comment_id>`,
      );
      expect(result.capture!.claudeArgs).toContain(
        "--permission-mode acceptEdits",
      );
      expect(result.capture!.claudeArgs).toContain(
        "mcp__github_comment__update_claude_comment",
      );
      expect(result.capture!.pathToClaudeCodeExecutable).toBe(
        harness.fakeClaude,
      );

      // A working branch for the issue was created locally and reported.
      expect(result.outputs.conclusion).toBe("success");
      expect(result.outputs.github_token).toBe(TOKEN);
      expect(result.outputs.session_id).toBe(E2E_SESSION_ID);
      expect(result.outputs.branch_name ?? "").toMatch(
        /^claude\/issue-42-\d{8}-\d{4}$/,
      );
      expect(result.outputs.execution_file).toBe(
        join(harness.runnerTemp, "claude-execution-output.json"),
      );
      expect(
        git(
          harness.workspace,
          harness.home,
          "rev-parse",
          "--abbrev-ref",
          "HEAD",
        ),
      ).toBe(result.outputs.branch_name ?? "");

      // Settings were written into the isolated HOME, not the host's.
      const settings = JSON.parse(
        readFileSync(join(harness.home, ".claude", "settings.json"), "utf8"),
      );
      expect(settings.enableAllProjectMcpServers).toBe(true);

      expect(result.summary).toContain("## Claude Code Report");
      expect(harness.github.unexpected).toEqual([]);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "@claude on an open pull request: PR branch checkout, credential replacement, config restored from base",
    async () => {
      harness = createHarness("pull_request");
      const result = await runAction(harness);

      expect(result.stdout).not.toContain("::error::");
      expect(result.exitCode).toBe(0);
      expect(result.outputs.conclusion).toBe("success");
      // No new branch is created for an open PR: Claude works on the PR branch.
      expect(result.outputs.branch_name ?? "").toBe("");
      expect(
        git(
          harness.workspace,
          harness.home,
          "rev-parse",
          "--abbrev-ref",
          "HEAD",
        ),
      ).toBe(PR_HEAD_BRANCH);
      expect(existsSync(join(harness.workspace, "docs", "SETUP.md"))).toBe(
        true,
      );

      // The actions/checkout credential is gone and the action's own token is
      // the only credential git can use.
      expect(
        tryGit(
          harness.workspace,
          harness.home,
          "config",
          "--local",
          "--get-all",
          "http.https://github.com/.extraheader",
        ),
      ).toBe("");
      // `git remote get-url` applies the insteadOf mapping installed by the
      // harness; read the stored value to see what the action wrote.
      expect(
        git(
          harness.workspace,
          harness.home,
          "config",
          "--local",
          "--get",
          "remote.origin.url",
        ),
      ).toBe(TOKEN_REMOTE_URL);

      // PR-controlled Claude configuration was replaced by the base branch's
      // version before Claude ran, and the PR's version was kept for review.
      expect(
        readFileSync(
          join(harness.workspace, ".claude", "settings.json"),
          "utf8",
        ),
      ).toBe('{"source":"base"}\n');
      expect(
        readFileSync(
          join(harness.workspace, ".claude-pr", ".claude", "settings.json"),
          "utf8",
        ),
      ).toBe('{"source":"pr"}\n');
      // The restore must not be committed back onto the PR author's branch.
      expect(
        git(harness.workspace, harness.home, "status", "--porcelain"),
      ).not.toContain("??");

      // The prompt carries the PR context, including review feedback.
      const prompt = result.capture!.prompt;
      expect(prompt).toContain("<is_pr>true</is_pr>");
      expect(prompt).toContain(`PR Branch: ${PR_HEAD_BRANCH} -> main`);
      expect(prompt).toContain("docs/SETUP.md (ADDED)");
      expect(prompt).toContain("nit: mention the required bun version here");
      expect(prompt).toContain("origin/main");
      expect(prompt).toContain(TRIGGER_COMMENT);

      expect(
        result.finalCommentBody.startsWith("**Claude finished @octocat's task"),
      ).toBe(true);
      expect(harness.github.unexpected).toEqual([]);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "automation prompt on workflow_dispatch without a checkout: agent mode runs, no tracking comment",
    async () => {
      harness = createHarness("workflow_dispatch");
      const prompt =
        "List open issues older than 90 days and summarize them in the job log.";
      const result = await runAction(harness, {
        PROMPT: prompt,
        CLAUDE_ARGS: "--allowedTools Read --max-turns 3",
        ALL_INPUTS: JSON.stringify({ prompt, trigger_phrase: "@claude" }),
      });

      expect(result.stdout).not.toContain("::error::");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Auto-detected mode: agent");
      // The workspace is not a git repository: git identity setup is skipped
      // with a warning instead of failing the run.
      expect(result.stdout).toContain(
        "::warning::Git authentication was not configured because the workspace is not a git repository",
      );

      // Agent mode passes the prompt through verbatim and adds no servers when
      // no GitHub MCP tools were requested.
      expect(result.capture).toBeDefined();
      expect(result.capture!.prompt).toBe(prompt);
      expect(result.capture!.claudeArgs).toBe(
        "--allowedTools Read --max-turns 3",
      );
      expect(result.capture!.claudeArgs).not.toContain("--mcp-config");

      expect(result.outputs.conclusion).toBe("success");
      expect(result.outputs.github_token).toBe(TOKEN);
      expect(result.outputs.session_id).toBe(E2E_SESSION_ID);
      expect(result.outputs.branch_name ?? "").toBe("");

      // No tracking comment exists in agent mode; the only GitHub call is the
      // actor lookup.
      const posts = harness.github.requests.filter(
        (request) => request.method === "POST" && request.path !== "/graphql",
      );
      expect(posts).toEqual([]);
      expect(harness.github.requests.map((request) => request.path)).toEqual([
        `/users/${ACTOR}`,
      ]);
      expect(result.finalCommentBody).toBe("");
      expect(harness.github.unexpected).toEqual([]);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "settings values reach the written settings.json but never the job log",
    async () => {
      harness = createHarness("workflow_dispatch");
      // Synthetic, non-secret markers standing in for custom settings values:
      // an `env` entry already present in the runner's settings file and an
      // inline `settings` input. GitHub Actions masks only registered secrets,
      // so any value the orchestrator printed would land in the job log
      // verbatim; the values must still be preserved in the written file.
      const existingMarker = "SYNTHETIC-EXISTING-SETTINGS-VALUE-7f3a9c";
      const inputMarker = "SYNTHETIC-INPUT-SETTINGS-VALUE-2b8e4d";
      const settingsPath = join(harness.home, ".claude", "settings.json");
      mkdirSync(join(harness.home, ".claude"), { recursive: true });
      writeFileSync(
        settingsPath,
        JSON.stringify({ env: { CUSTOM_TOKEN: existingMarker } }, null, 2),
      );
      const prompt = "Say hello in the job log.";
      const result = await runAction(harness, {
        PROMPT: prompt,
        ALL_INPUTS: JSON.stringify({ prompt, trigger_phrase: "@claude" }),
        INPUT_SETTINGS: JSON.stringify({
          apiKeyHelper: `printf ${inputMarker}`,
        }),
      });

      expect(result.stdout).not.toContain("::error::");
      expect(result.exitCode).toBe(0);

      // Both values were merged into the file the CLI reads.
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      expect(settings.env).toEqual({ CUSTOM_TOKEN: existingMarker });
      expect(settings.apiKeyHelper).toBe(`printf ${inputMarker}`);
      expect(settings.enableAllProjectMcpServers).toBe(true);

      // Neither value appears anywhere in what the job log would show.
      const jobLog = `${result.stdout}\n${result.stderr}`;
      expect(jobLog).not.toContain(existingMarker);
      expect(jobLog).not.toContain(inputMarker);
      expect(harness.github.unexpected).toEqual([]);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "execution failure: error header, failure outputs, session id preserved",
    async () => {
      harness = createHarness("issue");
      const result = await runAction(harness, {
        E2E_CLAUDE_OUTCOME: "failure",
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("::error::Action failed with error:");
      expect(
        result.finalCommentBody.startsWith("**Claude encountered an error"),
      ).toBe(true);
      expect(result.finalCommentBody).toContain("[View job](");

      expect(result.outputs.conclusion).toBe("failure");
      expect(result.outputs.github_token).toBe(TOKEN);
      expect(result.outputs.session_id).toBe(E2E_SESSION_ID);
      expect(result.outputs.execution_file).toBe(
        join(harness.runnerTemp, "claude-execution-output.json"),
      );
      expect(harness.github.unexpected).toEqual([]);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "prepare failure: an invalid branch template still finalizes the tracking comment",
    async () => {
      harness = createHarness("issue");
      const result = await runAction(harness, {
        BRANCH_NAME_TEMPLATE: "{{prefix}}bad:{{entityNumber}}",
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("::error::Action failed with error:");

      // Before the failure contract, the prepare step exited the process and
      // the comment stayed at "Claude Code is working…" forever.
      expect(
        result.finalCommentBody.startsWith("**Claude encountered an error"),
      ).toBe(true);
      expect(result.finalCommentBody).toContain(
        'Invalid branch name: "claude/bad:42"',
      );
      expect(result.finalCommentBody).not.toContain("Claude Code is working");

      expect(result.outputs.conclusion).toBe("failure");
      expect(result.outputs.github_token).toBe(TOKEN);
      expect(result.outputs.branch_name ?? "").toBe("");
      expect(result.capture).toBeUndefined();
      expect(harness.github.unexpected).toEqual([]);
    },
    RUN_TIMEOUT_MS,
  );
});
