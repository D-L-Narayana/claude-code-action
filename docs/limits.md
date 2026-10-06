# Limits and Safeguards

This page lists the size limits, timeouts and failure-handling rules the action applies, how each one shows up in a run, and how to change it where that is possible. Limits imposed by GitHub itself cannot be raised. Every environment variable mentioned here must be set in the calling workflow's job-level (or workflow-level) `env:` block — see [Workflow-Level Environment Variables](./configuration.md#workflow-level-environment-variables) for why.

## Output written to GitHub

| What                                                                                                                            | Default                              | How to observe                                                                                               | How to override                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Comment bodies written by the action (tracking comment, `mcp__github_comment__update_claude_comment`, buffered inline comments) | 65,536 characters (GitHub API limit) | The body ends with a visible `…[truncated N characters]…` marker; the header, links and error block are kept | Not configurable. Ask Claude for shorter summaries, or to put detail into files or commits |
| Step summary (Claude Code Report, `display_report: 'true'`)                                                                     | 1 MiB (GitHub runner limit)          | The report ends with `Report truncated: N bytes omitted to stay within the GitHub step summary limit.`       | Not configurable. `display_report: 'false'` (the default) skips the report entirely        |

## Prompt context (tag mode)

In tag mode the prompt Claude receives is built from the issue or PR body, the comments, the reviews with their diff hunks, and the list of changed files. Each part has a character budget so that very large threads cannot overflow the model context. Content is sanitized before it is cut, and every cut is marked in the prompt text. The instruction part of the prompt (event metadata, the trigger comment and the task instructions) is never truncated.

| Section                                            | Default                                                                       | How to observe                                                                                                                                   |
| -------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Whole prompt                                       | 300,000 characters, minus the length of any custom instructions from `prompt` | If the capped sections together still exceed the total, the context block is cut from its end and ends with `[… truncated N chars of context …]` |
| Issue/PR body                                      | 40,000 characters                                                             | The body ends with `[… truncated N chars of body …]`                                                                                             |
| Each comment, review body or inline review comment | 10,000 characters                                                             | The text ends with `[… truncated N chars of comment …]` (`… of review …` for a review body)                                                      |
| Comments section                                   | 120,000 characters                                                            | The **newest** comments are kept; older ones are replaced by `[… N earlier comments omitted …]`                                                  |
| Reviews section                                    | 120,000 characters                                                            | The **newest** reviews are kept; older ones are replaced by `[… N earlier reviews omitted …]`                                                    |
| Each review diff hunk                              | 2,000 characters                                                              | The hunk ends with `[… truncated N chars of diff hunk …]`                                                                                        |
| Changed-files list                                 | 300 entries                                                                   | `[… N more files …]` after the last listed file                                                                                                  |

To change the budget, set `CLAUDE_PROMPT_MAX_CHARS` in the job-level `env:` block. All section budgets scale proportionally with the total (each character budget keeps a floor of 100 characters and the file list a floor of one entry). A value that is not a positive integer is ignored with a job-log warning and the defaults apply:

```yaml
jobs:
  claude-response:
    runs-on: ubuntu-latest
    env:
      CLAUDE_PROMPT_MAX_CHARS: "600000" # doubles every section budget
    steps:
      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

The generated prompt is written to `$RUNNER_TEMP/claude-prompts/claude-prompt.txt`; upload it as an artifact in a later step if you need to inspect what was cut.

## GitHub data fetching

| What                                                                        | Default                                                | How to observe                                                                                                                | How to override  |
| --------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Pagination of PR/issue comments, reviews, review comments and changed files | 100 items per page, up to 5 pages (500 items) per list | A job-log warning `Stopped fetching <list> after 5 pages (N items); the remaining items are omitted` when a list hits the cap | Not configurable |

Lists are fetched with cursor pagination rather than a single first-100 page, so threads longer than 100 comments are seen in full up to the cap, and the newest comments are never dropped in favour of older ones.

## Installation and timeouts

| What                         | Default                                    | How to observe                                                                                                                                | How to override                                     |
| ---------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Claude Code CLI installation | 3 attempts, 120-second timeout per attempt | Retry and timeout messages in the job log; after the third failed attempt the run fails with `Failed to install Claude Code after 3 attempts` | `path_to_claude_code_executable` skips installation |

The Claude session itself has no timeout of its own; bound it with the job's `timeout-minutes` and, if needed, `--max-turns` in `claude_args`.

## Inline comment buffering

When `classify_inline_comments` is enabled (the default), inline comments created without `confirmed: true` are buffered during the session and classified afterwards by a separate post-step:

| What             | Behavior                                                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Buffer location  | `$RUNNER_TEMP/claude-inline-comments/<owner>__<repo>__pr<N>__run<RUN_ID>.jsonl` — one file per repository, pull request and workflow run                                                     |
| Lifecycle        | The post-step reads only the current run's buffer and deletes it after processing, so stale entries on non-ephemeral (self-hosted) runners cannot be replayed into another PR or a later run |
| Malformed lines  | Skipped with a job-log warning `Skipped N malformed line(s) in the inline comment buffer`; the remaining entries are still processed                                                         |
| Classifier model | `claude-haiku-4-5` by default; set `CLAUDE_INLINE_CLASSIFIER_MODEL` in the job-level `env:` block to use a different model                                                                   |
| Disable          | `classify_inline_comments: 'false'` posts every inline comment immediately and skips the buffer                                                                                              |

## Failure handling

- Preparation failures — branch creation, MCP server configuration, prompt generation — finalize the tracking comment with an error header and the (redacted) error message instead of leaving it at "Claude Code is working…". The `github_token` output is still set, so the token-revocation step runs.
- Execution failures (Claude Code itself failing) also finalize the tracking comment with an error header; the job log shows which phase failed.
- A `--mcp-config` value in `claude_args` that names a missing or unparseable file fails the run before Claude starts with an error naming the file (`--mcp-config file '<path>' could not be read or parsed: …`); inline JSON that does not parse fails the same way whenever it is merged with other configs (always in tag mode). Previously a file path was silently discarded whenever inline configs were also present.
- Agent mode: a failure while configuring git credentials is fatal, except "not a git repository", which is logged as a warning so that automation workflows without an `actions/checkout` step keep working.
- Claude Code CLI installation failing three times fails the run (see above).

## Trust-boundary safeguards

- `allowed_non_write_users` matches usernames case-insensitively.
- Untrusted content is sanitized before it reaches the prompt: HTML comments, invisible and bidirectional control characters, Unicode TAG characters, word joiners and variation selectors, markdown image alt text, hidden HTML attributes and HTML entities are stripped. See the prompt injection section in [Security](./security.md).
- Text the action posts (comments, step summary, error messages) is scanned for credentials: GitHub tokens, Anthropic API keys and OAuth tokens, AWS access key IDs, Slack tokens, JWTs, Google API keys, GitLab personal access tokens, npm tokens and credentials embedded in URLs are replaced with `[REDACTED_…]` placeholders. Redaction is best-effort — do not rely on it instead of keeping secrets away from Claude. See [Secret Redaction](./security.md#secret-redaction).

## Removed inputs

`mode`, `direct_prompt`, `override_prompt`, `custom_instructions`, `max_turns`, `model`, `fallback_model`, `allowed_tools`, `disallowed_tools`, `mcp_config` and `claude_env` are no longer declared by `action.yml` and are ignored. See [Usage](./usage.md#deprecated-inputs) for the replacements.
