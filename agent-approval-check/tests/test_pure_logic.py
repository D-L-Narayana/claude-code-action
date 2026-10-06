"""Characterization tests for the pure, I/O-free helpers.

Expected behaviour comes from the function docstrings and the README, not from
the implementation; nothing here touches the network or the environment.
"""

from __future__ import annotations

import json
import logging
import re

import pytest

import agent_approval_check as aac
from tests.factories import (
    AGENT_EMAIL,
    HEAD_SHA,
    HUMAN_EMAIL,
    OLD_SHA,
    T1,
    T2,
    PermissionStub,
    make_comment,
    make_commit,
    make_pr_data,
    make_review,
)

LOGGER = "agent_approval_check"


# --- parse_approve_command ---


class TestParseApproveCommand:
    def test_accepts_full_40_hex_sha(self):
        assert aac.parse_approve_command(f"/approve {HEAD_SHA}") == HEAD_SHA

    def test_accepts_12_hex_prefix(self):
        assert aac.parse_approve_command(f"/approve {HEAD_SHA[:12]}") == HEAD_SHA[:12]

    def test_uppercase_hex_is_lowercased(self):
        assert aac.parse_approve_command(f"/approve {HEAD_SHA.upper()}") == HEAD_SHA

    def test_email_reply_quoting_below_first_line_is_accepted(self):
        body = (
            f"/approve {HEAD_SHA}\r\n\r\n"
            "On Mon, Jan 5, 2026 at 10:00, someone wrote:\r\n> please take a look"
        )
        assert aac.parse_approve_command(body) == HEAD_SHA

    def test_surrounding_whitespace_is_tolerated(self):
        assert aac.parse_approve_command(f"  /approve {HEAD_SHA}   \n") == HEAD_SHA

    def test_leading_blank_lines_are_skipped(self):
        # Blank lines carry no text, so the command is still the first thing a
        # reader sees; only *text* before the command is rejected (below).
        assert aac.parse_approve_command(f"\n\n/approve {HEAD_SHA}") == HEAD_SHA

    def test_leading_text_on_first_line_is_rejected(self):
        assert aac.parse_approve_command(f"LGTM /approve {HEAD_SHA}") is None

    def test_command_below_the_first_line_is_rejected(self):
        assert aac.parse_approve_command(f"LGTM\n/approve {HEAD_SHA}") is None

    def test_quoted_command_is_rejected(self):
        assert aac.parse_approve_command(f"> /approve {HEAD_SHA}") is None

    def test_extra_token_is_rejected(self):
        assert aac.parse_approve_command(f"/approve {HEAD_SHA} please") is None

    def test_11_hex_chars_is_rejected(self):
        assert aac.parse_approve_command(f"/approve {HEAD_SHA[:11]}") is None

    def test_41_hex_chars_is_rejected(self):
        assert aac.parse_approve_command(f"/approve {HEAD_SHA}0") is None

    def test_non_hex_token_is_rejected(self):
        assert aac.parse_approve_command("/approve zzzzzzzzzzzz") is None

    @pytest.mark.parametrize("body", [None, "", "   ", "/approve", "/approve "])
    def test_missing_body_or_sha_is_none(self, body):
        assert aac.parse_approve_command(body) is None


# --- sha_matches ---


class TestShaMatches:
    def test_full_sha_matches_itself(self):
        assert aac.sha_matches(HEAD_SHA, HEAD_SHA) is True

    def test_prefix_matches(self):
        assert aac.sha_matches(HEAD_SHA[:12], HEAD_SHA) is True

    def test_comparison_is_case_insensitive(self):
        assert aac.sha_matches(HEAD_SHA[:12].upper(), HEAD_SHA) is True
        assert aac.sha_matches(HEAD_SHA[:12], HEAD_SHA.upper()) is True

    def test_different_sha_does_not_match(self):
        assert aac.sha_matches(OLD_SHA[:12], HEAD_SHA) is False

    def test_suffix_is_not_a_prefix(self):
        assert aac.sha_matches(HEAD_SHA[-12:], HEAD_SHA) is False

    def test_longer_than_target_does_not_match(self):
        assert aac.sha_matches(HEAD_SHA + "0", HEAD_SHA) is False


