// GraphQL queries for GitHub data
//
// Every list is a GraphQL connection capped at 100 nodes per request and
// returned oldest-first. The initial PR/issue queries therefore request
// `pageInfo` on each connection, and a dedicated follow-up query exists per
// connection so the fetcher can walk the cursor only when a page is actually
// full. A thread that fits in one page still costs a single request.

const PAGE_INFO = `pageInfo { hasNextPage endCursor }`;

// Field selections are shared between the initial and follow-up queries so a
// node looks the same no matter which page it arrived on.
const ISSUE_COMMENT_FIELDS = `
            id
            databaseId
            body
            author {
              __typename
              login
            }
            createdAt
            updatedAt
            lastEditedAt
            isMinimized`;

const REVIEW_COMMENT_FIELDS = `
                id
                databaseId
                body
                path
                line
                diffHunk
                author {
                  __typename
                  login
                }
                createdAt
                updatedAt
                lastEditedAt
                isMinimized`;

const FILE_FIELDS = `
            path
            additions
            deletions
            changeType`;

const REVIEW_FIELDS = `
            id
            databaseId
            author {
              __typename
              login
            }
            body
            state
            submittedAt
            updatedAt
            lastEditedAt
            comments(first: 100) {
              ${PAGE_INFO}
              nodes {${REVIEW_COMMENT_FIELDS}
              }
            }`;

export const PR_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        title
        body
        author {
          __typename
          login
        }
        baseRefName
        headRefName
        headRefOid
        isCrossRepository
        headRepository {
          owner {
            login
          }
          name
        }
        createdAt
        updatedAt
        lastEditedAt
        additions
        deletions
        state
        labels(first: 100) {
          nodes {
            name
          }
        }
        commits(first: 100) {
          totalCount
          nodes {
            commit {
              oid
              message
              author {
                name
                email
              }
            }
          }
        }
        files(first: 100) {
          ${PAGE_INFO}
          nodes {${FILE_FIELDS}
          }
        }
        comments(first: 100) {
          ${PAGE_INFO}
          nodes {${ISSUE_COMMENT_FIELDS}
          }
        }
        reviews(first: 100) {
          ${PAGE_INFO}
          nodes {${REVIEW_FIELDS}
          }
        }
      }
    }
  }
`;

export const PR_COMMENTS_PAGE_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!, $after: String!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        comments(first: 100, after: $after) {
          ${PAGE_INFO}
          nodes {${ISSUE_COMMENT_FIELDS}
          }
        }
      }
    }
  }
`;

export const PR_REVIEWS_PAGE_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!, $after: String!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviews(first: 100, after: $after) {
          ${PAGE_INFO}
          nodes {${REVIEW_FIELDS}
          }
        }
      }
    }
  }
`;

export const PR_FILES_PAGE_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!, $after: String!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        files(first: 100, after: $after) {
          ${PAGE_INFO}
          nodes {${FILE_FIELDS}
          }
        }
      }
    }
  }
`;

// Inline review comments are paginated per review, addressed by the review's
// node id, since they are nested inside the reviews connection.
export const REVIEW_COMMENTS_PAGE_QUERY = `
  query($reviewId: ID!, $after: String!) {
    node(id: $reviewId) {
      ... on PullRequestReview {
        comments(first: 100, after: $after) {
          ${PAGE_INFO}
          nodes {${REVIEW_COMMENT_FIELDS}
          }
        }
      }
    }
  }
`;

export const ISSUE_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        title
        body
        author {
          __typename
          login
        }
        createdAt
        updatedAt
        lastEditedAt
        state
        labels(first: 100) {
          nodes {
            name
          }
        }
        comments(first: 100) {
          ${PAGE_INFO}
          nodes {${ISSUE_COMMENT_FIELDS}
          }
        }
      }
    }
  }
`;

export const ISSUE_COMMENTS_PAGE_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!, $after: String!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        comments(first: 100, after: $after) {
          ${PAGE_INFO}
          nodes {${ISSUE_COMMENT_FIELDS}
          }
        }
      }
    }
  }
`;

export const USER_QUERY = `
  query($login: String!) {
    user(login: $login) {
      name
    }
  }
`;
