# Contributing to Claude Code Action

Thank you for your interest in contributing to Claude Code Action! This document provides guidelines and instructions for contributing to the project.

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) runtime (the version pinned in `action.yml`)
- [uv](https://docs.astral.sh/uv/) (only for the Python tests of `agent-approval-check/`)
- [Docker](https://www.docker.com/) (for running GitHub Actions locally)
- [act](https://github.com/nektos/act) (installed automatically by our test script)
- An Anthropic API key (for testing)

### Setup

1. Fork the repository on GitHub and clone your fork:

   ```bash
   git clone https://github.com/your-username/claude-code-action.git
   cd claude-code-action
   ```

2. Install dependencies exactly as locked:

   ```bash
   bun install --frozen-lockfile
   ```

   Do not commit changes to `bun.lock` unless you intentionally changed a dependency.

3. Set up your Anthropic API key:
   ```bash
   export ANTHROPIC_API_KEY="your-api-key-here"
   ```

## Development

### Available Scripts

- `bun test` - Run all tests
- `bun test test/<file>.test.ts` - Run a single test file (fast; use this while iterating)
- `bun run typecheck` - Type check the code (strict: unused locals and parameters fail the check)
- `bun run format` - Format code with Prettier
- `bun run format:check` - Check code formatting

## Testing

### Running Tests Locally

1. **Unit tests** (TypeScript, Bun):

   ```bash
   bun test                                  # everything
   bun test test/sanitizer.test.ts           # a single file
   bun test base-action/test/readme.test.ts  # base-action tests live in base-action/test
   ```

2. **Python tests** for the `agent-approval-check` action:

   ```bash
   uv run --with-requirements agent-approval-check/requirements-dev.txt pytest -q agent-approval-check/tests
   ```

### Drift Tests

Some test files exist only to keep `action.yml`, the source, the docs and the example workflows consistent with each other. If you change an input, an output, a pinned version, a documentation table or an example workflow, expect one of these to fail until the other side is updated too:

- `test/action-metadata.test.ts` - `action.yml` inputs and outputs match the code (`src/entrypoints/run.ts`) and the input reference in `docs/usage.md`
- `test/version-pins.test.ts` - pinned versions (Claude Code, Bun, input defaults) are the same everywhere they appear
- `test/examples-workflows.test.ts` - example workflows in `examples/` and `base-action/examples/` follow the checkout version and permissions rules
- `test/docs-consistency.test.ts` - the docs do not use removed inputs in workflow examples and the FAQ lists every built-in MCP server
- `base-action/test/readme.test.ts` - the input table in `base-action/README.md` matches `base-action/action.yml`

## Pull Request Process

1. Create a new branch from `main`:

   ```bash
   git checkout -b feature/your-feature-name
   ```

2. Make your changes and commit them:

   ```bash
   git add .
   git commit -m "feat: add new feature"
   ```

3. Run tests and formatting:

   ```bash
   bun test
   bun run typecheck
   bun run format:check
   ```

4. Push your branch and create a Pull Request:

   ```bash
   git push origin feature/your-feature-name
   ```

5. Ensure all CI checks pass

6. Request review from maintainers

## Action Development

### Testing Your Changes

When modifying the action:

1. Test in a real GitHub Actions workflow by:
   - Creating a test repository
   - Using your branch as the action source:
     ```yaml
     uses: your-username/claude-code-action@your-branch
     ```

### Debugging

- Use `console.log` for debugging in development
- Check GitHub Actions logs for runtime issues
- Use `act` with `-v` flag for verbose output:
  ```bash
  act push -v --secret ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"
  ```

## Common Issues

### Docker Issues

Make sure Docker is running before using `act`. You can check with:

```bash
docker ps
```
