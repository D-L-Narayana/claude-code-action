// In-process fake of the subset of the GitHub REST and GraphQL API that the
// action touches while handling an `@claude` mention on an issue or pull
// request, or an automation prompt. The end-to-end harness points
// GITHUB_API_URL / GITHUB_GRAPHQL_URL at this server, records every request,
// and answers only the routes the orchestrator is expected to call. Anything
// else is answered with 404 AND recorded under `unexpected`, so a test can
// assert that the action made no foreign requests.
export type RecordedRequest = {
  method: string;
  path: string;
  body: unknown;
};

export type FakePullRequest = {
  headRefName: string;
  baseRefName: string;
  headSha: string;
  additions: number;
  deletions: number;
  files: Array<{
    path: string;
    additions: number;
    deletions: number;
    changeType: "ADDED" | "MODIFIED" | "DELETED";
  }>;
  reviewer: string;
  reviewBody: string;
  inlineCommentBody: string;
};

export type FakeGitHubOptions = {
  owner: string;
  repo: string;
  actor: string;
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  triggerCommentId: number;
  triggerCommentBody: string;
  triggerCreatedAt: string;
  earlierCommentBody: string;
  defaultBranch: string;
  headSha: string;
  createdCommentId: number;
  /** When set, the entity is a pull request and PR GraphQL queries are served. */
  pullRequest?: FakePullRequest;
};

export type StoredComment = { id: number; body: string };

