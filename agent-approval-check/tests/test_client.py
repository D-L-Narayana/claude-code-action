"""Tests for GitHubClient against an httpx.MockTransport — no network, no real token."""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from typing import Any

import httpx
import pytest
import tenacity

import agent_approval_check as aac
from tests.factories import AGENT_EMAIL, HEAD_SHA, HUMAN_EMAIL, OLD_SHA, T1

LOGGER = "agent_approval_check"
PERMISSION_PATH = "/repos/o/r/collaborators/{login}/permission"

RestHandler = Callable[[httpx.Request], httpx.Response]


class MockGitHub:
    """Routes the script's REST and GraphQL calls to canned responses.

    ``rest`` maps ``(method, path)`` to a handler, a FIFO list of responses or a
    single response. ``graphql_responses`` is a FIFO of JSON payloads returned
    for successive POSTs to ``/graphql``. Every request is recorded.
    """

    def __init__(self) -> None:
        self.rest: dict[tuple[str, str], RestHandler | list[httpx.Response] | httpx.Response] = {}
        self.graphql_responses: list[dict[str, Any]] = []
        self.requests: list[httpx.Request] = []
        self.graphql_calls: list[dict[str, Any]] = []
        self.client = httpx.Client(transport=httpx.MockTransport(self._handle))

    def _handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.url.path == "/graphql":
            assert request.method == "POST"
            self.graphql_calls.append(json.loads(request.content))
            assert self.graphql_responses, "unexpected GraphQL call — no canned response left"
            return httpx.Response(200, json=self.graphql_responses.pop(0))
        route = self.rest.get((request.method, request.url.path))
        if route is None:
            raise AssertionError(f"unexpected REST call: {request.method} {request.url.path}")
        if isinstance(route, list):
            return route.pop(0)
        if isinstance(route, httpx.Response):
            return route
        return route(request)


def rest_json(status: int, payload: Any) -> RestHandler:
    return lambda _request: httpx.Response(status, json=payload)


@pytest.fixture
def github(monkeypatch, _block_real_network):
    """Send the module-level httpx.post/httpx.request calls through the mock transport."""
    mock = MockGitHub()
    monkeypatch.setattr(httpx, "post", mock.client.post)
    monkeypatch.setattr(httpx, "request", mock.client.request)
    yield mock
    mock.client.close()


@pytest.fixture
def client() -> aac.GitHubClient:
    return aac.GitHubClient("test-token", "o/r")


@pytest.fixture
def no_retry_wait(monkeypatch):
    """Make tenacity retry immediately so retry tests don't sleep."""
    monkeypatch.setattr(aac.GitHubClient._rest_request.retry, "wait", tenacity.wait_none())
    monkeypatch.setattr(aac.GitHubClient._graphql.retry, "wait", tenacity.wait_none())


def commit_node(sha: str, email: str, signature: dict | None = None) -> dict:
    return {
        "commit": {
            "oid": sha,
            "committedDate": "2026-01-01T00:00:00Z",
            "committer": {"email": email},
            "signature": signature,
        }
    }


def associated(number: int, state: str, base: str, head: str) -> dict:
    return {"number": number, "state": state, "baseRefName": base, "headRefOid": head}


