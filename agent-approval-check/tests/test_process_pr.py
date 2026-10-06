"""End-to-end tests of process_pr against an offline fake client.

These pin the threat-model guarantees from the README: fail-closed handling,
the protected-base refusal, the sibling-PR guard, and the comment/status
outputs for the pending and approved states.
"""

from __future__ import annotations

import pytest

import agent_approval_check as aac
from tests.factories import (
    AGENT_EMAIL,
    HEAD_SHA,
    OLD_SHA,
    OLDER_SHA,
    T1,
    FakeClient,
    make_comment,
    make_commit,
    make_pr_data,
    make_review,
)

SHORT = HEAD_SHA[:12]
BOTH_WRITE = {"bob": True, "carol": True}


@pytest.fixture(autouse=True)
def _no_run_id(monkeypatch):
    monkeypatch.delenv("GITHUB_RUN_ID", raising=False)


def run(pr: aac.PRData, config: aac.AgentConfig, permissions=()) -> FakeClient:
    client = FakeClient(pr, permissions)
    aac.process_pr(client, pr.number, config)
    return client


def only_status(client: FakeClient) -> dict:
    assert len(client.statuses) == 1, client.statuses
    return client.statuses[0]


def only_batch(client: FakeClient) -> aac.MutationBatch:
    assert len(client.batches) == 1, client.batches
    return client.batches[0]


def agent_pr(**overrides) -> aac.PRData:
    """A PR whose head commit was pushed by the agent."""
    overrides.setdefault("commits", [make_commit(OLD_SHA), make_commit(HEAD_SHA, AGENT_EMAIL)])
    return make_pr_data(**overrides)


def approved_agent_pr(**overrides) -> aac.PRData:
    """An agent PR with two human approvals: bob's review and carol's /approve."""
    overrides.setdefault("reviews", [make_review("bob", "APPROVED", "MEMBER", T1)])
    overrides.setdefault(
        "comments", [make_comment("carol", f"/approve {HEAD_SHA}", "COLLABORATOR", comment_id=5)]
    )
    return agent_pr(**overrides)


def notification(node_id: str = "IC_notif", is_minimized: bool = False) -> dict:
    return make_comment(
        "github-actions[bot]",
        f"{aac.COMMENT_MARKER}\nprevious status",
        "NONE",
        comment_id=100,
        node_id=node_id,
        is_minimized=is_minimized,
    )


class TestGuards:
    def test_unprotected_base_posts_nothing(self, config):
        client = run(agent_pr(base_ref="feature/other"), config)
        assert client.statuses == []
        assert client.batches == []

    def test_release_prefix_base_is_gated(self, config):
        client = run(agent_pr(base_ref="release/1.0"), config)
        assert only_status(client)["state"] == "pending"

    def test_pr_without_commits_posts_nothing(self, config):
        client = run(make_pr_data(commits=[]), config)
        assert client.statuses == []

    def test_pr_without_head_sha_posts_nothing(self, config):
        client = run(make_pr_data(head_sha=""), config)
        assert client.statuses == []

    def test_no_agent_activity_is_success_without_comments(self, config):
        client = run(make_pr_data(), config)
        assert only_status(client) == {
            "sha": HEAD_SHA,
            "state": "success",
            "context": "agent-approval-check",
            "description": f"No agent activity [{SHORT}]",
            "target_url": None,
        }
        assert client.batches == []
        assert client.permission.calls == []

    def test_status_links_to_the_workflow_run(self, config, monkeypatch):
        monkeypatch.setenv("GITHUB_RUN_ID", "123")
        client = run(make_pr_data(), config)
        assert only_status(client)["target_url"] == "https://github.com/o/r/actions/runs/123"

    def test_review_exempt_pr_passes_even_with_agent_commits(self, config):
        client = run(agent_pr(files=["docs/a.md", "docs/b/c.md"]), config)
        assert only_status(client)["description"] == f"Review-exempt PR [{SHORT}]"
        assert only_status(client)["state"] == "success"
        assert client.batches == []

    def test_exempt_head_branch_passes(self, config):
        config.exempt_head_branches = ["trusted/*"]
        client = run(agent_pr(head_ref="trusted/bot-sync"), config)
        assert only_status(client)["description"] == f"Exempt branch [{SHORT}]"
        assert only_status(client)["state"] == "success"


