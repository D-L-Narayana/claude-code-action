"""Tests for agent detection and approval counting.

The permission check is a dict-backed callable (``PermissionStub``) standing in
for ``GitHubClient.has_write_permission``.
"""

from __future__ import annotations

import pytest

import agent_approval_check as aac
from tests.factories import (
    AGENT_EMAIL,
    FOREIGN_SHA,
    HEAD_SHA,
    HUMAN_EMAIL,
    OLD_SHA,
    OLDER_SHA,
    T1,
    T2,
    FakeClient,
    PermissionStub,
    make_comment,
    make_commit,
    make_pr_data,
    make_review,
)

WRITERS = PermissionStub(["alice", "bob", "carol", "dave", "claude[bot]", "rubber-stamp[bot]"])


def approve(login: str, sha: str = HEAD_SHA, association: str = "MEMBER", **kw) -> dict:
    return make_comment(login, f"/approve {sha}", association, **kw)


# --- check_for_agent_activity ---


class TestCheckForAgentActivity:
    def test_agent_committer_email_is_agent_activity(self, config):
        commits = [make_commit(OLD_SHA, HUMAN_EMAIL), make_commit(HEAD_SHA, AGENT_EMAIL)]
        result = aac.check_for_agent_activity(commits, "alice", config)
        assert result.has_agent_activity is True
        assert result.latest_agent_commit == commits[1]
        assert result.detection_reason == f"Commit {HEAD_SHA[:12]} has agent email ({AGENT_EMAIL})"

    def test_latest_agent_commit_is_the_last_agent_commit_in_order(self, config):
        commits = [make_commit(OLD_SHA, AGENT_EMAIL), make_commit(HEAD_SHA, HUMAN_EMAIL)]
        result = aac.check_for_agent_activity(commits, "alice", config)
        assert result.has_agent_activity is True
        assert result.latest_agent_commit["sha"] == OLD_SHA

    def test_agent_email_match_is_case_insensitive(self, config):
        commits = [make_commit(HEAD_SHA, "NoReply@Anthropic.COM")]
        assert aac.check_for_agent_activity(commits, "alice", config).has_agent_activity is True

    def test_pr_opened_by_agent_is_agent_activity(self, config):
        commits = [make_commit(OLD_SHA), make_commit(HEAD_SHA)]
        result = aac.check_for_agent_activity(commits, "claude[bot]", config)
        assert result.has_agent_activity is True
        assert result.latest_agent_commit == commits[-1]
        assert result.detection_reason == "PR was created by claude[bot]"

    def test_pr_author_match_is_case_insensitive(self, config):
        commits = [make_commit(HEAD_SHA)]
        assert aac.check_for_agent_activity(commits, "Claude-Code[Bot]", config).has_agent_activity

    def test_agent_approved_review_is_agent_activity(self, config):
        commits = [make_commit(HEAD_SHA)]
        reviews = [make_review("claude[bot]", "APPROVED", association="NONE")]
        result = aac.check_for_agent_activity(commits, "alice", config, reviews=reviews)
        assert result.has_agent_activity is True
        assert result.latest_agent_commit == commits[-1]
        assert result.detection_reason == "PR has an APPROVED review from agent: claude[bot]"

    def test_agent_non_approving_review_is_not_agent_activity(self, config):
        commits = [make_commit(HEAD_SHA)]
        reviews = [
            make_review("claude[bot]", "COMMENTED"),
            make_review("claude[bot]", "CHANGES_REQUESTED"),
        ]
        result = aac.check_for_agent_activity(commits, "alice", config, reviews=reviews)
        assert result.has_agent_activity is False

    def test_human_only_pr_has_no_agent_activity(self, config):
        commits = [make_commit(OLD_SHA), make_commit(HEAD_SHA)]
        reviews = [make_review("bob", "APPROVED")]
        result = aac.check_for_agent_activity(commits, "alice", config, reviews=reviews)
        assert result == aac.AgentActivityResult(
            has_agent_activity=False, latest_agent_commit=None, detection_reason=""
        )

    def test_excluded_approver_does_not_trigger_detection(self, config):
        # Excluded approvers are ignored when counting, but are not agents.
        commits = [make_commit(HEAD_SHA)]
        reviews = [make_review("rubber-stamp[bot]", "APPROVED")]
        result = aac.check_for_agent_activity(commits, "alice", config, reviews=reviews)
        assert result.has_agent_activity is False

    def test_incomplete_commit_list_is_fail_closed(self, config):
        # >100 commits: the full list can't be verified, so the PR is treated as
        # agent-authored even though every visible commit is human.
        pr = make_pr_data(commits=[make_commit(HEAD_SHA, HUMAN_EMAIL)], commits_incomplete=True)
        client = FakeClient(pr)
        aac.process_pr(client, pr.number, config)
        assert [s["state"] for s in client.statuses] == ["pending"]
        assert client.statuses[0]["description"] == "Need 2 approvals (have 0) [0123456789ab]"
        subject, body = client.batches[0].create_comment
        assert subject == "PR_node"
        assert ">100 commits" in body