def pr_response(*, repository: dict | None = None, **overrides: Any) -> dict:
    """A GetPRData response for PR #7 of o/r, with a sibling PR #8 sharing the head."""
    pr: dict[str, Any] = {
        "id": "PR_node",
        "number": 7,
        "headRefOid": HEAD_SHA,
        "headRefName": "feature/agent-work",
        "baseRefName": "main",
        "createdAt": "2026-01-01T00:00:00Z",
        "author": {"__typename": "Bot", "login": "claude"},
        "commits": {
            "nodes": [
                commit_node(OLD_SHA, HUMAN_EMAIL),
                commit_node(HEAD_SHA, AGENT_EMAIL, {"state": "VALID", "verifiedAt": T1}),
            ],
            "pageInfo": {"hasPreviousPage": False},
        },
        "headCommit": {
            "nodes": [
                {
                    "commit": {
                        "oid": HEAD_SHA,
                        "associatedPullRequests": {
                            "nodes": [
                                associated(7, "OPEN", "main", HEAD_SHA),
                                associated(8, "OPEN", "release/1.0", HEAD_SHA),
                                associated(9, "CLOSED", "main", HEAD_SHA),
                                associated(10, "OPEN", "main", OLD_SHA),
                            ],
                            "pageInfo": {"hasNextPage": False},
                        },
                    }
                }
            ]
        },
        "reviews": {
            "nodes": [
                {
                    "author": {"__typename": "User", "login": "bob"},
                    "authorAssociation": "MEMBER",
                    "state": "APPROVED",
                    "commit": {"oid": HEAD_SHA},
                    "submittedAt": T1,
                }
            ],
            "pageInfo": {"hasPreviousPage": False},
        },
        "comments": {
            "nodes": [
                {
                    "id": "IC_101",
                    "databaseId": 101,
                    "author": {"__typename": "Bot", "login": "github-actions"},
                    "authorAssociation": "NONE",
                    "body": f"{aac.COMMENT_MARKER}\nstatus",
                    "isMinimized": True,
                }
            ],
            "pageInfo": {"hasPreviousPage": False, "startCursor": "c0"},
        },
        "files": {
            "nodes": [{"path": "docs/a.md"}, {"path": "src/app.py"}],
            "pageInfo": {"hasNextPage": False},
        },
    }
    pr.update(overrides)
    repo: dict[str, Any] = {"defaultBranchRef": {"name": "main"}, "pullRequest": pr}
    if repository is not None:
        repo.update(repository)
    return {
        "data": {
            "rateLimit": {"limit": 5000, "remaining": 4990, "used": 10, "resetAt": T1},
            "repository": repo,
        }
    }


def comment_node(node_id: str, database_id: int, login: str, body: str) -> dict:
    return {
        "id": node_id,
        "databaseId": database_id,
        "author": {"__typename": "User", "login": login},
        "authorAssociation": "MEMBER",
        "body": body,
        "isMinimized": False,
    }


# --- construction ---


def test_client_rejects_malformed_repo():
    with pytest.raises(ValueError, match="owner/repo"):
        aac.GitHubClient("test-token", "not-a-repo")


def test_client_splits_owner_and_repo():
    client = aac.GitHubClient("test-token", "o/r")
    assert (client.owner, client.repo_name) == ("o", "r")


# --- has_write_permission ---


class TestHasWritePermission:
    def test_404_means_not_a_collaborator(self, github, client):
        github.rest[("GET", PERMISSION_PATH.format(login="alice"))] = rest_json(
            404, {"message": "Not Found"}
        )
        assert client.has_write_permission("alice") is False
        assert len(github.requests) == 1

    @pytest.mark.parametrize("level", ["read", "triage", "none"])
    def test_read_like_levels_are_false(self, github, client, level):
        github.rest[("GET", PERMISSION_PATH.format(login="alice"))] = rest_json(
            200, {"permission": level}
        )
        assert client.has_write_permission("alice") is False

    @pytest.mark.parametrize("level", ["write", "maintain", "admin"])
    def test_write_like_levels_are_true(self, github, client, level):
        github.rest[("GET", PERMISSION_PATH.format(login="alice"))] = rest_json(
            200, {"permission": level}
        )
        assert client.has_write_permission("alice") is True

    def test_positive_result_is_cached_per_login(self, github, client):
        github.rest[("GET", PERMISSION_PATH.format(login="alice"))] = rest_json(
            200, {"permission": "write"}
        )
        assert client.has_write_permission("alice") is True
        assert client.has_write_permission("alice") is True
        assert client.has_write_permission("Alice") is True  # logins are case-insensitive
        assert len(github.requests) == 1

    def test_negative_result_is_cached_too(self, github, client):
        github.rest[("GET", PERMISSION_PATH.format(login="alice"))] = rest_json(
            404, {"message": "Not Found"}
        )
        assert client.has_write_permission("alice") is False
        assert client.has_write_permission("alice") is False
        assert len(github.requests) == 1

    def test_sends_bearer_token_and_api_headers(self, github, client):
        github.rest[("GET", PERMISSION_PATH.format(login="alice"))] = rest_json(
            200, {"permission": "write"}
        )
        client.has_write_permission("alice")
        request = github.requests[0]
        assert request.url == "https://api.github.com/repos/o/r/collaborators/alice/permission"
        assert request.headers["Authorization"] == "Bearer test-token"
        assert request.headers["Accept"] == "application/vnd.github+json"
        assert request.headers["X-GitHub-Api-Version"] == "2022-11-28"

    def test_other_4xx_errors_propagate_and_are_not_cached(self, github, client):
        github.rest[("GET", PERMISSION_PATH.format(login="alice"))] = rest_json(
            403, {"message": "Forbidden"}
        )
        with pytest.raises(httpx.HTTPStatusError):
            client.has_write_permission("alice")
        with pytest.raises(httpx.HTTPStatusError):
            client.has_write_permission("alice")
        # 4xx is not retried, and failures are never cached as "no write".
        assert len(github.requests) == 2

    def test_5xx_is_retried(self, github, client, no_retry_wait):
        github.rest[("GET", PERMISSION_PATH.format(login="alice"))] = [
            httpx.Response(502, json={"message": "Bad Gateway"}),
            httpx.Response(200, json={"permission": "write"}),
        ]
        assert client.has_write_permission("alice") is True
        assert len(github.requests) == 2