class TestApprovalFlow:
    def test_agent_commit_without_approvals_is_pending(self, config):
        client = run(agent_pr(), config)
        status = only_status(client)
        assert status["state"] == "pending"
        assert status["description"] == f"Need 2 approvals (have 0) [{SHORT}]"

        batch = only_batch(client)
        subject, body = batch.create_comment
        assert subject == "PR_node"
        assert body.startswith(aac.COMMENT_MARKER)
        assert "Needs Approval (0/2)" in body
        assert f"Commit {SHORT} has agent email ({AGENT_EMAIL})" in body
        assert f"/approve {SHORT}" in body
        assert batch.reactions == []
        assert batch.update_comment is None
        assert batch.create_stale_comment is None
        assert client.permission.calls == []

    def test_two_human_approvals_turn_success(self, config):
        client = run(approved_agent_pr(), config, BOTH_WRITE)
        status = only_status(client)
        assert status["state"] == "success"
        assert status["description"] == f"2/2 approvals [{SHORT}]"

        batch = only_batch(client)
        assert batch.reactions == [("IC_5", "THUMBS_UP")]
        _, body = batch.create_comment
        assert "Agent Activity - Approved (2/2)" in body
        assert "- @bob" in body and "- @carol" in body
        assert "How to Approve" not in body
        assert batch.create_stale_comment is None
        assert set(client.permission.calls) == {"bob", "carol"}

    def test_pending_with_one_approval(self, config):
        pr = approved_agent_pr(comments=[])
        client = run(pr, config, BOTH_WRITE)
        assert only_status(client)["description"] == f"Need 2 approvals (have 1) [{SHORT}]"
        assert "Needs Approval (1/2)" in only_batch(client).create_comment[1]

    def test_existing_notification_is_updated_and_minimized_once_approved(self, config):
        pr = approved_agent_pr()
        pr.comments.append(notification())
        client = run(pr, config, BOTH_WRITE)
        batch = only_batch(client)
        assert batch.create_comment is None
        node_id, body = batch.update_comment
        assert node_id == "IC_notif"
        assert "Approved (2/2)" in body
        assert batch.minimize_comments == [("IC_notif", "RESOLVED")]
        assert batch.unminimize_comments == []

    def test_already_minimized_notification_is_not_minimized_again(self, config):
        pr = approved_agent_pr()
        pr.comments.append(notification(is_minimized=True))
        client = run(pr, config, BOTH_WRITE)
        assert only_batch(client).minimize_comments == []

    def test_minimized_notification_is_restored_while_pending(self, config):
        pr = agent_pr(comments=[notification(is_minimized=True)])
        client = run(pr, config)
        batch = only_batch(client)
        assert batch.update_comment[0] == "IC_notif"
        assert batch.unminimize_comments == ["IC_notif"]
        assert batch.minimize_comments == []

    def test_agent_approval_alone_never_satisfies_the_check(self, config):
        pr = make_pr_data(reviews=[make_review("claude[bot]", "APPROVED", "NONE", T1)])
        client = run(pr, config, {"claude[bot]": True})
        status = only_status(client)
        assert status["state"] == "pending"
        assert status["description"] == f"Need 2 approvals (have 0) [{SHORT}]"
        assert "APPROVED review from agent: claude[bot]" in only_batch(client).create_comment[1]

    def test_fork_author_without_write_access_cannot_self_approve(self, config):
        comments = [
            make_comment("mallory", f"/approve {HEAD_SHA}", "CONTRIBUTOR", comment_id=1),
            make_comment("trent", f"/approve {HEAD_SHA}", "MEMBER", comment_id=2),
        ]
        pr = agent_pr(author_login="mallory", comments=comments)
        client = run(pr, config, {"mallory": True, "trent": False})
        assert only_status(client)["description"] == f"Need 2 approvals (have 0) [{SHORT}]"
        assert only_batch(client).reactions == []
        # Only trent reached the REST permission check (mallory never passed the
        # association pre-filter), and his read-only access rejected it.
        assert set(client.permission.calls) == {"trent"}


