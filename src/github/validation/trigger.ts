#!/usr/bin/env bun

import type { IssuesLabeledEvent } from "@octokit/webhooks-types";
import {
  isIssuesEvent,
  isIssuesAssignedEvent,
  isIssueCommentEvent,
  isPullRequestEvent,
  isPullRequestReviewEvent,
  isPullRequestReviewCommentEvent,
} from "../context";
import type { ParsedGitHubContext } from "../context";

export function checkContainsTrigger(context: ParsedGitHubContext): boolean {
  const {
    inputs: { assigneeTrigger, labelTrigger, triggerPhrase, prompt },
  } = context;

  // If prompt is provided, always trigger
  if (prompt) {
    console.log(`Prompt provided, triggering action`);
    return true;
  }

  // Check for assignee trigger
  if (isIssuesAssignedEvent(context)) {
    // Remove @ symbol from assignee_trigger if present
    let triggerUser = assigneeTrigger.replace(/^@/, "");
    const assigneeUsername = context.payload.assignee?.login || "";

    if (triggerUser && assigneeUsername === triggerUser) {
      console.log(`Issue assigned to trigger user '${triggerUser}'`);
      return true;
    }
  }

  // Check for label trigger
  if (isIssuesEvent(context) && context.eventAction === "labeled") {
    // eventAction has already established which member of the IssuesEvent
    // union this payload is; the cast only makes the `label` field visible.
    const labelName = (context.payload as IssuesLabeledEvent).label?.name || "";

    if (
      labelTrigger &&
      labelName.toLowerCase() === labelTrigger.toLowerCase()
    ) {
      console.log(`Issue labeled with trigger label '${labelTrigger}'`);
      return true;
    }
  }

  // The same exact-match rule applies to every text field below, so build the
  // pattern once. It has no `g` flag, which keeps repeated test() calls
  // stateless.
  const triggerRegex = buildTriggerRegex(triggerPhrase);

  // Check for issue body and title trigger on issue creation
  if (isIssuesEvent(context) && context.eventAction === "opened") {
    const issueBody = context.payload.issue.body || "";
    const issueTitle = context.payload.issue.title || "";

    // Check in body
    if (triggerRegex.test(issueBody)) {
      console.log(
        `Issue body contains exact trigger phrase '${triggerPhrase}'`,
      );
      return true;
    }

    // Check in title
    if (triggerRegex.test(issueTitle)) {
      console.log(
        `Issue title contains exact trigger phrase '${triggerPhrase}'`,
      );
      return true;
    }
  }

  // Check for pull request body and title trigger
  if (isPullRequestEvent(context)) {
    const prBody = context.payload.pull_request.body || "";
    const prTitle = context.payload.pull_request.title || "";

    // Check in body
    if (triggerRegex.test(prBody)) {
      console.log(
        `Pull request body contains exact trigger phrase '${triggerPhrase}'`,
      );
      return true;
    }

    // Check in title
    if (triggerRegex.test(prTitle)) {
      console.log(
        `Pull request title contains exact trigger phrase '${triggerPhrase}'`,
      );
      return true;
    }
  }

  // Check for pull request review body trigger
  if (
    isPullRequestReviewEvent(context) &&
    (context.eventAction === "submitted" || context.eventAction === "edited")
  ) {
    const reviewBody = context.payload.review.body || "";
    if (triggerRegex.test(reviewBody)) {
      console.log(
        `Pull request review contains exact trigger phrase '${triggerPhrase}'`,
      );
      return true;
    }
  }

  // Check for comment trigger
  if (
    isIssueCommentEvent(context) ||
    isPullRequestReviewCommentEvent(context)
  ) {
    const commentBody = isIssueCommentEvent(context)
      ? context.payload.comment.body
      : context.payload.comment.body;
    if (triggerRegex.test(commentBody)) {
      console.log(`Comment contains exact trigger phrase '${triggerPhrase}'`);
      return true;
    }
  }

  console.log(`No trigger was met for ${triggerPhrase}`);

  return false;
}

export function escapeRegExp(string: string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the exact-match pattern for the trigger phrase: the phrase must be
 * preceded by start-of-text or whitespace and followed by whitespace,
 * sentence punctuation or end-of-text. This is what keeps "@claude-bot",
 * "email@claude.ai" and "claudette" from triggering while "hi @claude!" and
 * "@claude: fix this" do. Matching is case-insensitive.
 */
export function buildTriggerRegex(triggerPhrase: string): RegExp {
  return new RegExp(
    `(^|\\s)${escapeRegExp(triggerPhrase)}([\\s.,!?;:]|$)`,
    "i",
  );
}