# --- _graphql ---


class TestGraphql:
    def test_posts_query_and_variables_and_returns_data(self, github, client):
        github.graphql_responses.append({"data": {"viewer": {"login": "me"}}})
        result = client._graphql("query { viewer { login } }", {"a": 1})
        assert result == {"viewer": {"login": "me"}}
        assert github.graphql_calls == [{"query": "query { viewer { login } }", "variables": {"a": 1}}]
        request = github.requests[0]
        assert request.url == "https://api.github.com/graphql"
        assert request.headers["Authorization"] == "Bearer test-token"

    def test_error_payload_raises(self, github, client):
        github.graphql_responses.append(
            {"errors": [{"message": "Something went wrong"}, {"message": "and again"}]}
        )
        with pytest.raises(RuntimeError, match="Something went wrong.*and again"):
            client._graphql("query { x }")

    def test_partial_data_with_errors_still_raises(self, github, client):
        github.graphql_responses.append(
            {"data": {"repository": None}, "errors": [{"message": "Not found"}]}
        )
        with pytest.raises(RuntimeError, match="GraphQL errors"):
            client._graphql("query { x }")


# --- fetch_pr_data ---


class TestFetchPrData:
    def test_normalizes_graphql_response(self, github, client):
        github.graphql_responses.append(pr_response())
        pr = client.fetch_pr_data(7)

        assert github.graphql_calls[0]["variables"] == {"owner": "o", "repo": "r", "prNumber": 7}
        assert github.graphql_calls[0]["query"] == aac.GRAPHQL_PR_QUERY

        assert pr.node_id == "PR_node"
        assert pr.number == 7
        assert pr.head_sha == HEAD_SHA
        assert pr.head_ref == "feature/agent-work"
        assert pr.base_ref == "main"
        assert pr.default_branch == "main"
        assert pr.created_at == "2026-01-01T00:00:00Z"
        assert pr.author_login == "claude[bot]"  # Bot login normalized to REST form
        assert pr.commits == [
            {"sha": OLD_SHA, "commit": {"committer": {"email": HUMAN_EMAIL}, "signature": None}},
            {
                "sha": HEAD_SHA,
                "commit": {
                    "committer": {"email": AGENT_EMAIL},
                    "signature": {"state": "VALID", "verifiedAt": T1},
                },
            },
        ]
        assert pr.reviews == [
            {
                "user": {"login": "bob"},
                "author_association": "MEMBER",
                "state": "APPROVED",
                "commit_id": HEAD_SHA,
                "submitted_at": T1,
            }
        ]
        assert pr.comments == [
            {
                "id": 101,
                "node_id": "IC_101",
                "user": {"login": "github-actions[bot]"},
                "author_association": "NONE",
                "body": f"{aac.COMMENT_MARKER}\nstatus",
                "is_minimized": True,
            }
        ]
        assert pr.files == ["docs/a.md", "src/app.py"]
        assert pr.commits_incomplete is False
        assert pr.files_incomplete is False
        # #7 is this PR, #9 is closed, #10 has a different head: only #8 is a sibling.
        assert pr.same_sha_open_prs == [(8, "release/1.0")]
        assert pr.same_sha_prs_incomplete is False

    def test_commit_overflow_sets_commits_incomplete(self, github, client):
        response = pr_response()
        response["data"]["repository"]["pullRequest"]["commits"]["pageInfo"] = {
            "hasPreviousPage": True
        }
        github.graphql_responses.append(response)
        assert client.fetch_pr_data(7).commits_incomplete is True

    def test_file_overflow_sets_files_incomplete(self, github, client):
        response = pr_response()
        response["data"]["repository"]["pullRequest"]["files"]["pageInfo"] = {
            "hasNextPage": True
        }
        github.graphql_responses.append(response)
        assert client.fetch_pr_data(7).files_incomplete is True

    def test_null_files_connection_is_tolerated(self, github, client):
        github.graphql_responses.append(pr_response(files=None))
        pr = client.fetch_pr_data(7)
        assert pr.files == []
        assert pr.files_incomplete is False

    def test_older_comment_pages_are_fetched_and_prepended(self, github, client):
        first = pr_response(
            comments={
                "nodes": [comment_node("IC_3", 3, "carol", "newest")],
                "pageInfo": {"hasPreviousPage": True, "startCursor": "cursor-3"},
            }
        )
        second = {
            "data": {
                "repository": {
                    "pullRequest": {
                        "comments": {
                            "nodes": [comment_node("IC_2", 2, "bob", "middle")],
                            "pageInfo": {"hasPreviousPage": True, "startCursor": "cursor-2"},
                        }
                    }
                }
            }
        }
        third = {
            "data": {
                "repository": {
                    "pullRequest": {
                        "comments": {
                            "nodes": [comment_node("IC_1", 1, "alice", "oldest")],
                            "pageInfo": {"hasPreviousPage": False, "startCursor": "cursor-1"},
                        }
                    }
                }
            }
        }
        github.graphql_responses.extend([first, second, third])

        pr = client.fetch_pr_data(7)

        assert [c["body"] for c in pr.comments] == ["oldest", "middle", "newest"]
        assert [c["id"] for c in pr.comments] == [1, 2, 3]
        page_calls = github.graphql_calls[1:]
        assert [call["query"] for call in page_calls] == [aac.GRAPHQL_COMMENTS_PAGE_QUERY] * 2
        assert [call["variables"]["before"] for call in page_calls] == ["cursor-3", "cursor-2"]
        assert all(call["variables"]["prNumber"] == 7 for call in page_calls)

    def test_null_paginated_comments_fail_closed(self, github, client):
        first = pr_response(
            comments={
                "nodes": [comment_node("IC_3", 3, "carol", "newest")],
                "pageInfo": {"hasPreviousPage": True, "startCursor": "cursor-3"},
            }
        )
        second = {"data": {"repository": {"pullRequest": {"comments": {"nodes": None}}}}}
        github.graphql_responses.extend([first, second])
        with pytest.raises(RuntimeError, match="paginated comments"):
            client.fetch_pr_data(7)

    def test_missing_pr_raises(self, github, client):
        github.graphql_responses.append(pr_response(repository={"pullRequest": None}))
        with pytest.raises(RuntimeError, match="PR #7 not found"):
            client.fetch_pr_data(7)

    @pytest.mark.parametrize("name", ["commits", "reviews", "comments", "headCommit"])
    def test_null_security_relevant_connection_fails_closed(self, github, client, name):
        github.graphql_responses.append(pr_response(**{name: None}))
        with pytest.raises(RuntimeError, match=f"null for '{name}'"):
            client.fetch_pr_data(7)

    @pytest.mark.parametrize("name", ["commits", "reviews", "comments", "headCommit"])
    def test_null_nodes_list_fails_closed(self, github, client, name):
        github.graphql_responses.append(pr_response(**{name: {"nodes": None, "pageInfo": {}}}))
        with pytest.raises(RuntimeError, match="partial response"):
            client.fetch_pr_data(7)

    def test_head_commit_mismatch_marks_sibling_list_incomplete(self, github, client):
        response = pr_response()
        head = response["data"]["repository"]["pullRequest"]["headCommit"]["nodes"][0]["commit"]
        head["oid"] = OLD_SHA  # commits(last:1) returned a non-head commit
        github.graphql_responses.append(response)
        pr = client.fetch_pr_data(7)
        assert pr.same_sha_prs_incomplete is True
        assert pr.same_sha_open_prs == []

    def test_null_sibling_entry_marks_incomplete_but_keeps_the_rest(self, github, client):
        response = pr_response()
        head = response["data"]["repository"]["pullRequest"]["headCommit"]["nodes"][0]["commit"]
        head["associatedPullRequests"]["nodes"] = [
            None,
            associated(8, "OPEN", "release/1.0", HEAD_SHA),
            {"number": 12, "state": "OPEN", "baseRefName": None, "headRefOid": HEAD_SHA},
        ]
        github.graphql_responses.append(response)
        pr = client.fetch_pr_data(7)
        assert pr.same_sha_prs_incomplete is True
        assert pr.same_sha_open_prs == [(8, "release/1.0")]

    def test_sibling_page_overflow_marks_incomplete(self, github, client):
        response = pr_response()
        head = response["data"]["repository"]["pullRequest"]["headCommit"]["nodes"][0]["commit"]
        head["associatedPullRequests"]["pageInfo"] = {"hasNextPage": True}
        github.graphql_responses.append(response)
        pr = client.fetch_pr_data(7)
        assert pr.same_sha_prs_incomplete is True
        assert pr.same_sha_open_prs == [(8, "release/1.0")]

    def test_missing_default_branch_is_empty_string(self, github, client):
        github.graphql_responses.append(pr_response(repository={"defaultBranchRef": None}))
        assert client.fetch_pr_data(7).default_branch == ""


