#!/usr/bin/env bun

import { describe, expect, it, mock, spyOn, test } from "bun:test";
import type { Octokits } from "../src/github/api/client";
import {
  ISSUE_COMMENTS_PAGE_QUERY,
  ISSUE_QUERY,
  PR_COMMENTS_PAGE_QUERY,
  PR_FILES_PAGE_QUERY,
  PR_QUERY,
  PR_REVIEWS_PAGE_QUERY,
  REVIEW_COMMENTS_PAGE_QUERY,
} from "../src/github/api/queries/github";
import { fetchGitHubData } from "../src/github/data/fetcher";
import type {
  GitHubComment,
  GitHubFile,
  GitHubReview,
  GitHubReviewComment,
} from "../src/github/types";

// Mirrors the per-connection page cap in src/github/data/fetcher.ts: pages of
// 100 nodes, at most 5 of them, after which the fetcher stops and warns.
const MAX_PAGES = 5;
const PAGE_SIZE = 100;

type GraphqlVariables = Record<string, unknown>;
type GraphqlFake = (
  query: string,
  variables: GraphqlVariables,
) => Promise<unknown>;

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start }, (_, i) => start + i);
}

function makeComment(index: number): GitHubComment {
  return {
    id: `comment-${index}`,
    databaseId: String(1_000 + index),
    body: `Comment ${index}`,
    author: { login: `user${index % 7}` },
    createdAt: new Date(Date.UTC(2024, 0, 1, 0, 0, index)).toISOString(),
  };
}

function makeReviewComment(index: number): GitHubReviewComment {
  return {
    ...makeComment(index),
    id: `review-comment-${index}`,
    path: `src/file-${index}.ts`,
    line: index + 1,
    diffHunk: `@@ -${index},1 +${index},1 @@`,
  };
}

function makeReview(index: number): GitHubReview {
  return {
    id: `review-${index}`,
    databaseId: String(5_000 + index),
    author: { login: `reviewer${index % 5}` },
    body: `Review ${index}`,
    state: "COMMENTED",
    submittedAt: new Date(Date.UTC(2024, 0, 2, 0, 0, index)).toISOString(),
    comments: { nodes: [] },
  };
}

// DELETED files skip the `git hash-object` SHA lookup, which would otherwise
// run against paths that do not exist in this test checkout.
function makeFile(index: number): GitHubFile {
  return {
    path: `src/file-${index}.ts`,
    additions: 0,
    deletions: 3,
    changeType: "DELETED",
  };
}

function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    title: "Long-running PR",
    body: "PR body",
    author: { login: "author" },
    baseRefName: "main",
    headRefName: "feature",
    headRefOid: "abc123",
    isCrossRepository: false,
    headRepository: { owner: { login: "test-owner" }, name: "test-repo" },
    createdAt: "2024-01-01T00:00:00Z",
    additions: 0,
    deletions: 3,
    state: "OPEN",
    labels: { nodes: [] },
    commits: { totalCount: 1, nodes: [] },
    files: { nodes: [] },
    comments: { nodes: [] },
    reviews: { nodes: [] },
    ...overrides,
  };
}

function issue(overrides: Record<string, unknown> = {}) {
  return {
    title: "Long-running issue",
    body: "Issue body",
    author: { login: "author" },
    createdAt: "2024-01-01T00:00:00Z",
    state: "OPEN",
    labels: { nodes: [] },
    comments: { nodes: [] },
    ...overrides,
  };
}

// Only the GraphQL client is exercised: no fixture comment carries an image,
// so the REST client is never touched.
function octokitsWith(graphql: GraphqlFake): Octokits {
  return { graphql, rest: {} } as unknown as Octokits;
}

function fetchPr(graphql: GraphqlFake, triggerTime?: string) {
  return fetchGitHubData({
    octokits: octokitsWith(graphql),
    repository: "test-owner/test-repo",
    prNumber: "42",
    isPR: true,
    triggerTime,
  });
}

function fetchIssue(graphql: GraphqlFake, triggerTime?: string) {
  return fetchGitHubData({
    octokits: octokitsWith(graphql),
    repository: "test-owner/test-repo",
    prNumber: "7",
    isPR: false,
    triggerTime,
  });
}

