/**
 * Every input declared under `inputs:` in action.yml, in declaration order,
 * mapped to its `default:` value ("" for inputs that declare none).
 *
 * The presence telemetry below is computed against this table, so it must
 * mirror action.yml exactly: a stale row either keeps reporting an input that
 * no longer exists or never reports one that does. A drift test compares this
 * table with action.yml.
 */
export const ACTION_INPUT_DEFAULTS: Readonly<Record<string, string>> =
  Object.freeze({
    trigger_phrase: "@claude",
    assignee_trigger: "",
    label_trigger: "claude",
    base_branch: "",
    branch_prefix: "claude/",
    branch_name_template: "",
    allowed_bots: "",
    allowed_non_write_users: "",
    include_comments_by_actor: "",
    exclude_comments_by_actor: "",
    prompt: "",
    settings: "",
    anthropic_api_key: "",
    claude_code_oauth_token: "",
    anthropic_federation_rule_id: "",
    anthropic_organization_id: "",
    anthropic_service_account_id: "",
    anthropic_workspace_id: "",
    anthropic_oidc_audience: "",
    github_token: "",
    use_bedrock: "false",
    use_vertex: "false",
    use_foundry: "false",
    claude_args: "",
    additional_permissions: "",
    use_sticky_comment: "false",
    classify_inline_comments: "true",
    use_commit_signing: "false",
    ssh_signing_key: "",
    bot_id: "41898282",
    bot_name: "claude[bot]",
    track_progress: "false",
    include_fix_links: "true",
    path_to_claude_code_executable: "",
    path_to_bun_executable: "",
    display_report: "false",
    show_full_output: "false",
    plugins: "",
    plugin_marketplaces: "",
  });

/**
 * Report which action inputs the workflow set explicitly, as a JSON object of
 * booleans keyed by input name (exposed to Claude Code as GITHUB_ACTION_INPUTS).
 *
 * `allInputsJson` is `toJson(inputs)` from action.yml: every declared input
 * with the caller's value or the default applied. An input counts as present
 * when its value differs from the action.yml default; a key that is missing
 * from the payload carries its default and is therefore not present. Only
 * booleans are emitted so that no input value (API keys, prompts) leaks.
 */
export function collectActionInputsPresence(
  allInputsJson: string | undefined = process.env.ALL_INPUTS,
): string {
  if (!allInputsJson) {
    console.log("ALL_INPUTS environment variable not found");
    return "{}";
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(allInputsJson);
  } catch (e) {
    console.error("Failed to parse ALL_INPUTS JSON:", e);
    return "{}";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.error("ALL_INPUTS is not a JSON object; ignoring it");
    return "{}";
  }
  const allInputs = parsed as Record<string, unknown>;

  const presentInputs: Record<string, boolean> = {};
  for (const [name, defaultValue] of Object.entries(ACTION_INPUT_DEFAULTS)) {
    const actualValue = allInputs[name];
    presentInputs[name] =
      actualValue !== undefined &&
      actualValue !== null &&
      String(actualValue) !== defaultValue;
  }

  return JSON.stringify(presentInputs);
}