# --- writes ---


class TestWrites:
    def test_create_commit_status_posts_rest_payload(self, github, client):
        github.rest[("POST", f"/repos/o/r/statuses/{HEAD_SHA}")] = rest_json(
            201, {"state": "pending", "context": aac.CHECK_NAME}
        )
        result = client.create_commit_status(
            sha=HEAD_SHA,
            state="pending",
            context=aac.CHECK_NAME,
            description="Need 2 approvals (have 0) [0123456789ab]",
            target_url="https://github.com/o/r/actions/runs/1",
        )
        assert result == {"state": "pending", "context": aac.CHECK_NAME}
        assert json.loads(github.requests[0].content) == {
            "state": "pending",
            "context": aac.CHECK_NAME,
            "description": "Need 2 approvals (have 0) [0123456789ab]",
            "target_url": "https://github.com/o/r/actions/runs/1",
        }

    def test_create_commit_status_omits_absent_target_url(self, github, client):
        github.rest[("POST", f"/repos/o/r/statuses/{HEAD_SHA}")] = rest_json(201, {})
        client.create_commit_status(HEAD_SHA, "success", aac.CHECK_NAME, "ok")
        assert "target_url" not in json.loads(github.requests[0].content)

    def test_execute_mutation_batch_skips_empty_batch(self, github, client):
        client.execute_mutation_batch(aac.MutationBatch())
        assert github.requests == []

    def test_execute_mutation_batch_sends_a_single_graphql_call(self, github, client):
        github.graphql_responses.append({"data": {"r1": {"reaction": {"content": "THUMBS_UP"}}}})
        batch = aac.MutationBatch(
            reactions=[("IC_5", "THUMBS_UP")],
            create_comment=("PR_node", "hello"),
            minimize_comments=[("IC_1", "OUTDATED")],
            unminimize_comments=["IC_2"],
        )
        client.execute_mutation_batch(batch)
        assert len(github.graphql_calls) == 1
        call = github.graphql_calls[0]
        assert "addReaction(" in call["query"]
        assert "addComment(" in call["query"]
        assert "minimizeComment(" in call["query"]
        assert "unminimizeComment(" in call["query"]
        assert call["variables"]["r1"] == {"subjectId": "IC_5", "content": "THUMBS_UP"}
        assert call["variables"]["createNotif"] == {"subjectId": "PR_node", "body": "hello"}


