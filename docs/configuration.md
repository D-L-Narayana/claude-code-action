# Advanced Configuration

## Using Custom MCP Configuration

You can add custom MCP (Model Context Protocol) servers to extend Claude's capabilities using the `--mcp-config` flag in `claude_args`. These servers merge with the built-in GitHub MCP servers.

### Basic Example: Adding a Sequential Thinking Server

```yaml
- uses: anthropics/claude-code-action@v1
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    claude_args: |
      --mcp-config '{"mcpServers": {"sequential-thinking": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"]}}}'
      --allowedTools mcp__sequential-thinking__sequentialthinking
    # ... other inputs
```

### Passing Secrets to MCP Servers

For MCP servers that require sensitive information like API keys or tokens, you can create a configuration file with GitHub Secrets. The file is read at startup and merged with the action's built-in servers (see the notes below), so the secrets never have to appear in `claude_args`:

```yaml
- name: Create MCP Config
  run: |
    cat > /tmp/mcp-config.json << 'EOF'
    {
      "mcpServers": {
        "custom-api-server": {
          "command": "npx",
          "args": ["-y", "@example/api-server"],
          "env": {
            "API_KEY": "${{ secrets.CUSTOM_API_KEY }}",
            "BASE_URL": "https://api.example.com"
          }
        }
      }
    }
    EOF

- uses: anthropics/claude-code-action@v1
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    claude_args: |
      --mcp-config /tmp/mcp-config.json
    # ... other inputs
```

### Using Python MCP Servers with uv

For Python-based MCP servers managed with `uv`, you need to specify the directory containing your server:

```yaml
- name: Create MCP Config for Python Server
  run: |
    cat > /tmp/mcp-config.json << 'EOF'
    {
      "mcpServers": {
        "my-python-server": {
          "type": "stdio",
          "command": "uv",
          "args": [
            "--directory",
            "${{ github.workspace }}/path/to/server/",
            "run",
            "server_file.py"
          ]
        }
      }
    }
    EOF

- uses: anthropics/claude-code-action@v1
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    claude_args: |
      --mcp-config /tmp/mcp-config.json
      --allowedTools my-python-server__<tool_name>  # Replace <tool_name> with your server's tool names
    # ... other inputs
```

For example, if your Python MCP server is at `mcp_servers/weather.py`, you would use:

```yaml
"args":
  ["--directory", "${{ github.workspace }}/mcp_servers/", "run", "weather.py"]
```

### Multiple MCP Servers

You can add multiple MCP servers by using multiple `--mcp-config` flags:

```yaml
- uses: anthropics/claude-code-action@v1
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    claude_args: |
      --mcp-config /tmp/config1.json
      --mcp-config /tmp/config2.json
      --mcp-config '{"mcpServers": {"inline-server": {"command": "npx", "args": ["@example/server"]}}}'
    # ... other inputs
```

**Important**:

- Always use GitHub Secrets (`${{ secrets.SECRET_NAME }}`) for sensitive values like API keys, tokens, or passwords. Never hardcode secrets directly in the workflow file.
- `--mcp-config` accepts either inline JSON or a path to a JSON file, and may be repeated. Every value — files included — is read and merged with the built-in GitHub server configs before Claude starts.
- Later values win on name collisions, so a custom server with the same name as a built-in one (`github_comment`, `github_file_ops`, `github_inline_comment`, `github_ci`, `github`) replaces it.
- A file that cannot be read or does not contain valid JSON fails the run with a clear error instead of being silently ignored; the same applies to an inline value that is not valid JSON whenever it is merged with other configs (always in tag mode).

## Prompt Size Budget

In tag mode the action builds Claude's prompt from the issue or PR body, the comments, the reviews with their diff hunks, and the list of changed files. Each part has a character budget so that very large threads cannot overflow the model context; the newest comments are kept when the comments section is over budget, every cut is marked in the prompt text, and the instruction part of the prompt is never truncated. The defaults are listed in [Limits and Safeguards](./limits.md#prompt-context-tag-mode).