export type FakeGitHub = {
  baseUrl: string;
  requests: RecordedRequest[];
  unexpected: RecordedRequest[];
  comments: Map<number, StoredComment>;
  stop: () => void;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const NO_MORE_PAGES = { hasNextPage: false, endCursor: null };

export function startFakeGitHub(options: FakeGitHubOptions): FakeGitHub {
  const requests: RecordedRequest[] = [];
  const unexpected: RecordedRequest[] = [];
  const comments = new Map<number, StoredComment>();
  let nextCommentId = options.createdCommentId;

  const repoPrefix = `/repos/${options.owner}/${options.repo}`;
  const repoPattern = escapeRegExp(repoPrefix);
  const htmlBase = `https://github.com/${options.owner}/${options.repo}`;

  const commentJson = (comment: StoredComment) => ({
    id: comment.id,
    node_id: `IC_${comment.id}`,
    body: comment.body,
    html_url: `${htmlBase}/issues/${options.issueNumber}#issuecomment-${comment.id}`,
    created_at: "2026-10-01T12:00:05Z",
    updated_at: new Date().toISOString(),
    user: { login: "claude[bot]", id: 209825114, type: "Bot" },
  });

  const commentNodes = () => ({
    pageInfo: NO_MORE_PAGES,
    nodes: [
      {
        id: "IC_900",
        databaseId: "900",
        body: options.earlierCommentBody,
        author: { __typename: "User", login: "teammate" },
        createdAt: "2026-10-01T11:00:00Z",
        updatedAt: "2026-10-01T11:00:00Z",
        lastEditedAt: null,
        isMinimized: false,
      },
      {
        id: `IC_${options.triggerCommentId}`,
        databaseId: String(options.triggerCommentId),
        body: options.triggerCommentBody,
        author: { __typename: "User", login: options.actor },
        createdAt: options.triggerCreatedAt,
        updatedAt: options.triggerCreatedAt,
        lastEditedAt: null,
        isMinimized: false,
      },
    ],
  });

  const issueNode = () => ({
    title: options.issueTitle,
    body: options.issueBody,
    author: { __typename: "User", login: options.actor },
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: options.triggerCreatedAt,
    lastEditedAt: null,
    state: "OPEN",
    labels: { nodes: [] },
    comments: commentNodes(),
  });

  const pullRequestNode = (pr: FakePullRequest) => ({
    title: options.issueTitle,
    body: options.issueBody,
    author: { __typename: "User", login: options.actor },
    baseRefName: pr.baseRefName,
    headRefName: pr.headRefName,
    headRefOid: pr.headSha,
    isCrossRepository: false,
    headRepository: { owner: { login: options.owner }, name: options.repo },
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: options.triggerCreatedAt,
    lastEditedAt: null,
    additions: pr.additions,
    deletions: pr.deletions,
    state: "OPEN",
    labels: { nodes: [{ name: "documentation" }] },
    commits: {
      totalCount: 1,
      nodes: [
        {
          commit: {
            oid: pr.headSha,
            message: "docs: add setup section",
            author: { name: "Octo Cat", email: "octocat@example.com" },
          },
        },
      ],
    },
    files: { pageInfo: NO_MORE_PAGES, nodes: pr.files },
    comments: commentNodes(),
    reviews: {
      pageInfo: NO_MORE_PAGES,
      nodes: [
        {
          id: "PRR_1",
          databaseId: "5001",
          author: { __typename: "User", login: pr.reviewer },
          body: pr.reviewBody,
          state: "COMMENTED",
          submittedAt: "2026-10-01T11:30:00Z",
          updatedAt: "2026-10-01T11:30:00Z",
          lastEditedAt: null,
          comments: {
            pageInfo: NO_MORE_PAGES,
            nodes: [
              {
                id: "PRRC_1",
                databaseId: "7001",
                body: pr.inlineCommentBody,
                path: pr.files[0]?.path ?? "README.md",
                line: 1,
                diffHunk: "@@ -1 +1,3 @@\n # Demo\n+\n+## Setup",
                author: { __typename: "User", login: pr.reviewer },
                createdAt: "2026-10-01T11:30:00Z",
                updatedAt: "2026-10-01T11:30:00Z",
                lastEditedAt: null,
                isMinimized: false,
              },
            ],
          },
        },
      ],
    },
  });

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      // Octokit percent-encodes path parameters (`heads/main` arrives as
      // `heads%2Fmain`); compare against the decoded form.
      const path = decodeURIComponent(url.pathname);
      const method = request.method;

      let body: unknown = undefined;
      if (method === "POST" || method === "PATCH") {
        const text = await request.text();
        try {
          body = text ? JSON.parse(text) : undefined;
        } catch {
          body = text;
        }
      }
      requests.push({ method, path, body });

      if (method === "POST" && path === "/graphql") {
        const query = String((body as { query?: string })?.query ?? "");
        if (/\bissue\(number:/.test(query)) {
          return Response.json({
            data: { repository: { issue: issueNode() } },
          });
        }
        if (/\bpullRequest\(number:/.test(query) && options.pullRequest) {
          return Response.json({
            data: {
              repository: { pullRequest: pullRequestNode(options.pullRequest) },
            },
          });
        }
        if (/\buser\(login:/.test(query)) {
          return Response.json({ data: { user: { name: "Octo Cat" } } });
        }
        unexpected.push({ method, path, body });
        return Response.json({
          errors: [
            {
              message: `fake GitHub: unsupported GraphQL query: ${query.slice(0, 80)}`,
            },
          ],
        });
      }

      const collaborator = path.match(
        new RegExp(`^${repoPattern}/collaborators/([^/]+)/permission$`),
      );
      if (method === "GET" && collaborator) {
        return Response.json({
          permission: "admin",
          role_name: "admin",
          user: { login: collaborator[1] },
        });
      }

      const user = path.match(/^\/users\/([^/]+)$/);
      if (method === "GET" && user) {
        return Response.json({ login: user[1], id: 583231, type: "User" });
      }

      if (method === "GET" && path === repoPrefix) {
        return Response.json({
          name: options.repo,
          full_name: `${options.owner}/${options.repo}`,
          default_branch: options.defaultBranch,
          owner: { login: options.owner },
        });
      }

      const ref = path.match(new RegExp(`^${repoPattern}/git/ref/(.+)$`));
      if (method === "GET" && ref) {
        if (ref[1] === `heads/${options.defaultBranch}`) {
          return Response.json({
            ref: `refs/heads/${options.defaultBranch}`,
            object: { sha: options.headSha, type: "commit" },
          });
        }
        return Response.json({ message: "Not Found" }, { status: 404 });
      }

      const branch = path.match(new RegExp(`^${repoPattern}/branches/(.+)$`));
      if (method === "GET" && branch) {
        // Claude's branch only exists locally in the harness; the cleanup step
        // treats a 404 here as "nothing was pushed".
        return Response.json({ message: "Branch not found" }, { status: 404 });
      }

      const compare = path.match(new RegExp(`^${repoPattern}/compare/(.+)$`));
      if (method === "GET" && compare) {
        // Nothing was pushed, so the working branch is identical to its base.
        return Response.json({
          status: "identical",
          ahead_by: 0,
          behind_by: 0,
          total_commits: 0,
          commits: [],
          files: [],
        });
      }

      if (
        method === "POST" &&
        path === `${repoPrefix}/issues/${options.issueNumber}/comments`
      ) {
        const comment: StoredComment = {
          id: nextCommentId++,
          body: String((body as { body?: string })?.body ?? ""),
        };
        comments.set(comment.id, comment);
        return Response.json(commentJson(comment), { status: 201 });
      }

      const commentRoute = path.match(
        new RegExp(`^${repoPattern}/issues/comments/(\\d+)$`),
      );
      if (commentRoute) {
        const existing = comments.get(Number(commentRoute[1]));
        if (!existing) {
          return Response.json({ message: "Not Found" }, { status: 404 });
        }
        if (method === "GET") {
          return Response.json(commentJson(existing));
        }
        if (method === "PATCH") {
          existing.body = String((body as { body?: string })?.body ?? "");
          return Response.json(commentJson(existing));
        }
      }

      unexpected.push({ method, path, body });
      return Response.json(
        { message: `fake GitHub: unexpected ${method} ${path}` },
        { status: 404 },
      );
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    requests,
    unexpected,
    comments,
    stop: () => {
      server.stop(true);
    },
  };
}