# --- is_protected_base ---


class TestIsProtectedBase:
    def test_repo_without_entry_protects_only_the_default_branch(self, config):
        assert aac.is_protected_base("main", config, "other/repo", "main") is True
        assert aac.is_protected_base("develop", config, "other/repo", "main") is False

    def test_repo_without_entry_and_unknown_default_branch_is_true_with_warning(
        self, config, caplog
    ):
        with caplog.at_level(logging.WARNING, logger=LOGGER):
            assert aac.is_protected_base("anything", config, "other/repo", "") is True
        assert "default branch unknown" in caplog.text

    def test_exact_entry_matches(self, config):
        assert aac.is_protected_base("main", config, "o/r", "main") is True

    def test_prefix_entry_matches(self, config):
        assert aac.is_protected_base("release/1.2", config, "o/r", "main") is True

    def test_prefix_requires_the_full_prefix(self, config):
        assert aac.is_protected_base("release", config, "o/r", "main") is False

    def test_miss(self, config):
        assert aac.is_protected_base("feature/x", config, "o/r", "main") is False

    def test_entry_replaces_the_default_branch_fallback(self, config):
        # Documented: a repo with an entry uses it exclusively — the default
        # branch is not implicitly included.
        assert aac.is_protected_base("develop", config, "o/r", "develop") is False


# --- select_pr_candidate ---

CANDIDATES = json.dumps(
    [
        {"number": 11, "base": {"ref": "feature/x"}},
        {"number": 13, "base": {"ref": "main"}},
        {"number": 12, "base": {"ref": "release/2.0"}},
    ]
)


class TestSelectPrCandidate:
    @pytest.mark.parametrize("candidates", ["", "   \n"])
    def test_empty_candidates_keep_the_pr(self, config, candidates):
        assert aac.select_pr_candidate(11, candidates, config, "o/r") == 11

    def test_repo_without_protected_bases_keeps_the_pr(self, config):
        assert aac.select_pr_candidate(11, CANDIDATES, config, "other/repo") == 11

    def test_invalid_json_keeps_the_pr(self, config, caplog):
        with caplog.at_level(logging.WARNING, logger=LOGGER):
            assert aac.select_pr_candidate(11, "{not json", config, "o/r") == 11
        assert "not valid JSON" in caplog.text

    def test_non_list_json_keeps_the_pr(self, config):
        assert aac.select_pr_candidate(11, '{"number": 13}', config, "o/r") == 11

    def test_non_dict_entries_are_ignored(self, config):
        candidates = json.dumps([1, "x", None, {"number": 13, "base": {"ref": "main"}}])
        assert aac.select_pr_candidate(11, candidates, config, "o/r") == 13

    def test_non_int_numbers_are_ignored(self, config):
        candidates = json.dumps([{"number": "13", "base": {"ref": "main"}}])
        assert aac.select_pr_candidate(11, candidates, config, "o/r") == 11

    def test_missing_base_is_not_protected(self, config):
        assert aac.select_pr_candidate(11, json.dumps([{"number": 13}]), config, "o/r") == 11

    def test_pr_already_in_protected_set_is_kept(self, config):
        # 12 is a lower protected number, but 13 itself is protected.
        assert aac.select_pr_candidate(13, CANDIDATES, config, "o/r") == 13

    def test_sibling_selection_picks_lowest_protected_candidate(self, config):
        assert aac.select_pr_candidate(11, CANDIDATES, config, "o/r") == 12

    def test_no_protected_candidate_keeps_the_pr(self, config, caplog):
        candidates = json.dumps([{"number": 11, "base": {"ref": "feature/x"}}])
        with caplog.at_level(logging.WARNING, logger=LOGGER):
            assert aac.select_pr_candidate(11, candidates, config, "o/r") == 11
        assert "No workflow_run PR candidate" in caplog.text