To change the budget, set `CLAUDE_PROMPT_MAX_CHARS` in the calling workflow's job-level `env:` block (see [Workflow-Level Environment Variables](#workflow-level-environment-variables) for why it cannot go under `with:`). All section budgets scale proportionally with the total:

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

## Workflow-Level Environment Variables

A few behaviors are tuned through environment variables rather than inputs. This is a composite action: each internal step has its own `env:` block, which shadows the environment of the calling workflow, so the action forwards every variable it reads explicitly from the `env` context. For that forwarding to see your value, set it in the calling workflow's **job-level** (or workflow-level) `env:` block, or export it from an earlier step via `$GITHUB_ENV`. Values placed under the action step's `with:` are not inputs and are ignored.

| Variable                                                      | Effect                                                                                                                                                                                                   |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE_PROMPT_MAX_CHARS`                                     | Total character budget for the tag-mode prompt context; every section budget scales with it. Defaults in [Limits](./limits.md#prompt-context-tag-mode)                                                   |
| `USE_SIMPLE_PROMPT`                                           | `"true"` switches tag mode to a shorter prompt variant with the same GitHub context but condensed instructions. Experimental — see [Experimental Features](./experimental.md#simplified-tag-mode-prompt) |
| `CLAUDE_INLINE_CLASSIFIER_MODEL`                              | Model used by the post-step that classifies buffered inline comments as real review vs. test/probe (default `claude-haiku-4-5`). See [Security](./security.md#inline-comment-buffering)                  |
| `MCP_TIMEOUT`, `MCP_TOOL_TIMEOUT`, `MAX_MCP_OUTPUT_TOKENS`    | Forwarded unchanged to the Claude Code CLI (MCP server startup timeout, tool call timeout, and maximum MCP tool output size, per the Claude Code documentation)                                          |
| `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`, `CLAUDE_CODE_SCRIPT_CAPS` | Subprocess isolation controls used together with `allowed_non_write_users`. See [Security](./security.md#access-control)                                                                                 |

```yaml
jobs:
  claude-response:
    runs-on: ubuntu-latest
    env:
      CLAUDE_PROMPT_MAX_CHARS: "600000"
      CLAUDE_INLINE_CLASSIFIER_MODEL: "claude-sonnet-4-5"
      MCP_TIMEOUT: "30000"
    steps:
      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

## Additional Permissions for CI/CD Integration

The `additional_permissions` input allows Claude to access GitHub Actions workflow information when you grant the necessary permissions. This is particularly useful for analyzing CI/CD failures and debugging workflow issues.

### Enabling GitHub Actions Access

To allow Claude to view workflow run results, job logs, and CI status:

1. **Grant the necessary permission to your GitHub token**:

   - When using the default `GITHUB_TOKEN`, add the `actions: read` permission to your workflow:

   ```yaml
   permissions:
     contents: write
     pull-requests: write
     issues: write
     actions: read # Add this line
   ```

2. **Configure the action with additional permissions**:

   ```yaml
   - uses: anthropics/claude-code-action@v1
     with:
       anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
       additional_permissions: |
         actions: read
       # ... other inputs
   ```

3. **Claude will automatically get access to CI/CD tools**:
   When you enable `actions: read`, Claude can use the following MCP tools:
   - `mcp__github_ci__get_ci_status` - View workflow run statuses
   - `mcp__github_ci__get_workflow_run_details` - Get detailed workflow information
   - `mcp__github_ci__download_job_log` - Download and analyze job logs

### Example: Debugging Failed CI Runs

```yaml
name: Claude CI Helper
on:
  issue_comment:
    types: [created]

permissions:
  contents: write
  pull-requests: write
  issues: write
  actions: read # Required for CI access

jobs:
  claude-ci-helper:
    runs-on: ubuntu-latest
    steps:
      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          additional_permissions: |
            actions: read
          # Now Claude can respond to "@claude why did the CI fail?"
```

**Important Notes**:

- The GitHub token must have the corresponding permission in your workflow
- If the permission is missing, Claude will warn you and suggest adding it
- The following additional permissions can be requested beyond the defaults:
  - `actions: read`
  - `checks: read`
  - `discussions: read` or `discussions: write`
  - `workflows: read` or `workflows: write`
- Standard permissions (`contents: write`, `pull_requests: write`, `issues: write`) are always included and do not need to be specified

## Custom Environment Variables

You can pass custom environment variables to Claude Code execution using the `settings` input. This is useful for CI/test setups that require specific environment variables:

```yaml
- uses: anthropics/claude-code-action@v1
  with:
    settings: |
      {
        "env": {
          "NODE_ENV": "test",
          "CI": "true",
          "DATABASE_URL": "postgres://test:test@localhost:5432/test_db"
        }
      }
    # ... other inputs
```

These environment variables will be available to Claude Code during execution, allowing it to run tests, build processes, or other commands that depend on specific environment configurations.

## Limiting Conversation Turns

You can limit the number of back-and-forth exchanges Claude can have during task execution using the `claude_args` input. This is useful for:

- Controlling costs by preventing runaway conversations
- Setting time boundaries for automated workflows
- Ensuring predictable behavior in CI/CD pipelines

```yaml
- uses: anthropics/claude-code-action@v1
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    claude_args: |
      --max-turns 5  # Limit to 5 conversation turns
    # ... other inputs
```

When the turn limit is reached, Claude will stop execution gracefully. Choose a value that gives Claude enough turns to complete typical tasks while preventing excessive usage.

## Custom Tools

By default, Claude only has access to:

- File operations (reading, committing, editing files, read-only git commands)
- Comment management (creating/updating comments)
- Basic GitHub operations

Claude does **not** have access to execute arbitrary Bash commands by default. If you want Claude to run specific commands (e.g., npm install, npm test), you must explicitly allow them using the `claude_args` configuration:

**Note**: If your repository has a `.mcp.json` file in the root directory, Claude will automatically detect and use the MCP server tools defined there. However, these tools still need to be explicitly allowed.

```yaml
- uses: anthropics/claude-code-action@v1
  with:
    claude_args: |
      --allowedTools "Bash(npm install),Bash(npm run test),Edit,Replace,NotebookEditCell"
      --disallowedTools "TaskOutput,KillTask"
    # ... other inputs
```

**Note**: The base GitHub tools are always included. Use `--allowedTools` to add additional tools (including specific Bash commands), and `--disallowedTools` to prevent specific tools from being used.

## Custom Model

Specify a Claude model using `claude_args`:

```yaml
- uses: anthropics/claude-code-action@v1
  with:
    claude_args: |
      --model claude-4-0-sonnet-20250805
    # ... other inputs
```

For provider-specific models:

```yaml
# AWS Bedrock
- uses: anthropics/claude-code-action@v1
  with:
    use_bedrock: "true"
    claude_args: |
      --model anthropic.claude-4-0-sonnet-20250805-v1:0
    # ... other inputs

# Google Vertex AI
- uses: anthropics/claude-code-action@v1
  with:
    use_vertex: "true"
    claude_args: |
      --model claude-4-0-sonnet@20250805
    # ... other inputs

# Microsoft Foundry
- uses: anthropics/claude-code-action@v1
  with:
    use_foundry: "true"
    claude_args: |
      --model claude-sonnet-4-5
    # ... other inputs
  env:
    ANTHROPIC_FOUNDRY_BASE_URL: https://my-resource.services.ai.azure.com
```

See [Cloud Providers](./cloud-providers.md) for the authentication steps each provider needs.

### 1M context models through an API gateway

When `ANTHROPIC_BASE_URL` points to an Anthropic-compatible API gateway,
Claude Code may not be able to verify that the gateway supports a model's native
1M context window and can budget the session at 200K instead. Append the
`[1m]` selector to explicitly use the 1M context window for supported models,
including Claude Opus 5 and Claude Sonnet 5:

```yaml
- uses: anthropics/claude-code-action@v1
  with:
    claude_args: |
      --model "claude-opus-5[1m]"
    # ... other inputs
```

Use the same selector when setting a model through `ANTHROPIC_MODEL` or another
Claude Code model environment variable. The selector is resolved by Claude Code
before requests are sent to the provider. The action's sanitized result output
includes each model's resolved
`contextWindow` and `maxOutputTokens` under `modelUsage`, so these limits are
visible without enabling `show_full_output`.

## Claude Code Settings

You can provide Claude Code settings to customize behavior such as model selection, environment variables, permissions, and hooks. Settings can be provided either as a JSON string or a path to a settings file.

### Option 1: Settings File

```yaml
- uses: anthropics/claude-code-action@v1
  with:
    settings: "path/to/settings.json"
    # ... other inputs
```

### Option 2: Inline Settings

```yaml
- uses: anthropics/claude-code-action@v1
  with:
    settings: |
      {
        "model": "claude-opus-4-1-20250805",
        "env": {
          "DEBUG": "true",
          "API_URL": "https://api.example.com"
        },
        "permissions": {
          "allow": ["Bash", "Read"],
          "deny": ["WebFetch"]
        },
        "hooks": {
          "PreToolUse": [{
            "matcher": "Bash",
            "hooks": [{
              "type": "command",
              "command": "echo Running bash command..."
            }]
          }]
        }
      }
    # ... other inputs
```

The settings support all Claude Code settings options including:

- `model`: Override the default model
- `env`: Environment variables for the session
- `permissions`: Tool usage permissions
- `hooks`: Pre/post tool execution hooks
- And more...

For a complete list of available settings and their descriptions, see the [Claude Code settings documentation](https://docs.anthropic.com/en/docs/claude-code/settings).

**Notes**:

- The `enableAllProjectMcpServers` setting is always set to `true` by this action to ensure MCP servers work correctly.
- The `claude_args` input provides direct access to Claude Code CLI arguments and takes precedence over settings.
- We recommend using `claude_args` for simple configurations and `settings` for complex configurations with hooks and environment variables.

## Migration from Deprecated Inputs

Many individual input parameters have been consolidated into `claude_args` or `settings`. Here's how to migrate:

| Old Input             | New Approach                                                    |
| --------------------- | --------------------------------------------------------------- |
| `allowed_tools`       | Use `claude_args: "--allowedTools Tool1,Tool2"`                 |
| `disallowed_tools`    | Use `claude_args: "--disallowedTools Tool1,Tool2"`              |
| `max_turns`           | Use `claude_args: "--max-turns 10"`                             |
| `model`               | Use `claude_args: "--model claude-4-0-sonnet-20250805"`         |
| `claude_env`          | Use `settings` with `"env"` object                              |
| `custom_instructions` | Use `claude_args: "--append-system-prompt 'Your instructions'"` |
| `mcp_config`          | Use `claude_args: "--mcp-config '{...}'"`                       |
| `direct_prompt`       | Use `prompt` input instead                                      |
| `override_prompt`     | Use `prompt` with GitHub context variables                      |

## Custom Executables for Specialized Environments

For specialized environments like Nix, custom container setups, or other package management systems where the default installation doesn't work, you can provide your own executables:

### Custom Claude Code Executable

Use `path_to_claude_code_executable` to provide your own Claude Code binary instead of using the automatically installed version:

```yaml
- uses: anthropics/claude-code-action@v1
  with:
    path_to_claude_code_executable: "/path/to/custom/claude"
    # ... other inputs
```

### Custom Bun Executable

Use `path_to_bun_executable` to provide your own Bun runtime instead of the default installation:

```yaml
- uses: anthropics/claude-code-action@v1
  with:
    path_to_bun_executable: "/path/to/custom/bun"
    # ... other inputs
```

**Important**: Using incompatible versions may cause the action to fail. Ensure your custom executables are compatible with the action's requirements.