# --- count_approvers ---


class TestCountApprovers:
    def count(self, config, reviews=(), comments=(), permission=WRITERS):
        return aac.count_approvers(HEAD_SHA, list(reviews), list(comments), config, permission)

    def test_approved_review_from_write_user_counts(self, config):
        assert self.count(config, [make_review("bob")]) == {"bob"}

    def test_approver_logins_are_lowercased(self, config):
        assert self.count(config, [make_review("Bob")]) == {"bob"}

    def test_review_requires_write_permission(self, config):
        permission = PermissionStub({"bob": False})
        assert self.count(config, [make_review("bob")], permission=permission) == set()
        assert permission.calls == ["bob"]

    def test_review_from_non_collaborator_association_is_skipped_cheaply(self, config):
        permission = PermissionStub(["bob"])
        reviews = [make_review("bob", association="CONTRIBUTOR"), make_review("mallory", association="NONE")]
        assert self.count(config, reviews, permission=permission) == set()
        assert permission.calls == []

    def test_agent_review_never_counts(self, config):
        assert self.count(config, [make_review("claude[bot]"), make_review("Claude-Code[bot]")]) == set()

    def test_excluded_approver_review_never_counts(self, config):
        assert self.count(config, [make_review("rubber-stamp[bot]")]) == set()

    def test_changes_requested_removes_an_earlier_approval(self, config):
        reviews = [
            make_review("bob", "APPROVED", submitted_at=T1),
            make_review("bob", "CHANGES_REQUESTED", submitted_at=T2),
        ]
        assert self.count(config, reviews) == set()

    def test_approval_after_changes_requested_counts(self, config):
        reviews = [
            make_review("bob", "CHANGES_REQUESTED", submitted_at=T1),
            make_review("bob", "APPROVED", submitted_at=T2),
        ]
        assert self.count(config, reviews) == {"bob"}

    def test_comment_review_after_approval_keeps_the_approval(self, config):
        reviews = [
            make_review("bob", "APPROVED", submitted_at=T1),
            make_review("bob", "COMMENTED", submitted_at=T2),
        ]
        assert self.count(config, reviews) == {"bob"}

    def test_dismissed_review_does_not_count(self, config):
        assert self.count(config, [make_review("bob", "DISMISSED")]) == set()

    def test_approve_comment_for_head_counts(self, config):
        assert self.count(config, comments=[approve("carol")]) == {"carol"}

    def test_approve_comment_with_head_prefix_counts(self, config):
        assert self.count(config, comments=[approve("carol", HEAD_SHA[:12].upper())]) == {"carol"}

    def test_approve_comment_for_old_sha_does_not_count(self, config):
        assert self.count(config, comments=[approve("carol", OLD_SHA)]) == set()

    def test_approve_comment_requires_write_permission(self, config):
        permission = PermissionStub({"carol": False})
        assert self.count(config, comments=[approve("carol")], permission=permission) == set()

    def test_approve_comment_from_agent_or_excluded_never_counts(self, config):
        comments = [approve("claude[bot]"), approve("rubber-stamp[bot]")]
        assert self.count(config, comments=comments) == set()

    def test_approve_comment_from_non_collaborator_does_not_count(self, config):
        # A fork-PR author without write access cannot self-count.
        assert self.count(config, comments=[approve("alice", association="CONTRIBUTOR")]) == set()

    def test_pr_author_approve_counts_as_one(self, config):
        comments = [approve("alice")]  # alice opened the PR and has write access
        reviews = [make_review("bob")]
        assert self.count(config, reviews, comments) == {"alice", "bob"}

    def test_review_and_comment_from_same_user_count_once(self, config):
        assert self.count(config, [make_review("Bob")], [approve("bob")]) == {"bob"}

    def test_distinct_approvers_are_summed(self, config):
        reviews = [make_review("bob"), make_review("claude[bot]")]
        comments = [approve("carol"), approve("dave", OLD_SHA), approve("rubber-stamp[bot]")]
        assert self.count(config, reviews, comments) == {"bob", "carol"}


# --- find_stale_approvals ---