class TestStaleApprovals:
    def stale_pr(self, **overrides) -> aac.PRData:
        """bob approved the head via review; carol's /approve targets an old commit."""
        overrides.setdefault("commits", [make_commit(OLD_SHA, AGENT_EMAIL), make_commit(HEAD_SHA)])
        overrides.setdefault("reviews", [make_review("bob", "APPROVED", "MEMBER", T1)])
        comments = overrides.pop("comments", [])
        overrides["comments"] = [
            make_comment("carol", f"/approve {OLD_SHA}", "COLLABORATOR", comment_id=5),
            *comments,
        ]
        return make_pr_data(**overrides)

    def test_stale_approve_is_reported_and_notified(self, config):
        client = run(self.stale_pr(), config, BOTH_WRITE)
        status = only_status(client)
        assert status["state"] == "pending"
        assert status["description"] == f"Need 2 approvals (have 1) [{SHORT}]"

        batch = only_batch(client)
        assert batch.reactions == []  # a stale /approve earns no thumbs-up
        subject, stale_body = batch.create_stale_comment
        assert subject == "PR_node"
        assert stale_body.startswith(aac.STALE_MARKER)
        assert "@carol" in stale_body
        assert f"/approve {SHORT}" in stale_body
        _, body = batch.create_comment
        assert "### Stale Approvals" in body
        assert f"- @carol (approved `{OLD_SHA[:12]}`)" in body

    def test_existing_stale_notification_is_not_duplicated(self, config):
        existing = make_comment(
            "github-actions[bot]",
            f"{aac.STALE_MARKER}\n@carol: head is now `{SHORT}`",
            "NONE",
            comment_id=9,
            node_id="IC_stale",
        )
        client = run(self.stale_pr(comments=[existing]), config, BOTH_WRITE)
        batch = only_batch(client)
        assert batch.create_stale_comment is None
        assert batch.minimize_comments == []

    def test_outdated_stale_notifications_are_minimized(self, config):
        outdated = make_comment(
            "github-actions[bot]",
            f"{aac.STALE_MARKER}\n@carol: head is now `{OLDER_SHA[:12]}`",
            "NONE",
            comment_id=10,
            node_id="IC_oldstale",
        )
        client = run(self.stale_pr(comments=[outdated]), config, BOTH_WRITE)
        batch = only_batch(client)
        assert batch.minimize_comments == [("IC_oldstale", "OUTDATED")]
        assert batch.create_stale_comment is not None

    def test_no_stale_notification_once_approved(self, config):
        # carol re-approved the head: she is a current approver, nothing is stale.
        pr = self.stale_pr(
            comments=[make_comment("carol", f"/approve {HEAD_SHA}", "COLLABORATOR", comment_id=6)]
        )
        client = run(pr, config, BOTH_WRITE)
        assert only_status(client)["state"] == "success"
        batch = only_batch(client)
        assert batch.create_stale_comment is None
        assert batch.reactions == [("IC_6", "THUMBS_UP")]

    def test_stale_approver_is_listed_but_not_pinged_once_threshold_is_met(self, config):
        # bob (review) and dave (/approve head) satisfy the threshold; carol's
        # old /approve is still shown as stale, but nobody is nagged to re-approve.
        pr = self.stale_pr(
            comments=[make_comment("dave", f"/approve {HEAD_SHA}", "MEMBER", comment_id=6)]
        )
        client = run(pr, config, {"bob": True, "carol": True, "dave": True})
        assert only_status(client)["description"] == f"2/2 approvals [{SHORT}]"
        batch = only_batch(client)
        assert batch.create_stale_comment is None
        _, body = batch.create_comment
        assert "Approved (2/2)" in body
        assert f"- @carol (approved `{OLD_SHA[:12]}`)" in body


