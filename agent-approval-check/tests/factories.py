"""Test data factories for the agent-approval-check suite.

The dict shapes mirror what ``GitHubClient.fetch_pr_data`` produces after
normalizing the GraphQL response (REST-like ``user.login`` and friends), so the
pure helpers are exercised with exactly the input they see in production.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

import agent_approval_check as aac

# Four distinct 40-hex SHAs. No 12-character prefix of one is a prefix of
# another, so prefix matching in the tests is unambiguous.
HEAD_SHA = "0123456789abcdef0123456789abcdef01234567"
OLD_SHA = "fedcba9876543210fedcba9876543210fedcba98"
OLDER_SHA = "2222333344445555666677778888999900001111"
FOREIGN_SHA = "1111222233334444555566667777888899990000"

AGENT_EMAIL = "noreply@anthropic.com"
HUMAN_EMAIL = "dev@example.com"

# Monotonic review timestamps (ISO-8601, as GraphQL returns them).
T1 = "2026-01-01T10:00:00Z"
T2 = "2026-01-02T10:00:00Z"
T3 = "2026-01-03T10:00:00Z"


def make_commit(sha: str = HEAD_SHA, email: str = HUMAN_EMAIL) -> dict[str, Any]:
    """A commit in fetch_pr_data's normalized form."""
    return {"sha": sha, "commit": {"committer": {"email": email}, "signature": None}}


def make_review(
    login: str,
    state: str = "APPROVED",
    association: str = "MEMBER",
    submitted_at: str = T1,
    commit_id: str = HEAD_SHA,
) -> dict[str, Any]:
    """A review in fetch_pr_data's normalized form."""
    return {
        "user": {"login": login},
        "author_association": association,
        "state": state,
        "commit_id": commit_id,
        "submitted_at": submitted_at,
    }


def make_comment(
    login: str,
    body: str | None,
    association: str = "MEMBER",
    comment_id: int = 1,
    node_id: str | None = None,
    is_minimized: bool = False,
) -> dict[str, Any]:
    """An issue comment in fetch_pr_data's normalized form."""
    return {
        "id": comment_id,
        "node_id": f"IC_{comment_id}" if node_id is None else node_id,
        "user": {"login": login},
        "author_association": association,
        "body": body,
        "is_minimized": is_minimized,
    }


def make_pr_data(**overrides: Any) -> aac.PRData:
    """A PRData for repo ``o/r`` targeting its protected ``main`` branch."""
    fields: dict[str, Any] = {
        "node_id": "PR_node",
        "number": 7,
        "head_sha": HEAD_SHA,
        "head_ref": "feature/agent-work",
        "base_ref": "main",
        "default_branch": "main",
        "created_at": "2026-01-01T00:00:00Z",
        "author_login": "alice",
        "commits": [make_commit(OLD_SHA), make_commit(HEAD_SHA)],
        "reviews": [],
        "comments": [],
        "files": ["src/app.py"],
        "commits_incomplete": False,
        "files_incomplete": False,
        "same_sha_open_prs": [],
        "same_sha_prs_incomplete": False,
    }
    fields.update(overrides)
    return aac.PRData(**fields)


class PermissionStub:
    """Dict-backed stand-in for ``GitHubClient.has_write_permission``.

    Accepts either a mapping ``{login: has_write}`` or an iterable of logins
    that have write access. Every lookup is recorded so tests can assert the
    REST permission check is only consulted for genuine candidate approvers.
    """

    def __init__(self, permissions: Mapping[str, bool] | Iterable[str] = ()) -> None:
        if isinstance(permissions, Mapping):
            self.permissions = {k.lower(): bool(v) for k, v in permissions.items()}
        else:
            self.permissions = {login.lower(): True for login in permissions}
        self.calls: list[str] = []

    def __call__(self, login: str) -> bool:
        self.calls.append(login)
        return self.permissions.get(login.lower(), False)


class FakeClient:
    """Offline, duck-typed replacement for GitHubClient used by process_pr tests.

    Returns a prepared PRData, answers permission checks from a dict, and
    records every write (mutation batches and commit statuses).
    """

    repo = "o/r"

    def __init__(
        self,
        pr_data: aac.PRData,
        permissions: Mapping[str, bool] | Iterable[str] = (),
    ) -> None:
        self.pr_data = pr_data
        self.permission = PermissionStub(permissions)
        self.fetched: list[int] = []
        self.batches: list[aac.MutationBatch] = []
        self.statuses: list[dict[str, Any]] = []

    def fetch_pr_data(self, pr_number: int) -> aac.PRData:
        self.fetched.append(pr_number)
        return self.pr_data

    def has_write_permission(self, login: str) -> bool:
        return self.permission(login)

    def execute_mutation_batch(self, batch: aac.MutationBatch) -> None:
        self.batches.append(batch)

    def create_commit_status(
        self,
        sha: str,
        state: str,
        context: str,
        description: str,
        target_url: str | None = None,
    ) -> dict[str, Any]:
        self.statuses.append(
            {
                "sha": sha,
                "state": state,
                "context": context,
                "description": description,
                "target_url": target_url,
            }
        )
        return {"state": state}
