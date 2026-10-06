// Types for GitHub GraphQL query responses

// GitHub's GraphQL `author`/`actor` fields resolve to null when the underlying
// account has been deleted (the "ghost" user). Any field typed as
// `GitHubAuthor | null` can therefore be null at runtime and must be guarded.
// `__typename` distinguishes an App/bot actor from a human. GraphQL's
// `Actor.login` returns the bare name for bots ("dependabot"), unlike REST which
// appends a suffix ("dependabot[bot]"), so the typename is the only reliable bot
// signal on this data. See `resolveActorName` in `utils/actor-filter.ts`.
export type GitHubAuthor = {
  login: string;
  name?: string;
  __typename?: string;
};

// Cursor metadata on a GraphQL connection. GitHub returns connections
// oldest-first in pages of at most 100 nodes, so without following the cursor
// the newest comments/reviews/files on a long thread would be the ones lost.
// It is optional because a response from a query that did not ask for it
// carries none; the fetcher treats such a connection as complete.
export type GitHubPageInfo = {
  hasNextPage: boolean;
  endCursor: string | null;
};

export type GitHubConnection<TNode> = {
  nodes: TNode[];
  pageInfo?: GitHubPageInfo;
};

export type GitHubComment = {
  id: string;
  databaseId: string;
  body: string;
  author: GitHubAuthor | null;
  createdAt: string;
  updatedAt?: string;
  lastEditedAt?: string;
  isMinimized?: boolean;
};

export type GitHubReviewComment = GitHubComment & {
  path: string;
  line: number | null;
  diffHunk?: string | null;
};

export type GitHubCommit = {
  oid: string;
  message: string;
  author: {
    name: string;
    email: string;
  };
};

export type GitHubFile = {
  path: string;
  additions: number;
  deletions: number;
  changeType: string;
};

export type GitHubReview = {
  id: string;
  databaseId: string;
  author: GitHubAuthor | null;
  body: string;
  state: string;
  submittedAt: string;
  updatedAt?: string;
  lastEditedAt?: string;
  comments: GitHubConnection<GitHubReviewComment>;
};

export type GitHubPullRequest = {
  title: string;
  body: string;
  author: GitHubAuthor | null;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  isCrossRepository: boolean;
  headRepository: {
    owner: {
      login: string;
    };
    name: string;
  } | null;
  createdAt: string;
  updatedAt?: string;
  lastEditedAt?: string;
  additions: number;
  deletions: number;
  state: string;
  labels: {
    nodes: Array<{
      name: string;
    }>;
  };
  commits: {
    totalCount: number;
    nodes: Array<{
      commit: GitHubCommit;
    }>;
  };
  // GitHub's GraphQL `files` field resolves to null when the PR's diff is too
  // large for GitHub to compute (very large PRs). `changedFiles` is also
  // misreported as 0 in that case, so the null must be guarded and treated as
  // "file list unavailable" rather than "no files changed".
  files: GitHubConnection<GitHubFile> | null;
  comments: GitHubConnection<GitHubComment>;
  reviews: GitHubConnection<GitHubReview>;
};

export type GitHubIssue = {
  title: string;
  body: string;
  author: GitHubAuthor | null;
  createdAt: string;
  updatedAt?: string;
  lastEditedAt?: string;
  state: string;
  labels: {
    nodes: Array<{
      name: string;
    }>;
  };
  comments: GitHubConnection<GitHubComment>;
};

export type PullRequestQueryResponse = {
  repository: {
    pullRequest: GitHubPullRequest;
  };
};

export type IssueQueryResponse = {
  repository: {
    issue: GitHubIssue;
  };
};

// Responses of the follow-up queries that fetch one further page of a single
// connection (see `*_PAGE_QUERY` in `api/queries/github.ts`). The parent
// entity is null when it was deleted between the initial and follow-up calls.
export type PullRequestCommentsPageResponse = {
  repository: {
    pullRequest: { comments: GitHubConnection<GitHubComment> } | null;
  };
};

export type PullRequestReviewsPageResponse = {
  repository: {
    pullRequest: { reviews: GitHubConnection<GitHubReview> } | null;
  };
};

export type PullRequestFilesPageResponse = {
  repository: {
    pullRequest: { files: GitHubConnection<GitHubFile> | null } | null;
  };
};

export type IssueCommentsPageResponse = {
  repository: {
    issue: { comments: GitHubConnection<GitHubComment> } | null;
  };
};

export type ReviewCommentsPageResponse = {
  node: { comments: GitHubConnection<GitHubReviewComment> } | null;
};