class TestSiblingGuard:
    def test_protected_sibling_withholds_success(self, config):
        pr = approved_agent_pr(same_sha_open_prs=[(8, "release/1.0")])
        client = run(pr, config, BOTH_WRITE)
        status = only_status(client)
        assert status["state"] == "pending"
        assert status["description"] == (
            f"Sibling PR(s) #8 share this commit — close or re-target them [{SHORT}]"
        )
        _, body = only_batch(client).create_comment
        assert "Blocked — Sibling PRs Share This Commit" in body
        assert "#8" in body

    def test_unprotected_sibling_does_not_block(self, config):
        pr = approved_agent_pr(same_sha_open_prs=[(8, "feature/other")])
        client = run(pr, config, BOTH_WRITE)
        assert only_status(client)["state"] == "success"
        assert "Sibling" not in only_batch(client).create_comment[1]

    def test_unverifiable_sibling_list_withholds_success(self, config):
        pr = approved_agent_pr(same_sha_prs_incomplete=True)
        client = run(pr, config, BOTH_WRITE)
        status = only_status(client)
        assert status["state"] == "pending"
        assert status["description"] == (
            f"Cannot list PRs sharing this commit — holding at pending [{SHORT}]"
        )
        assert "could not be verified" in only_batch(client).create_comment[1]

    def test_sibling_guard_also_holds_no_agent_prs(self, config):
        client = run(make_pr_data(same_sha_open_prs=[(8, "main")]), config)
        assert only_status(client)["state"] == "pending"

    def test_pending_status_is_unaffected_by_siblings(self, config):
        client = run(agent_pr(same_sha_open_prs=[(8, "main")]), config)
        assert only_status(client)["description"] == f"Need 2 approvals (have 0) [{SHORT}]"

    def test_existing_comment_is_not_minimized_while_blocked(self, config):
        pr = approved_agent_pr(same_sha_open_prs=[(8, "main")])
        pr.comments.append(notification(is_minimized=True))
        client = run(pr, config, BOTH_WRITE)
        batch = only_batch(client)
        assert batch.minimize_comments == []
        assert batch.unminimize_comments == ["IC_notif"]

    def test_many_siblings_are_summarized(self, config):
        siblings = [(n, "main") for n in (8, 9, 10, 11, 12)]
        client = run(approved_agent_pr(same_sha_open_prs=siblings), config, BOTH_WRITE)
        assert only_status(client)["description"].startswith(
            "Sibling PR(s) #8, #9, #10 +2 more share this commit"
        )


class TestNotificationBodies:
    def test_approved_body(self):
        body = aac.generate_notification_comment({"carol", "bob"}, [], "why", HEAD_SHA)
        assert body.startswith(aac.COMMENT_MARKER)
        assert "Agent Activity - Approved (2/2)" in body
        assert "> why" in body
        assert body.index("- @bob") < body.index("- @carol")  # sorted
        assert "How to Approve" not in body
        assert aac.DOCS_URL in body

    def test_pending_body_explains_how_to_approve(self):
        body = aac.generate_notification_comment({"bob"}, [], "why", HEAD_SHA)
        assert "Agent Activity - Needs Approval (1/2)" in body
        assert "**2 trusted actor approvals**" in body
        assert f"/approve {SHORT}" in body
        assert "your approval counts as one of the 2 required approvals" in body

    def test_stale_section_lists_users(self):
        body = aac.generate_notification_comment(
            set(), [{"user": "carol", "sha": OLD_SHA}], "why", HEAD_SHA
        )
        assert "### Stale Approvals" in body
        assert f"- @carol (approved `{OLD_SHA[:12]}`)" in body

    def test_sibling_section(self):
        body = aac.generate_notification_comment(
            {"bob", "carol"},
            [],
            "why",
            HEAD_SHA,
            sibling_blocker_prs=[8, 9],
            sibling_list_incomplete=True,
        )
        assert "Blocked — Sibling PRs Share This Commit" in body
        assert "#8, #9" in body
        assert "could not be verified" in body
        assert "stays `pending`" in body

    def test_stale_notification_body(self):
        stale = [{"user": "carol", "sha": OLD_SHA}, {"user": "dave", "sha": OLDER_SHA}]
        body = aac.generate_stale_notification(stale, HEAD_SHA)
        assert body.startswith(aac.STALE_MARKER)
        assert "@carol, @dave" in body
        assert f"head is now `{SHORT}`" in body
        assert f"/approve {SHORT}" in body