// The queries are assembled from shared fragments, so a syntax slip would
// only surface as a GitHub 4xx at runtime. No GraphQL parser is available
// here; these structural checks catch unbalanced fragments and unused or
// undeclared variables.
describe("GraphQL query documents", () => {
  const queries = {
    PR_QUERY,
    ISSUE_QUERY,
    PR_COMMENTS_PAGE_QUERY,
    PR_REVIEWS_PAGE_QUERY,
    PR_FILES_PAGE_QUERY,
    REVIEW_COMMENTS_PAGE_QUERY,
    ISSUE_COMMENTS_PAGE_QUERY,
  };
  const pageQueries = [
    PR_COMMENTS_PAGE_QUERY,
    PR_REVIEWS_PAGE_QUERY,
    PR_FILES_PAGE_QUERY,
    REVIEW_COMMENTS_PAGE_QUERY,
    ISSUE_COMMENTS_PAGE_QUERY,
  ];
  const count = (text: string, token: string) => text.split(token).length - 1;

  test.each(Object.entries(queries))(
    "%s has balanced braces and uses every declared variable",
    (_name, query) => {
      expect(count(query, "{")).toBe(count(query, "}"));
      expect(count(query, "(")).toBe(count(query, ")"));

      const declared = [...query.matchAll(/\$(\w+):/g)].map((m) => m[1]);
      expect(declared.length).toBeGreaterThan(0);
      for (const variable of declared) {
        // Declaration plus at least one use.
        expect(count(query, `$${variable}`)).toBeGreaterThanOrEqual(2);
      }
      const used = [...query.matchAll(/\$(\w+)\b/g)].map((m) => m[1]);
      for (const variable of used) {
        expect(declared).toContain(variable);
      }
    },
  );

  test("initial queries request pageInfo on every paginated connection", () => {
    // PR: files, comments, reviews and the nested review comments.
    expect(count(PR_QUERY, "pageInfo")).toBe(4);
    expect(count(ISSUE_QUERY, "pageInfo")).toBe(1);
    expect(PR_QUERY).not.toContain("after:");
    expect(ISSUE_QUERY).not.toContain("after:");
  });

  test("follow-up queries page by cursor with the same page size", () => {
    for (const query of pageQueries) {
      expect(query).toContain("$after: String!");
      expect(count(query, "(first: 100, after: $after)")).toBe(1);
      // Each follow-up fetches exactly one connection's next page.
      expect(count(query, "pageInfo")).toBe(
        query === PR_REVIEWS_PAGE_QUERY ? 2 : 1,
      );
    }
  });
});