# --- is_exempt_branch ---


class TestIsExemptBranch:
    def test_no_patterns_means_nothing_is_exempt(self, config):
        assert aac.is_exempt_branch("dependabot/npm/lodash", config) is False

    def test_glob_pattern_matches(self, config):
        config.exempt_head_branches = ["dependabot/*"]
        assert aac.is_exempt_branch("dependabot/npm/lodash", config) is True
        assert aac.is_exempt_branch("feature/dependabot", config) is False

    def test_literal_pattern_requires_exact_match(self, config):
        config.exempt_head_branches = ["trusted-bot"]
        assert aac.is_exempt_branch("trusted-bot", config) is True
        assert aac.is_exempt_branch("trusted-bot-2", config) is False


# --- is_review_exempt_pr ---


class TestIsReviewExemptPr:
    def test_no_prefixes_for_repo_is_not_exempt(self, config):
        pr = make_pr_data(files=["docs/a.md"])
        assert aac.is_review_exempt_pr(pr, config, "other/repo") is False

    def test_incomplete_file_list_is_not_exempt(self, config):
        pr = make_pr_data(files=["docs/a.md"], files_incomplete=True)
        assert aac.is_review_exempt_pr(pr, config, "o/r") is False

    def test_empty_file_list_is_not_exempt(self, config):
        pr = make_pr_data(files=[])
        assert aac.is_review_exempt_pr(pr, config, "o/r") is False

    def test_all_files_under_prefix_is_exempt(self, config):
        pr = make_pr_data(files=["docs/a.md", "docs/guide/b.md"])
        assert aac.is_review_exempt_pr(pr, config, "o/r") is True

    def test_one_file_outside_prefix_is_not_exempt(self, config):
        pr = make_pr_data(files=["docs/a.md", "src/app.py"])
        assert aac.is_review_exempt_pr(pr, config, "o/r") is False

    def test_prefix_match_is_literal(self, config):
        pr = make_pr_data(files=["docs2/a.md"])
        assert aac.is_review_exempt_pr(pr, config, "o/r") is False


# --- get_latest_review_per_user ---


class TestGetLatestReviewPerUser:
    def test_commented_reviews_are_ignored(self):
        reviews = [
            make_review("bob", "APPROVED", submitted_at=T1),
            make_review("bob", "COMMENTED", submitted_at=T2),
        ]
        assert aac.get_latest_review_per_user(reviews)["bob"]["state"] == "APPROVED"

    def test_only_commented_reviews_yield_no_entry(self):
        assert aac.get_latest_review_per_user([make_review("bob", "COMMENTED")]) == {}

    def test_dismissed_reviews_yield_no_entry(self):
        assert aac.get_latest_review_per_user([make_review("bob", "DISMISSED")]) == {}

    def test_changes_requested_after_approved_overrides(self):
        reviews = [
            make_review("bob", "APPROVED", submitted_at=T1),
            make_review("bob", "CHANGES_REQUESTED", submitted_at=T2),
        ]
        latest = aac.get_latest_review_per_user(reviews)
        assert latest["bob"]["state"] == "CHANGES_REQUESTED"

    def test_latest_is_chosen_by_timestamp_not_list_order(self):
        reviews = [
            make_review("bob", "APPROVED", submitted_at=T2),
            make_review("bob", "CHANGES_REQUESTED", submitted_at=T1),
        ]
        assert aac.get_latest_review_per_user(reviews)["bob"]["state"] == "APPROVED"

    def test_missing_login_is_skipped(self):
        reviews = [
            {"user": {}, "state": "APPROVED", "submitted_at": T1},
            {"user": {"login": None}, "state": "APPROVED", "submitted_at": T1},
            make_review("bob"),
        ]
        assert set(aac.get_latest_review_per_user(reviews)) == {"bob"}

    def test_users_are_tracked_independently(self):
        reviews = [make_review("bob", "APPROVED"), make_review("carol", "CHANGES_REQUESTED")]
        latest = aac.get_latest_review_per_user(reviews)
        assert latest["bob"]["state"] == "APPROVED"
        assert latest["carol"]["state"] == "CHANGES_REQUESTED"