class TestFindStaleApprovals:
    COMMITS = [make_commit(OLDER_SHA), make_commit(OLD_SHA), make_commit(HEAD_SHA)]

    def stale(self, config, comments, current=None, permission=WRITERS):
        return aac.find_stale_approvals(
            comments, HEAD_SHA, config, self.COMMITS, permission, current_approvers=current
        )

    def test_approve_for_earlier_pr_commit_is_stale(self, config):
        assert self.stale(config, [approve("carol", OLD_SHA)]) == [{"user": "carol", "sha": OLD_SHA}]

    def test_approve_for_head_is_not_stale(self, config):
        assert self.stale(config, [approve("carol")]) == []

    def test_current_approver_is_never_reported_stale(self, config):
        comments = [approve("carol", OLD_SHA), approve("carol", HEAD_SHA)]
        assert self.stale(config, comments, current={"carol"}) == []

    def test_current_approver_match_is_case_insensitive(self, config):
        assert self.stale(config, [approve("Carol", OLD_SHA)], current={"carol"}) == []

    def test_sha_outside_the_pr_is_ignored(self, config):
        # A typo or a SHA from another PR is not "stale", just irrelevant.
        assert self.stale(config, [approve("carol", FOREIGN_SHA)]) == []

    def test_one_entry_per_user(self, config):
        comments = [approve("carol", OLD_SHA), approve("carol", OLDER_SHA)]
        assert self.stale(config, comments) == [{"user": "carol", "sha": OLD_SHA}]

    def test_empty_head_sha_returns_nothing(self, config):
        result = aac.find_stale_approvals(
            [approve("carol", OLD_SHA)], "", config, self.COMMITS, WRITERS
        )
        assert result == []

    def test_agents_excluded_and_unprivileged_commenters_are_ignored(self, config):
        comments = [
            approve("claude[bot]", OLD_SHA),
            approve("rubber-stamp[bot]", OLD_SHA),
            approve("mallory", OLD_SHA, association="CONTRIBUTOR"),
            approve("eve", OLD_SHA),  # no write permission
        ]
        assert self.stale(config, comments) == []


# --- collect_approval_reactions ---


class TestCollectApprovalReactions:
    def collect(self, config, comments, head_sha=HEAD_SHA, permission=WRITERS):
        batch = aac.MutationBatch()
        aac.collect_approval_reactions(batch, comments, head_sha, config, permission)
        return batch.reactions

    def test_valid_approve_gets_a_thumbs_up(self, config):
        assert self.collect(config, [approve("carol", comment_id=5)]) == [("IC_5", "THUMBS_UP")]

    def test_stale_approve_gets_no_reaction(self, config):
        assert self.collect(config, [approve("carol", OLD_SHA)]) == []

    def test_comment_without_node_id_is_skipped(self, config):
        assert self.collect(config, [approve("carol", node_id="")]) == []

    def test_empty_head_sha_adds_nothing(self, config):
        assert self.collect(config, [approve("carol")], head_sha="") == []

    def test_only_privileged_non_agent_commenters_react(self, config):
        comments = [
            approve("claude[bot]", comment_id=1),
            approve("rubber-stamp[bot]", comment_id=2),
            approve("mallory", association="CONTRIBUTOR", comment_id=3),
            approve("eve", comment_id=4),
            approve("carol", comment_id=5),
        ]
        assert self.collect(config, comments) == [("IC_5", "THUMBS_UP")]


# --- notification lookup ---


class TestNotificationLookup:
    NOTIF = make_comment("github-actions[bot]", f"{aac.COMMENT_MARKER}\nstatus", "NONE", comment_id=1)
    STALE_HEAD = make_comment(
        "github-actions[bot]", f"{aac.STALE_MARKER}\nhead is now `{HEAD_SHA[:12]}`", "NONE", comment_id=2
    )
    STALE_OLD = make_comment(
        "github-actions[bot]", f"{aac.STALE_MARKER}\nhead is now `{OLD_SHA[:12]}`", "NONE", comment_id=3
    )
    CHATTER = make_comment("alice", "nice work", "MEMBER", comment_id=4)
    EMPTY = make_comment("alice", None, "MEMBER", comment_id=5)

    def test_find_notification_comment_by_marker(self):
        comments = [self.CHATTER, self.EMPTY, self.STALE_HEAD, self.NOTIF]
        assert aac.find_notification_comment(comments) is self.NOTIF

    def test_find_notification_comment_returns_none_when_absent(self):
        assert aac.find_notification_comment([self.CHATTER, self.EMPTY, self.STALE_HEAD]) is None

    def test_find_stale_notification_for_commit(self):
        comments = [self.EMPTY, self.NOTIF, self.STALE_OLD, self.STALE_HEAD]
        assert aac.find_stale_notification_for_commit(comments, HEAD_SHA) is self.STALE_HEAD
        assert aac.find_stale_notification_for_commit(comments, OLD_SHA) is self.STALE_OLD
        assert aac.find_stale_notification_for_commit(comments, OLDER_SHA) is None

    def test_find_old_stale_notifications(self):
        comments = [self.EMPTY, self.NOTIF, self.STALE_OLD, self.STALE_HEAD]
        assert aac.find_old_stale_notifications(comments, HEAD_SHA) == [self.STALE_OLD]
        assert aac.find_old_stale_notifications(comments, OLDER_SHA) == [self.STALE_OLD, self.STALE_HEAD]


@pytest.mark.parametrize("marker", [aac.COMMENT_MARKER, aac.STALE_MARKER])
def test_markers_are_invisible_html_comments(marker):
    assert marker.startswith("<!--") and marker.endswith("-->")