describe("GraphQL cursor pagination", () => {
  describe("pull request comments", () => {
    it("follows pageInfo.endCursor and returns every comment in order", async () => {
      const graphql = mock(
        async (_query: string, variables: GraphqlVariables) => {
          if (variables.after === undefined) {
            return {
              repository: {
                pullRequest: pullRequest({
                  comments: {
                    nodes: range(0, PAGE_SIZE).map(makeComment),
                    pageInfo: { hasNextPage: true, endCursor: "c1" },
                  },
                }),
              },
            };
          }
          return {
            repository: {
              pullRequest: {
                comments: {
                  nodes: range(PAGE_SIZE, 150).map(makeComment),
                  pageInfo: { hasNextPage: false, endCursor: "c2" },
                },
              },
            },
          };
        },
      );

      const result = await fetchPr(graphql);

      expect(result.comments).toHaveLength(150);
      expect(result.comments.map((c) => c.id)).toEqual(
        range(0, 150).map((i) => `comment-${i}`),
      );
      expect(graphql).toHaveBeenCalledTimes(2);
      // Without pageInfo in the first request there is no cursor to follow.
      expect(graphql.mock.calls[0]?.[0]).toContain("pageInfo");
      expect(graphql.mock.calls[1]?.[0]).toContain("after: $after");
      expect(graphql.mock.calls[1]?.[1]).toEqual({
        owner: "test-owner",
        repo: "test-repo",
        number: 42,
        after: "c1",
      });
    });

    it("stops after MAX_PAGES pages and warns when more pages remain", async () => {
      let served = 0;
      const graphql = mock(
        async (_query: string, variables: GraphqlVariables) => {
          const start = served * PAGE_SIZE;
          served += 1;
          const comments = {
            nodes: range(start, start + PAGE_SIZE).map(makeComment),
            pageInfo: { hasNextPage: true, endCursor: `c${served}` },
          };
          return variables.after === undefined
            ? { repository: { pullRequest: pullRequest({ comments }) } }
            : { repository: { pullRequest: { comments } } };
        },
      );
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

      try {
        const result = await fetchPr(graphql);

        expect(graphql).toHaveBeenCalledTimes(MAX_PAGES);
        expect(
          graphql.mock.calls.slice(1).map((call) => call[1].after),
        ).toEqual(["c1", "c2", "c3", "c4"]);
        expect(result.comments).toHaveLength(MAX_PAGES * PAGE_SIZE);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining(`after ${MAX_PAGES} pages`),
        );
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("PR #42 comments"),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("continues with the pages already fetched when a follow-up page fails", async () => {
      const graphql = mock(
        async (_query: string, variables: GraphqlVariables) => {
          if (variables.after === undefined) {
            return {
              repository: {
                pullRequest: pullRequest({
                  comments: {
                    nodes: range(0, PAGE_SIZE).map(makeComment),
                    pageInfo: { hasNextPage: true, endCursor: "c1" },
                  },
                }),
              },
            };
          }
          throw new Error("secondary rate limit");
        },
      );
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

      try {
        const result = await fetchPr(graphql);

        expect(result.comments).toHaveLength(PAGE_SIZE);
        expect(graphql.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("PR #42 comments"),
          expect.anything(),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("makes a single request when the connection has no pageInfo (legacy shape)", async () => {
      const graphql = mock(async () => ({
        repository: {
          pullRequest: pullRequest({ comments: { nodes: [makeComment(0)] } }),
        },
      }));

      const result = await fetchPr(graphql);

      expect(result.comments).toHaveLength(1);
      expect(graphql).toHaveBeenCalledTimes(1);
    });

    it("makes a single request when hasNextPage is false", async () => {
      const graphql = mock(async () => ({
        repository: {
          pullRequest: pullRequest({
            comments: {
              nodes: range(0, 3).map(makeComment),
              pageInfo: { hasNextPage: false, endCursor: "c1" },
            },
          }),
        },
      }));

      const result = await fetchPr(graphql);

      expect(result.comments).toHaveLength(3);
      expect(graphql).toHaveBeenCalledTimes(1);
    });
  });

  describe("pull request reviews", () => {
    it("follows the reviews cursor and keeps submission order", async () => {
      const graphql = mock(
        async (_query: string, variables: GraphqlVariables) => {
          if (variables.after === undefined) {
            return {
              repository: {
                pullRequest: pullRequest({
                  reviews: {
                    nodes: range(0, PAGE_SIZE).map(makeReview),
                    pageInfo: { hasNextPage: true, endCursor: "r1" },
                  },
                }),
              },
            };
          }
          return {
            repository: {
              pullRequest: {
                reviews: {
                  nodes: range(PAGE_SIZE, 130).map(makeReview),
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          };
        },
      );

      const result = await fetchPr(graphql);

      expect(result.reviewData?.nodes.map((r) => r.id)).toEqual(
        range(0, 130).map((i) => `review-${i}`),
      );
      expect(graphql).toHaveBeenCalledTimes(2);
      expect(graphql.mock.calls[1]?.[0]).toContain("reviews(");
      expect(graphql.mock.calls[1]?.[0]).toContain("after: $after");
      expect(graphql.mock.calls[1]?.[1]).toEqual({
        owner: "test-owner",
        repo: "test-repo",
        number: 42,
        after: "r1",
      });
    });

    it("follows the cursor of a single review's inline comments", async () => {
      const review = {
        ...makeReview(0),
        comments: {
          nodes: range(0, PAGE_SIZE).map(makeReviewComment),
          pageInfo: { hasNextPage: true, endCursor: "rc1" },
        },
      };
      const graphql = mock(
        async (_query: string, variables: GraphqlVariables) => {
          if (variables.after === undefined) {
            return {
              repository: {
                pullRequest: pullRequest({ reviews: { nodes: [review] } }),
              },
            };
          }
          return {
            node: {
              comments: {
                nodes: range(PAGE_SIZE, 120).map(makeReviewComment),
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          };
        },
      );

      const result = await fetchPr(graphql);

      expect(result.reviewData?.nodes).toHaveLength(1);
      expect(
        result.reviewData?.nodes[0]?.comments.nodes.map((c) => c.id),
      ).toEqual(range(0, 120).map((i) => `review-comment-${i}`));
      expect(graphql).toHaveBeenCalledTimes(2);
      expect(graphql.mock.calls[1]?.[0]).toContain("node(id: $reviewId)");
      expect(graphql.mock.calls[1]?.[1]).toEqual({
        reviewId: "review-0",
        after: "rc1",
      });
    });
  });

  describe("pull request files", () => {
    it("follows the files cursor so large PRs list every changed file", async () => {
      const graphql = mock(
        async (_query: string, variables: GraphqlVariables) => {
          if (variables.after === undefined) {
            return {
              repository: {
                pullRequest: pullRequest({
                  files: {
                    nodes: range(0, PAGE_SIZE).map(makeFile),
                    pageInfo: { hasNextPage: true, endCursor: "f1" },
                  },
                }),
              },
            };
          }
          return {
            repository: {
              pullRequest: {
                files: {
                  nodes: range(PAGE_SIZE, 150).map(makeFile),
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          };
        },
      );

      const result = await fetchPr(graphql);

      expect(result.changedFiles.map((f) => f.path)).toEqual(
        range(0, 150).map((i) => `src/file-${i}.ts`),
      );
      expect(result.changedFilesWithSHA).toHaveLength(150);
      expect(result.changedFilesWithSHA.every((f) => f.sha === "deleted")).toBe(
        true,
      );
      expect(graphql).toHaveBeenCalledTimes(2);
      expect(graphql.mock.calls[1]?.[0]).toContain("files(");
      expect(graphql.mock.calls[1]?.[1]).toEqual({
        owner: "test-owner",
        repo: "test-repo",
        number: 42,
        after: "f1",
      });
    });

    it("does not paginate when GitHub returns files: null (diff too large)", async () => {
      const graphql = mock(async () => ({
        repository: { pullRequest: pullRequest({ files: null }) },
      }));
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

      try {
        const result = await fetchPr(graphql);

        expect(result.changedFiles).toEqual([]);
        expect(graphql).toHaveBeenCalledTimes(1);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe("issue comments", () => {
    it("follows the issue comments cursor and returns every comment in order", async () => {
      const graphql = mock(
        async (_query: string, variables: GraphqlVariables) => {
          if (variables.after === undefined) {
            return {
              repository: {
                issue: issue({
                  comments: {
                    nodes: range(0, PAGE_SIZE).map(makeComment),
                    pageInfo: { hasNextPage: true, endCursor: "i1" },
                  },
                }),
              },
            };
          }
          return {
            repository: {
              issue: {
                comments: {
                  nodes: range(PAGE_SIZE, 150).map(makeComment),
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          };
        },
      );

      const result = await fetchIssue(graphql);

      expect(result.comments.map((c) => c.id)).toEqual(
        range(0, 150).map((i) => `comment-${i}`),
      );
      expect(graphql).toHaveBeenCalledTimes(2);
      expect(graphql.mock.calls[0]?.[0]).toContain("pageInfo");
      expect(graphql.mock.calls[1]?.[0]).toContain("issue(");
      expect(graphql.mock.calls[1]?.[1]).toEqual({
        owner: "test-owner",
        repo: "test-repo",
        number: 7,
        after: "i1",
      });
    });

    it("applies the trigger-time filter to comments from every page", async () => {
      const graphql = mock(
        async (_query: string, variables: GraphqlVariables) => {
          if (variables.after === undefined) {
            return {
              repository: {
                issue: issue({
                  comments: {
                    nodes: range(0, PAGE_SIZE).map(makeComment),
                    pageInfo: { hasNextPage: true, endCursor: "i1" },
                  },
                }),
              },
            };
          }
          return {
            repository: {
              issue: {
                comments: {
                  nodes: range(PAGE_SIZE, 150).map(makeComment),
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          };
        },
      );

      // Comment N is created at second N, so a trigger at 00:02:00 keeps
      // comments 0..119: all of page one and the first 20 of page two.
      const result = await fetchIssue(graphql, "2024-01-01T00:02:00Z");

      expect(result.comments).toHaveLength(120);
      expect(result.comments[119]?.id).toBe("comment-119");
    });
  });
});