# --- iter_approve_commands ---


class TestIterApproveCommands:
    def test_yields_approve_command_fields_with_lowercased_sha(self, config):
        comments = [
            make_comment("bob", f"/approve {HEAD_SHA[:12].upper()}", "OWNER", comment_id=8)
        ]
        commands = list(aac.iter_approve_commands(comments, config, PermissionStub(["bob"])))
        assert commands == [
            aac.ApproveCommand(commenter="bob", sha=HEAD_SHA[:12], comment_id=8, node_id="IC_8")
        ]

    def test_author_association_pre_filter_skips_without_permission_call(self, config):
        permission = PermissionStub(["carol"])
        comments = [make_comment("carol", f"/approve {HEAD_SHA}", "CONTRIBUTOR")]
        assert list(aac.iter_approve_commands(comments, config, permission)) == []
        assert permission.calls == []

    def test_agent_user_is_skipped(self, config):
        permission = PermissionStub(["claude[bot]"])
        comments = [make_comment("claude[bot]", f"/approve {HEAD_SHA}", "MEMBER")]
        assert list(aac.iter_approve_commands(comments, config, permission)) == []

    def test_excluded_approver_is_skipped(self, config):
        permission = PermissionStub(["rubber-stamp[bot]"])
        comments = [make_comment("rubber-stamp[bot]", f"/approve {HEAD_SHA}", "MEMBER")]
        assert list(aac.iter_approve_commands(comments, config, permission)) == []

    def test_permission_false_is_skipped(self, config):
        permission = PermissionStub({"dave": False})
        comments = [make_comment("dave", f"/approve {HEAD_SHA}", "MEMBER")]
        assert list(aac.iter_approve_commands(comments, config, permission)) == []
        assert permission.calls == ["dave"]

    def test_non_command_comments_never_trigger_a_permission_check(self, config):
        permission = PermissionStub(["erin"])
        comments = [make_comment("erin", "looks good to me", "MEMBER")]
        assert list(aac.iter_approve_commands(comments, config, permission)) == []
        assert permission.calls == []

    def test_missing_author_is_skipped(self, config):
        permission = PermissionStub([""])
        no_login = make_comment("", f"/approve {HEAD_SHA}", "MEMBER", comment_id=1)
        no_user = make_comment("ghost", f"/approve {HEAD_SHA}", "MEMBER", comment_id=2)
        no_user["user"] = {}  # deleted account: GraphQL returns a null author
        comments = [no_login, no_user]
        assert list(aac.iter_approve_commands(comments, config, permission)) == []
        assert permission.calls == []

    def test_mixed_stream_keeps_only_valid_commands(self, config):
        comments = [
            make_comment("bob", f"/approve {HEAD_SHA}", "MEMBER", comment_id=1),
            make_comment("carol", f"/approve {HEAD_SHA}", "CONTRIBUTOR", comment_id=2),
            make_comment("claude[bot]", f"/approve {HEAD_SHA}", "MEMBER", comment_id=3),
            make_comment("rubber-stamp[bot]", f"/approve {HEAD_SHA}", "MEMBER", comment_id=4),
            make_comment("dave", f"/approve {HEAD_SHA}", "MEMBER", comment_id=5),
            make_comment("erin", "looks good to me", "MEMBER", comment_id=6),
            make_comment("frank", f"/approve {OLD_SHA}", "COLLABORATOR", comment_id=7),
        ]
        permission = PermissionStub({"bob": True, "carol": True, "dave": False, "frank": True})
        commands = list(aac.iter_approve_commands(comments, config, permission))
        assert [(c.commenter, c.sha, c.comment_id) for c in commands] == [
            ("bob", HEAD_SHA, 1),
            ("frank", OLD_SHA, 7),
        ]
        # The REST permission check is the expensive step: only commenters that
        # survive every cheap filter and posted a real command reach it.
        assert permission.calls == ["bob", "dave", "frank"]


