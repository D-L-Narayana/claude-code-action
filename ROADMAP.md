# Claude Code GitHub Action Roadmap

This document lists the features we set out to deliver on the way to `v1.0` and what is still open. Items are not necessarily in priority order; struck-through items have shipped.

## Path to 1.0

- ~**Ability to see GitHub Action CI results** - This will enable Claude to look at CI failures and make updates to PRs to fix test failures, lint errors, and the like.~
- **Cross-repo support** - Enable Claude to work across multiple repositories in a single session
- **Ability to modify workflow files** - Let Claude update GitHub Actions workflows and other CI configuration files
- ~**Support for workflow_dispatch and repository_dispatch events** - Dispatch Claude on events triggered via API from other workflows or from other services~ — shipped: `workflow_dispatch`, `repository_dispatch`, `schedule` and `workflow_run` run in agent mode with a `prompt` (see [Custom Automations](./docs/custom-automations.md#supported-github-events))
- ~**Ability to disable commit signing** - Option to turn off GPG signing for environments where it's not required. This will enable Claude to use normal `git` bash commands for committing. This will likely become the default behavior once added.~ — shipped: unsigned `git` commits are the default; `use_commit_signing: true` or `ssh_signing_key` opts back into signed commits (see [Security](./docs/security.md#commit-signing))
- ~**Better code review behavior** - Support inline comments on specific lines, provide higher quality reviews with more actionable feedback~ — shipped: inline comments on specific lines via the `mcp__github_inline_comment__create_inline_comment` tool (see [Solutions](./docs/solutions.md#common-tool-permissions))
- ~**Support triggering @claude from bot users** - Allow automation and bot accounts to invoke Claude~
- **Customizable base prompts** - Full control over Claude's initial context with template variables like `$PR_COMMENTS`, `$PR_FILES`, etc. Users can replace our default prompt entirely while still accessing key contextual data

---

**Note:** The remaining items are subject to change based on user feedback and development priorities.

We welcome feedback on these planned features! If you're interested in contributing to any of these features, please open an issue to discuss implementation details with us. We're also open to suggestions for new features not listed here.
