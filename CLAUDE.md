# CLAUDE.md

## Commands

```bash
bun test                # Run tests
bun run typecheck       # TypeScript type checking
bun run format          # Format with prettier
bun run format:check    # Check formatting
```

Python tests for the `agent-approval-check/` sub-action run with
`uv run --with-requirements agent-approval-check/requirements-dev.txt pytest -q agent-approval-check/tests`.

## What This Is

A GitHub Action that lets Claude respond to `@claude` mentions on issues/PRs (tag mode) or run tasks via `prompt` input (agent mode). Mode is auto-detected: if `prompt` is provided, it's agent mode; if triggered by a comment/issue event with `@claude`, it's tag mode. See `src/modes/detector.ts`.

## How It Runs

Single entrypoint: `src/entrypoints/run.ts` orchestrates everything — prepare (auth, permissions, trigger check, branch/comment creation), install Claude Code CLI (`src/install/claude-code-installer.ts`), execute Claude via `base-action/` functions (imported directly, not subprocess), then cleanup (update tracking comment, write step summary). SSH signing cleanup, posting buffered inline comments and token revocation are separate `always()` steps in `action.yml`.

`base-action/` is also published standalone as `@anthropic-ai/claude-code-base-action`. Don't break its public API. It reads config from `INPUT_`-prefixed env vars (set by `action.yml`), not from action inputs directly.

## Key Concepts

**Auth priority**: `github_token` input (user-provided) > GitHub App OIDC token (default). The `claude_code_oauth_token` and `anthropic_api_key` are for the Claude API, not GitHub. Token setup lives in `src/github/token.ts`.

**Mode lifecycle**: `detectMode()` in `src/modes/detector.ts` picks the mode name ("tag" or "agent"). Trigger checking and prepare dispatch are inlined in `run.ts`: tag mode calls `prepareTagMode()` from `src/modes/tag/`, agent mode calls `prepareAgentMode()` from `src/modes/agent/`. Git credential/identity setup shared by both modes lives in `src/modes/shared/git-auth.ts`.

**Prompt construction**: Tag mode's `prepareTagMode()` builds the prompt by fetching GitHub data (`src/github/data/fetcher.ts`, cursor-paginated), formatting it as markdown (`src/github/data/formatter.ts`), applying the size budget (`src/create-prompt/budget.ts`) and writing it to a temp file via `createPrompt()`. Agent mode writes the user's prompt directly. The prompt includes issue/PR body, comments, diff, and CI status. This is the most important part of the action — it's what Claude sees.

**Failure contract**: library code (anything imported by `run.ts`) never calls `process.exit()` or `core.setFailed()`; it throws — prepare-phase failures as `PrepareError` from `src/utils/prepare-error.ts` with the failing `step`. Only `run.ts`'s `finally` block finalizes the tracking comment, writes the step summary and sets outputs, so an exit anywhere else leaves the comment stuck at "Claude Code is working…". MCP server startup guards and `import.meta.main` runners are the only places allowed to exit.

**Limits**: comment bodies, the step summary, prompt sections and GitHub pagination are bounded; see `docs/limits.md` for every limit, its default and how to observe or override it.

## Things That Will Bite You

- **Strict TypeScript**: `noUnusedLocals` and `noUnusedParameters` are enabled. Typecheck will fail on unused variables.
- **Discriminated unions for GitHub context**: `GitHubContext` is a union type — call `isEntityContext(context)` before accessing entity-specific fields like `context.issue` or `context.pullRequest`.
- **Token lifecycle matters**: The GitHub App token is obtained early and revoked in a separate `always()` step in `action.yml`. If you move token revocation into `run.ts`, it won't run if the process crashes. Same for SSH signing cleanup.
- **Error phase attribution**: The catch block in `run.ts` uses `prepareCompleted` and `PrepareError.step` to distinguish prepare failures from execution failures. The tracking comment shows different messages for each.
- **`action.yml` outputs reference step IDs**: Outputs like `execution_file`, `branch_name`, `github_token` reference `steps.run.outputs.*`. If you rename the step ID, update the outputs section too.
- **Composite-step env shadowing**: the `env:` block of the run step shadows the calling workflow's job-level env. Any env var the orchestrator or the CLI reads (e.g. `CLAUDE_PROMPT_MAX_CHARS`, `MCP_TIMEOUT`) must be forwarded explicitly in `action.yml`.
- **Drift guards**: `test/action-metadata.test.ts`, `test/version-pins.test.ts`, `test/examples-workflows.test.ts` and `test/docs-consistency.test.ts` fail when `action.yml`, `src/`, `docs/` and `examples/` disagree (undeclared input references, undocumented inputs, mismatched version pins, example workflows missing permissions). Fix the source of the drift, not the test.
- **End-to-end harness**: `test/e2e/` spawns the real `run.ts` against an in-process fake GitHub API with only the Claude SDK call substituted (via a Bun preload plugin). It is the regression test for the failure contract and the main `@claude` workflow; run it with `bun test test/e2e`.
- **Integration testing** against live GitHub happens in a separate repo (`install-test`), not here. The other tests in this repo are unit tests.

## Code Conventions

- Runtime is Bun, not Node. Use `bun test`, not `jest`.
- `moduleResolution: "bundler"` — imports don't need `.js` extensions.
- GitHub API calls should use retry logic (`src/utils/retry.ts`).
- MCP servers are auto-installed at runtime to `~/.claude/mcp/github-{type}-server/`.