# --- identity helpers ---


class TestIdentityHelpers:
    @pytest.mark.parametrize(
        ("email", "expected"),
        [
            (AGENT_EMAIL, True),
            ("NOREPLY@ANTHROPIC.COM", True),
            (HUMAN_EMAIL, False),
            ("", False),
        ],
    )
    def test_is_agent_commit_is_case_insensitive(self, config, email, expected):
        assert aac.is_agent_commit(make_commit(HEAD_SHA, email), config) is expected

    def test_is_agent_commit_without_committer_data(self, config):
        assert aac.is_agent_commit({"sha": HEAD_SHA, "commit": {}}, config) is False
        assert aac.is_agent_commit({}, config) is False

    @pytest.mark.parametrize(
        ("login", "expected"),
        [
            ("claude[bot]", True),
            ("Claude[Bot]", True),
            ("CLAUDE-CODE[bot]", True),
            ("claude", False),
            ("alice", False),
        ],
    )
    def test_is_agent_user_is_case_insensitive(self, config, login, expected):
        assert aac.is_agent_user(login, config) is expected

    @pytest.mark.parametrize(
        ("login", "expected"),
        [
            ("rubber-stamp[bot]", True),
            ("RUBBER-STAMP[BOT]", True),
            ("claude[bot]", False),
            ("alice", False),
        ],
    )
    def test_is_excluded_approver_is_case_insensitive(self, config, login, expected):
        assert aac.is_excluded_approver(login, config) is expected

    @pytest.mark.parametrize(
        ("login", "expected"),
        [("claude-code[bot]", True), ("CLAUDE[BOT]", True), ("alice", False)],
    )
    def test_is_pr_created_by_agent_is_case_insensitive(self, config, login, expected):
        assert aac.is_pr_created_by_agent(login, config) is expected


# --- normalize_graphql_login ---


class TestNormalizeGraphqlLogin:
    def test_bot_gets_rest_style_suffix(self):
        assert aac.normalize_graphql_login({"__typename": "Bot", "login": "claude"}) == "claude[bot]"

    def test_bot_with_suffix_is_unchanged(self):
        author = {"__typename": "Bot", "login": "claude[bot]"}
        assert aac.normalize_graphql_login(author) == "claude[bot]"

    def test_user_is_unchanged(self):
        assert aac.normalize_graphql_login({"__typename": "User", "login": "alice"}) == "alice"

    def test_missing_author_is_empty_string(self):
        assert aac.normalize_graphql_login(None) == ""
        assert aac.normalize_graphql_login({}) == ""


# --- MutationBatch / MutationBuilder ---


class TestMutationBatch:
    def test_is_empty(self):
        assert aac.MutationBatch().is_empty() is True
        assert aac.MutationBatch(reactions=[("IC_1", "THUMBS_UP")]).is_empty() is False
        assert aac.MutationBatch(unminimize_comments=["IC_1"]).is_empty() is False


