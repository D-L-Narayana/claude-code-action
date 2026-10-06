"""Tests for main(): input validation and the PR-number → process_pr wiring.

``GitHubClient`` and ``process_pr`` are replaced with recorders, so these tests
exercise only the glue in ``main()`` — no network, no real token.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import agent_approval_check as aac

MAIN_ENV = (
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_REPOSITORY",
    "GITHUB_REPOSITORY",
    "GH_PR_NUMBER",
    "GH_PR_CANDIDATES",
    "GH_EVENT_NAME",
    "GITHUB_EVENT_NAME",
    "GH_EVENT_PATH",
    "GITHUB_EVENT_PATH",
    "CONFIG_FILE",
    "AGENT_EMAILS",
    "AGENT_LOGINS",
    "EXCLUDED_APPROVERS",
    "EXEMPT_HEAD_BRANCHES",
    "EXEMPT_PATH_PREFIXES",
    "PROTECTED_BASES",
)


class Recorder:
    """Stands in for GitHubClient (construction) and process_pr (invocation)."""

    def __init__(self) -> None:
        self.clients: list[tuple[str, str]] = []
        self.calls: list[tuple[object, int, aac.AgentConfig]] = []

    def make_client(self, token: str, repo: str) -> object:
        self.clients.append((token, repo))
        return ("client", token, repo)

    def process_pr(self, client: object, pr_number: int, config: aac.AgentConfig) -> None:
        self.calls.append((client, pr_number, config))


@pytest.fixture
def recorder(monkeypatch: pytest.MonkeyPatch) -> Recorder:
    rec = Recorder()
    monkeypatch.setattr(aac, "GitHubClient", rec.make_client)
    monkeypatch.setattr(aac, "process_pr", rec.process_pr)
    return rec


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> pytest.MonkeyPatch:
    """A minimal valid environment: token, repo and one agent identity of each kind."""
    for name in MAIN_ENV:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("GH_TOKEN", "test-token")
    monkeypatch.setenv("GH_REPOSITORY", "o/r")
    monkeypatch.setenv("AGENT_EMAILS", "noreply@anthropic.com")
    monkeypatch.setenv("AGENT_LOGINS", "claude[bot]")
    return monkeypatch


def write_event(tmp_path: Path, payload: object) -> str:
    path = tmp_path / "event.json"
    path.write_text(json.dumps(payload))
    return str(path)


def assert_exits_1(recorder: Recorder) -> None:
    with pytest.raises(SystemExit) as excinfo:
        aac.main()
    assert excinfo.value.code == 1
    assert recorder.clients == []
    assert recorder.calls == []


class TestInputValidation:
    def test_missing_token_exits_1(self, env, recorder):
        env.delenv("GH_TOKEN")
        assert_exits_1(recorder)

    def test_missing_repository_exits_1(self, env, recorder):
        env.delenv("GH_REPOSITORY")
        assert_exits_1(recorder)

    def test_no_agent_identities_exits_1(self, env, recorder):
        env.setenv("AGENT_EMAILS", "")
        env.setenv("AGENT_LOGINS", " , ")
        env.setenv("GH_PR_NUMBER", "7")
        assert_exits_1(recorder)

    @pytest.mark.parametrize("required", [0, -1])
    def test_required_approvals_below_one_exits_1(self, env, recorder, required):
        env.setattr(aac, "REQUIRED_APPROVALS", required)
        env.setenv("GH_PR_NUMBER", "7")
        assert_exits_1(recorder)

    def test_missing_event_inputs_exit_1(self, env, recorder):
        # Neither GH_PR_NUMBER nor an event name/path: nothing to evaluate.
        assert_exits_1(recorder)

    def test_invalid_config_file_fails_closed(self, env, recorder, tmp_path):
        bad = tmp_path / "identities.yaml"
        bad.write_text("agent_emails: not-a-list\n")
        env.setenv("CONFIG_FILE", str(bad))
        env.setenv("GH_PR_NUMBER", "7")
        with pytest.raises(ValueError, match="agent_emails must be a list"):
            aac.main()
        assert recorder.calls == []


class TestPrNumberResolution:
    def test_explicit_pr_number_drives_process_pr(self, env, recorder):
        env.setenv("GH_PR_NUMBER", " 42 ")
        aac.main()
        assert recorder.clients == [("test-token", "o/r")]
        assert [(c, n) for c, n, _ in recorder.calls] == [(("client", "test-token", "o/r"), 42)]

    def test_explicit_pr_number_wins_over_event_payload(self, env, recorder, tmp_path):
        env.setenv("GH_PR_NUMBER", "42")
        env.setenv("GH_EVENT_NAME", "pull_request_target")
        env.setenv("GH_EVENT_PATH", write_event(tmp_path, {"pull_request": {"number": 7}}))
        aac.main()
        assert [n for _, n, _ in recorder.calls] == [42]

    def test_pr_number_comes_from_event_payload(self, env, recorder, tmp_path):
        env.setenv("GH_EVENT_NAME", "pull_request_target")
        env.setenv("GH_EVENT_PATH", write_event(tmp_path, {"pull_request": {"number": 7}}))
        aac.main()
        assert [n for _, n, _ in recorder.calls] == [7]

    def test_issue_comment_on_plain_issue_is_a_successful_noop(self, env, recorder, tmp_path):
        env.setenv("GH_EVENT_NAME", "issue_comment")
        env.setenv("GH_EVENT_PATH", write_event(tmp_path, {"issue": {"number": 7}}))
        assert aac.main() is None  # returns normally → the workflow run succeeds
        assert recorder.clients == []
        assert recorder.calls == []

    def test_unsupported_event_fails_closed(self, env, recorder, tmp_path):
        env.setenv("GH_EVENT_NAME", "push")
        env.setenv("GH_EVENT_PATH", write_event(tmp_path, {}))
        with pytest.raises(ValueError, match="Unsupported event"):
            aac.main()
        assert recorder.calls == []

    def test_github_prefixed_variables_are_accepted(self, env, recorder, tmp_path):
        env.delenv("GH_TOKEN")
        env.delenv("GH_REPOSITORY")
        env.setenv("GITHUB_TOKEN", "test-token")
        env.setenv("GITHUB_REPOSITORY", "o/r")
        env.setenv("GITHUB_EVENT_NAME", "pull_request")
        env.setenv("GITHUB_EVENT_PATH", write_event(tmp_path, {"pull_request": {"number": 9}}))
        aac.main()
        assert recorder.clients == [("test-token", "o/r")]
        assert [n for _, n, _ in recorder.calls] == [9]

    def test_candidates_route_to_the_protected_sibling(self, env, recorder):
        env.setenv("PROTECTED_BASES", "main")
        env.setenv("GH_PR_NUMBER", "11")
        env.setenv(
            "GH_PR_CANDIDATES",
            json.dumps(
                [
                    {"number": 11, "base": {"ref": "feature/x"}},
                    {"number": 12, "base": {"ref": "main"}},
                ]
            ),
        )
        aac.main()
        assert [n for _, n, _ in recorder.calls] == [12]

    def test_candidates_are_ignored_without_explicit_protected_bases(self, env, recorder):
        env.setenv("GH_PR_NUMBER", "11")
        env.setenv("GH_PR_CANDIDATES", json.dumps([{"number": 12, "base": {"ref": "main"}}]))
        aac.main()
        assert [n for _, n, _ in recorder.calls] == [11]

    def test_inline_inputs_are_passed_to_process_pr(self, env, recorder):
        env.setenv("GH_PR_NUMBER", "7")
        env.setenv("EXCLUDED_APPROVERS", "rubber-stamp[bot]")
        env.setenv("EXEMPT_PATH_PREFIXES", "docs/")
        env.setenv("PROTECTED_BASES", "main,release")
        aac.main()
        (_, _, config), = recorder.calls
        assert config == aac.AgentConfig(
            agent_emails=["noreply@anthropic.com"],
            agent_app_logins=["claude[bot]"],
            excluded_approver_logins=["rubber-stamp[bot]"],
            exempt_head_branches=[],
            exempt_path_prefixes={"o/r": ["docs/"]},
            protected_bases={"o/r": {"exact": ["main", "release"], "prefixes": []}},
        )