# --- rate limit logging ---


class TestRateLimitLogging:
    @pytest.mark.parametrize("rate_limit", [None, {}])
    def test_log_rate_limit_tolerates_missing_data(self, rate_limit):
        aac.log_rate_limit(rate_limit, "test")

    def test_log_rate_limit_tolerates_unknown_fields(self):
        aac.log_rate_limit({"remaining": "?", "limit": "?", "resetAt": "soon"})

    def test_log_rate_limit_warns_when_low(self, caplog):
        with caplog.at_level(logging.WARNING, logger=LOGGER):
            aac.log_rate_limit({"remaining": 100, "limit": 5000, "used": 4900, "resetAt": T1})
        assert "critically low" in caplog.text

    def test_log_rate_limit_reports_healthy_budget(self, caplog):
        with caplog.at_level(logging.INFO, logger=LOGGER):
            aac.log_rate_limit({"remaining": 4990, "limit": 5000, "used": 10}, "read")
        assert "[read] GitHub API rate limit: 4990/5000 remaining" in caplog.text
        assert [r for r in caplog.records if r.levelno >= logging.WARNING] == []

    def test_log_rest_rate_limit_reads_headers(self, caplog):
        response = httpx.Response(
            200,
            headers={
                "X-RateLimit-Remaining": "4999",
                "X-RateLimit-Limit": "5000",
                "X-RateLimit-Used": "1",
            },
        )
        with caplog.at_level(logging.INFO, logger=LOGGER):
            aac.log_rest_rate_limit(response, "status")
        assert "[status] GitHub REST API (core): 4999/5000 remaining (1 used)" in caplog.text
