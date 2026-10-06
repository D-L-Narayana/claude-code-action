"""Tests for resolve_pr_number: deriving the PR number from the event payload."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import agent_approval_check as aac


def write_event(tmp_path: Path, payload: object) -> str:
    path = tmp_path / "event.json"
    path.write_text(json.dumps(payload))
    return str(path)


@pytest.mark.parametrize(
    "event_name", ["pull_request", "pull_request_target", "pull_request_review"]
)
def test_pull_request_events_take_the_number_from_the_payload(tmp_path, event_name):
    path = write_event(tmp_path, {"pull_request": {"number": 42}})
    assert aac.resolve_pr_number(event_name, path) == 42


def test_issue_comment_on_a_pull_request(tmp_path):
    payload = {
        "issue": {"number": 7, "pull_request": {"url": "https://api.github.com/x/pulls/7"}},
        "comment": {"body": "/approve 0123456789ab"},
    }
    assert aac.resolve_pr_number("issue_comment", write_event(tmp_path, payload)) == 7


def test_issue_comment_on_a_plain_issue_has_no_pr(tmp_path):
    payload = {"issue": {"number": 7}, "comment": {"body": "hello"}}
    assert aac.resolve_pr_number("issue_comment", write_event(tmp_path, payload)) is None


def test_issue_comment_with_null_pull_request_has_no_pr(tmp_path):
    payload = {"issue": {"number": 7, "pull_request": None}}
    assert aac.resolve_pr_number("issue_comment", write_event(tmp_path, payload)) is None


def test_issue_comment_without_issue_has_no_pr(tmp_path):
    assert aac.resolve_pr_number("issue_comment", write_event(tmp_path, {})) is None


def test_workflow_run_uses_the_first_listed_pull_request(tmp_path):
    payload = {"workflow_run": {"pull_requests": [{"number": 5}, {"number": 6}]}}
    assert aac.resolve_pr_number("workflow_run", write_event(tmp_path, payload)) == 5


@pytest.mark.parametrize(
    "payload",
    [
        {"workflow_run": {"pull_requests": []}},
        {"workflow_run": {"pull_requests": None}},
        {"workflow_run": {}},
    ],
)
def test_workflow_run_without_pull_requests_has_no_pr(tmp_path, payload):
    assert aac.resolve_pr_number("workflow_run", write_event(tmp_path, payload)) is None


@pytest.mark.parametrize("event_name", ["push", "schedule", "workflow_dispatch", ""])
def test_unsupported_event_raises(tmp_path, event_name):
    path = write_event(tmp_path, {"pull_request": {"number": 1}})
    with pytest.raises(ValueError, match="Unsupported event"):
        aac.resolve_pr_number(event_name, path)


def test_number_is_coerced_to_int(tmp_path):
    path = write_event(tmp_path, {"pull_request": {"number": "42"}})
    result = aac.resolve_pr_number("pull_request_target", path)
    assert result == 42
    assert isinstance(result, int)


def test_missing_payload_file_raises(tmp_path):
    with pytest.raises(FileNotFoundError):
        aac.resolve_pr_number("pull_request", str(tmp_path / "missing.json"))