class TestMutationBuilder:
    def test_empty_builder_builds_nothing(self):
        assert aac.MutationBuilder().build() is None

    def test_reaction_aliases_are_unique_and_keyed_in_variables(self):
        builder = aac.MutationBuilder()
        builder.add_reaction("IC_1", "THUMBS_UP")
        builder.add_reaction("IC_2", "THUMBS_UP")
        mutation, variables = builder.build()
        assert variables == {
            "r1": {"subjectId": "IC_1", "content": "THUMBS_UP"},
            "r2": {"subjectId": "IC_2", "content": "THUMBS_UP"},
        }
        assert mutation.startswith("mutation M(")
        assert "$r1: AddReactionInput!" in mutation
        assert "r1: addReaction(input: $r1)" in mutation
        assert "r2: addReaction(input: $r2)" in mutation

    def test_minimize_and_unminimize_get_distinct_aliases(self):
        builder = aac.MutationBuilder()
        builder.minimize_comment("IC_1", "RESOLVED")
        builder.unminimize_comment("IC_2")
        mutation, variables = builder.build()
        (m_alias,) = [a for a in variables if a.startswith("m")]
        (u_alias,) = [a for a in variables if a.startswith("u")]
        assert m_alias != u_alias
        assert variables[m_alias] == {"subjectId": "IC_1", "classifier": "RESOLVED"}
        assert variables[u_alias] == {"subjectId": "IC_2"}
        assert f"{m_alias}: minimizeComment(input: ${m_alias})" in mutation
        assert f"{u_alias}: unminimizeComment(input: ${u_alias})" in mutation

    def test_combined_mutation_contains_every_operation(self):
        builder = aac.MutationBuilder()
        builder.add_reaction("IC_1", "THUMBS_UP")
        builder.add_comment("createNotif", "PR_node", "hello")
        builder.update_comment("updateNotif", "IC_9", "updated")
        builder.minimize_comment("IC_2", "OUTDATED")
        builder.unminimize_comment("IC_3")
        mutation, variables = builder.build()

        for operation in (
            "addReaction",
            "addComment",
            "updateIssueComment",
            "minimizeComment",
            "unminimizeComment",
        ):
            assert operation in mutation
        assert variables["createNotif"] == {"subjectId": "PR_node", "body": "hello"}
        assert variables["updateNotif"] == {"id": "IC_9", "body": "updated"}

        # Every aliased operation uses a variable of the same name, declared in
        # the operation signature and present in the variables payload.
        pairs = re.findall(r"(\w+): \w+\(input: \$(\w+)\)", mutation)
        aliases = [alias for alias, _ in pairs]
        assert len(pairs) == 5
        assert all(alias == var for alias, var in pairs)
        assert len(set(aliases)) == 5
        assert set(aliases) == set(variables)
        for alias in aliases:
            assert f"${alias}: " in mutation


# --- status description / detection reason ---


class TestFormatStatusDescription:
    def test_short_message_gets_sha_suffix(self):
        assert (
            aac.format_status_description("No agent activity", HEAD_SHA)
            == "No agent activity [0123456789ab]"
        )

    def test_long_message_is_clamped_to_github_limit(self):
        out = aac.format_status_description("x" * 300, HEAD_SHA)
        assert len(out) == 140
        assert out.endswith(" [0123456789ab]")
        assert "…" in out

    def test_message_exactly_at_limit_is_not_truncated(self):
        message = "y" * 125
        out = aac.format_status_description(message, HEAD_SHA)
        assert out == f"{message} [0123456789ab]"
        assert len(out) == 140


class TestGetDetectionReason:
    def test_names_commit_and_email(self, config):
        commit = make_commit(HEAD_SHA, AGENT_EMAIL)
        assert (
            aac.get_detection_reason(commit, config)
            == f"Commit {HEAD_SHA[:12]} has agent email ({AGENT_EMAIL})"
        )

    def test_email_match_is_case_insensitive(self, config):
        commit = make_commit(HEAD_SHA, "NoReply@Anthropic.com")
        assert "NoReply@Anthropic.com" in aac.get_detection_reason(commit, config)

    def test_non_agent_commit_is_rejected(self, config):
        with pytest.raises(AssertionError):
            aac.get_detection_reason(make_commit(HEAD_SHA, HUMAN_EMAIL), config)
