"""Tests for config loading: the YAML file form and the env-var (action input) form."""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

import agent_approval_check as aac

EXAMPLE_CONFIG = Path(aac.__file__).resolve().parent / "agent-identities.example.yaml"

ENV_INPUTS = (
    "CONFIG_FILE",
    "AGENT_EMAILS",
    "AGENT_LOGINS",
    "EXCLUDED_APPROVERS",
    "EXEMPT_HEAD_BRANCHES",
    "EXEMPT_PATH_PREFIXES",
    "PROTECTED_BASES",
)


def write_yaml(tmp_path: Path, data: object, name: str = "identities.yaml") -> Path:
    path = tmp_path / name
    path.write_text(yaml.safe_dump(data))
    return path


def write_text(tmp_path: Path, text: str, name: str = "identities.yaml") -> Path:
    path = tmp_path / name
    path.write_text(text)
    return path


class TestLoadAgentConfig:
    def test_example_file_loads(self):
        cfg = aac.load_agent_config(EXAMPLE_CONFIG)
        assert cfg.agent_emails == ["noreply@anthropic.com"]
        assert cfg.agent_app_logins == ["claude[bot]", "claude-code[bot]"]
        assert cfg.excluded_approver_logins == []
        assert cfg.exempt_head_branches == []
        assert cfg.exempt_path_prefixes == {"owner/repo": ["docs/"]}
        assert cfg.protected_bases == {
            "owner/repo": {"exact": ["main"], "prefixes": ["release/"]}
        }

    def test_missing_keys_default_to_empty(self, tmp_path):
        cfg = aac.load_agent_config(write_yaml(tmp_path, {}))
        assert cfg == aac.AgentConfig(
            agent_emails=[],
            agent_app_logins=[],
            excluded_approver_logins=[],
            exempt_head_branches=[],
            exempt_path_prefixes={},
            protected_bases={},
        )

    @pytest.mark.parametrize("text", ["- a\n- b\n", "just a string\n", ""])
    def test_non_dict_root_is_rejected(self, tmp_path, text):
        with pytest.raises(ValueError, match="expected dict"):
            aac.load_agent_config(write_text(tmp_path, text))

    @pytest.mark.parametrize(
        "key",
        ["agent_emails", "agent_app_logins", "excluded_approver_logins", "exempt_head_branches"],
    )
    def test_list_fields_must_be_lists(self, tmp_path, key):
        with pytest.raises(ValueError, match=f"{key} must be a list"):
            aac.load_agent_config(write_yaml(tmp_path, {key: "not-a-list"}))

    def test_exempt_path_prefixes_must_be_a_dict(self, tmp_path):
        with pytest.raises(ValueError, match="exempt_path_prefixes must be a dict"):
            aac.load_agent_config(write_yaml(tmp_path, {"exempt_path_prefixes": ["docs/"]}))

    def test_exempt_path_prefix_values_must_be_lists(self, tmp_path):
        with pytest.raises(ValueError, match=r"exempt_path_prefixes\['o/r'\] must be a list"):
            aac.load_agent_config(write_yaml(tmp_path, {"exempt_path_prefixes": {"o/r": "docs/"}}))

    @pytest.mark.parametrize("prefixes", [["docs/", ""], [1], [None]])
    def test_exempt_path_prefix_entries_must_be_non_empty_strings(self, tmp_path, prefixes):
        # An empty prefix would match every path and exempt every PR.
        with pytest.raises(ValueError, match="non-empty strings"):
            aac.load_agent_config(
                write_yaml(tmp_path, {"exempt_path_prefixes": {"o/r": prefixes}})
            )

    def test_protected_bases_must_be_a_dict(self, tmp_path):
        with pytest.raises(ValueError, match="protected_bases must be a dict"):
            aac.load_agent_config(write_yaml(tmp_path, {"protected_bases": ["main"]}))

    def test_protected_bases_entry_must_be_a_dict(self, tmp_path):
        with pytest.raises(ValueError, match=r"protected_bases\['o/r'\] must be a dict"):
            aac.load_agent_config(write_yaml(tmp_path, {"protected_bases": {"o/r": ["main"]}}))

    @pytest.mark.parametrize(
        "entry",
        [{"exact": "main"}, {"prefixes": "release/"}, {"exact": [""]}, {"prefixes": [None]}],
    )
    def test_protected_bases_lists_must_hold_non_empty_strings(self, tmp_path, entry):
        # An empty prefix would make every base branch "protected".
        with pytest.raises(ValueError, match="non-empty strings"):
            aac.load_agent_config(write_yaml(tmp_path, {"protected_bases": {"o/r": entry}}))

    def test_protected_bases_entry_may_omit_keys(self, tmp_path):
        # Documented: listing a repo replaces its default; an empty entry simply
        # protects nothing, which is fail-closed (no status is ever posted).
        cfg = aac.load_agent_config(write_yaml(tmp_path, {"protected_bases": {"o/r": {}}}))
        assert cfg.protected_bases == {"o/r": {}}
        assert aac.is_protected_base("main", cfg, "o/r", "main") is False

    def test_missing_file_raises(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            aac.load_agent_config(tmp_path / "does-not-exist.yaml")


class TestLoadAgentConfigFromEnv:
    @pytest.fixture(autouse=True)
    def _clean_env(self, monkeypatch):
        for name in ENV_INPUTS:
            monkeypatch.delenv(name, raising=False)

    def test_empty_env_gives_empty_config(self):
        cfg = aac.load_agent_config_from_env("o/r")
        assert cfg == aac.AgentConfig(
            agent_emails=[],
            agent_app_logins=[],
            excluded_approver_logins=[],
            exempt_head_branches=[],
            exempt_path_prefixes={},
            protected_bases={},
        )

    def test_csv_parsing_strips_whitespace_and_blank_entries(self, monkeypatch):
        monkeypatch.setenv("AGENT_EMAILS", " a@example.com , b@example.com ,, ")
        monkeypatch.setenv("AGENT_LOGINS", "claude[bot], claude-code[bot]")
        monkeypatch.setenv("EXCLUDED_APPROVERS", "rubber-stamp[bot] ,")
        monkeypatch.setenv("EXEMPT_HEAD_BRANCHES", " , ")
        cfg = aac.load_agent_config_from_env("o/r")
        assert cfg.agent_emails == ["a@example.com", "b@example.com"]
        assert cfg.agent_app_logins == ["claude[bot]", "claude-code[bot]"]
        assert cfg.excluded_approver_logins == ["rubber-stamp[bot]"]
        assert cfg.exempt_head_branches == []

    def test_per_repo_inputs_are_keyed_by_the_current_repo(self, monkeypatch):
        monkeypatch.setenv("EXEMPT_PATH_PREFIXES", "docs/, examples/")
        monkeypatch.setenv("PROTECTED_BASES", "main, release")
        cfg = aac.load_agent_config_from_env("o/r")
        assert cfg.exempt_path_prefixes == {"o/r": ["docs/", "examples/"]}
        # Inline protected_bases are exact branch names, never prefixes.
        assert cfg.protected_bases == {"o/r": {"exact": ["main", "release"], "prefixes": []}}
        assert aac.is_protected_base("release", cfg, "o/r", "main") is True
        assert aac.is_protected_base("release/1.0", cfg, "o/r", "main") is False

    def test_config_file_takes_precedence_over_inline_inputs(self, monkeypatch, tmp_path):
        path = write_yaml(
            tmp_path,
            {"agent_emails": ["file@example.com"], "agent_app_logins": ["file[bot]"]},
        )
        monkeypatch.setenv("CONFIG_FILE", str(path))
        monkeypatch.setenv("AGENT_EMAILS", "inline@example.com")
        monkeypatch.setenv("AGENT_LOGINS", "inline[bot]")
        monkeypatch.setenv("PROTECTED_BASES", "main")
        cfg = aac.load_agent_config_from_env("o/r")
        assert cfg.agent_emails == ["file@example.com"]
        assert cfg.agent_app_logins == ["file[bot]"]
        assert cfg.protected_bases == {}

    def test_blank_config_file_falls_back_to_inline_inputs(self, monkeypatch):
        monkeypatch.setenv("CONFIG_FILE", "   ")
        monkeypatch.setenv("AGENT_EMAILS", "inline@example.com")
        assert aac.load_agent_config_from_env("o/r").agent_emails == ["inline@example.com"]

    def test_invalid_config_file_fails_closed(self, monkeypatch, tmp_path):
        monkeypatch.setenv("CONFIG_FILE", str(write_yaml(tmp_path, {"agent_emails": "x"})))
        with pytest.raises(ValueError, match="agent_emails must be a list"):
            aac.load_agent_config_from_env("o/r")
