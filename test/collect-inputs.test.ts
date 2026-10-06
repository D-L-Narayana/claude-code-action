import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import {
  ACTION_INPUT_DEFAULTS,
  collectActionInputsPresence,
} from "../src/entrypoints/collect-inputs";

// The 39 inputs declared under `inputs:` in action.yml, in declaration order,
// with their `default:` values (inputs without a `default:` are ""). The
// presence telemetry (GITHUB_ACTION_INPUTS) is derived from this table, so it
// has to mirror action.yml exactly: a stale row either reports an input that
// no longer exists or never reports one that does.
const EXPECTED_DEFAULTS: Array<[string, string]> = [
  ["trigger_phrase", "@claude"],
  ["assignee_trigger", ""],
  ["label_trigger", "claude"],
  ["base_branch", ""],
  ["branch_prefix", "claude/"],
  ["branch_name_template", ""],
  ["allowed_bots", ""],
  ["allowed_non_write_users", ""],
  ["include_comments_by_actor", ""],
  ["exclude_comments_by_actor", ""],
  ["prompt", ""],
  ["settings", ""],
  ["anthropic_api_key", ""],
  ["claude_code_oauth_token", ""],
  ["anthropic_federation_rule_id", ""],
  ["anthropic_organization_id", ""],
  ["anthropic_service_account_id", ""],
  ["anthropic_workspace_id", ""],
  ["anthropic_oidc_audience", ""],
  ["github_token", ""],
  ["use_bedrock", "false"],
  ["use_vertex", "false"],
  ["use_foundry", "false"],
  ["claude_args", ""],
  ["additional_permissions", ""],
  ["use_sticky_comment", "false"],
  ["classify_inline_comments", "true"],
  ["use_commit_signing", "false"],
  ["ssh_signing_key", ""],
  ["bot_id", "41898282"],
  ["bot_name", "claude[bot]"],
  ["track_progress", "false"],
  ["include_fix_links", "true"],
  ["path_to_claude_code_executable", ""],
  ["path_to_bun_executable", ""],
  ["display_report", "false"],
  ["show_full_output", "false"],
  ["plugins", ""],
  ["plugin_marketplaces", ""],
];

// Inputs that existed in earlier versions of action.yml and were removed.
const REMOVED_INPUTS = [
  "mode",
  "model",
  "anthropic_model",
  "fallback_model",
  "allowed_tools",
  "disallowed_tools",
  "custom_instructions",
  "direct_prompt",
  "override_prompt",
  "claude_env",
  "max_turns",
];

describe("ACTION_INPUT_DEFAULTS", () => {
  test("lists exactly the 39 action.yml inputs, in declaration order, with their defaults", () => {
    expect(Object.keys(ACTION_INPUT_DEFAULTS)).toHaveLength(39);
    expect(Object.entries(ACTION_INPUT_DEFAULTS)).toEqual(EXPECTED_DEFAULTS);
  });

  test("does not carry inputs that were removed from action.yml", () => {
    for (const name of REMOVED_INPUTS) {
      expect(ACTION_INPUT_DEFAULTS).not.toHaveProperty(name);
    }
  });

  test("is frozen so the contract cannot drift at runtime", () => {
    expect(Object.isFrozen(ACTION_INPUT_DEFAULTS)).toBe(true);
  });
});

describe("collectActionInputsPresence", () => {
  const originalAllInputs = process.env.ALL_INPUTS;
  let consoleLogSpy: Mock<typeof console.log>;
  let consoleErrorSpy: Mock<typeof console.error>;

  beforeEach(() => {
    delete process.env.ALL_INPUTS;
    consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    if (originalAllInputs === undefined) {
      delete process.env.ALL_INPUTS;
    } else {
      process.env.ALL_INPUTS = originalAllInputs;
    }
  });

  test("reports every declared input and ignores undeclared keys such as the removed `mode`", () => {
    const presence = JSON.parse(
      collectActionInputsPresence('{"mode":"","prompt":"do it"}'),
    );

    expect(presence).not.toHaveProperty("mode");
    expect(presence.prompt).toBe(true);
    expect(presence.claude_args).toBe(false);
    expect(Object.keys(presence)).toHaveLength(39);
    expect(Object.keys(presence)).toEqual(Object.keys(ACTION_INPUT_DEFAULTS));
  });

  test("an input is present only when its value differs from the action.yml default", () => {
    const presence = JSON.parse(
      collectActionInputsPresence(
        JSON.stringify({
          trigger_phrase: "@claude", // equals default
          label_trigger: "needs-claude", // differs
          use_bedrock: "true", // differs
          bot_id: "41898282", // equals default
          classify_inline_comments: "false", // differs
          ssh_signing_key: "-----BEGIN OPENSSH PRIVATE KEY-----", // differs
        }),
      ),
    );

    expect(presence.trigger_phrase).toBe(false);
    expect(presence.label_trigger).toBe(true);
    expect(presence.use_bedrock).toBe(true);
    expect(presence.bot_id).toBe(false);
    expect(presence.classify_inline_comments).toBe(true);
    expect(presence.ssh_signing_key).toBe(true);
    // Keys missing from ALL_INPUTS carry their defaults, so they are absent
    expect(presence.github_token).toBe(false);
    expect(presence.use_commit_signing).toBe(false);
  });

  test("a payload of nothing but defaults reports nothing present", () => {
    const presence = JSON.parse(
      collectActionInputsPresence(JSON.stringify(ACTION_INPUT_DEFAULTS)),
    );

    expect(Object.keys(presence)).toHaveLength(39);
    expect(Object.values(presence)).toEqual(new Array(39).fill(false));
  });

  test("emits only booleans, never the input values", () => {
    const json = collectActionInputsPresence(
      JSON.stringify({
        anthropic_api_key: "sk-ant-secret-value",
        prompt: "do it",
      }),
    );

    expect(json).not.toContain("sk-ant-secret-value");
    expect(json).not.toContain("do it");
    for (const value of Object.values(JSON.parse(json))) {
      expect(typeof value).toBe("boolean");
    }
  });

  test("reads ALL_INPUTS from the environment by default", () => {
    process.env.ALL_INPUTS = '{"claude_args":"--model claude-opus-4"}';

    const presence = JSON.parse(collectActionInputsPresence());

    expect(presence.claude_args).toBe(true);
    expect(presence.prompt).toBe(false);
    expect(Object.keys(presence)).toHaveLength(39);
  });

  test("returns an empty object when ALL_INPUTS is unset or empty", () => {
    expect(collectActionInputsPresence(undefined)).toBe("{}");
    expect(collectActionInputsPresence("")).toBe("{}");
  });

  test("returns an empty object for malformed or non-object JSON", () => {
    expect(collectActionInputsPresence("{not json")).toBe("{}");
    expect(collectActionInputsPresence("[]")).toBe("{}");
    expect(collectActionInputsPresence("null")).toBe("{}");
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
