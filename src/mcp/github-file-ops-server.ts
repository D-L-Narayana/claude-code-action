#!/usr/bin/env node
// GitHub File Operations MCP Server
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile, stat } from "fs/promises";
import { resolve } from "path";
import { constants } from "fs";
import { validatePathWithinRepo } from "./path-validation";
import { updateGitReference } from "./update-git-reference";
import {
  buildTreeEntry,
  createCommit,
  createTree,
  getBaseTreeSha,
  getOrCreateBranchRef,
  type GitHubTreeEntry,
} from "./github-file-ops-api";
import {
  commitFilesInputSchema,
  deleteFilesInputSchema,
} from "./github-file-ops-schemas";

// Get repository information from environment variables
const REPO_OWNER = process.env.REPO_OWNER;
const REPO_NAME = process.env.REPO_NAME;
const BRANCH_NAME = process.env.BRANCH_NAME;
// Only required when BRANCH_NAME has to be created; getOrCreateBranchRef
// reports its absence explicitly instead of forking from an undefined ref.
const BASE_BRANCH = process.env.BASE_BRANCH;
const REPO_DIR = process.env.REPO_DIR || process.cwd();

if (!REPO_OWNER || !REPO_NAME || !BRANCH_NAME) {
  console.error(
    "Error: REPO_OWNER, REPO_NAME, and BRANCH_NAME environment variables are required",
  );
  process.exit(1);
}

const server = new McpServer({
  name: "GitHub File Operations Server",
  version: "0.0.1",
});

// Get the appropriate Git file mode for a file
async function getFileMode(filePath: string): Promise<string> {
  try {
    const fileStat = await stat(filePath);
    if (fileStat.isFile()) {
      // Check if execute bit is set for user
      if (fileStat.mode & constants.S_IXUSR) {
        return "100755"; // Executable file
      } else {
        return "100644"; // Regular file
      }
    } else if (fileStat.isDirectory()) {
      return "040000"; // Directory (tree)
    } else if (fileStat.isSymbolicLink()) {
      return "120000"; // Symbolic link
    } else {
      // Fallback for unknown file types
      return "100644";
    }
  } catch (error) {
    // If we can't stat the file, default to regular file
    console.warn(
      `Could not determine file mode for ${filePath}, using default: ${error}`,
    );
    return "100644";
  }
}

// Repo-relative path for the git tree entry. Uses the original (normalized)
// filePath rather than the symlink-resolved one so the tree records the path
// the caller asked for.
function toRepoRelativePath(filePath: string): string {
  const resolvedRepoDir = resolve(REPO_DIR);
  return resolve(resolvedRepoDir, filePath).slice(resolvedRepoDir.length + 1);
}

type BranchTarget = {
  owner: string;
  repo: string;
  branch: string;
  githubToken: string;
};

type BranchHead = { baseSha: string; baseTreeSha: string };

// Resolve (or create) the branch and the tree its next commit builds on.
async function resolveBranchHead(target: BranchTarget): Promise<BranchHead> {
  const baseSha = await getOrCreateBranchRef({
    ...target,
    baseBranch: BASE_BRANCH,
  });
  const baseTreeSha = await getBaseTreeSha({ ...target, commitSha: baseSha });
  return { baseSha, baseTreeSha };
}

// Create the tree and commit, then move the branch to the new commit.
async function commitTreeEntries(
  target: BranchTarget,
  head: BranchHead,
  entries: GitHubTreeEntry[],
  message: string,
) {
  const treeSha = await createTree({
    ...target,
    baseTreeSha: head.baseTreeSha,
    entries,
  });
  const commit = await createCommit({
    ...target,
    message,
    treeSha,
    parentSha: head.baseSha,
  });
  await updateGitReference({ ...target, sha: commit.sha });
  return {
    commit: {
      sha: commit.sha,
      message: commit.message,
      author: commit.author.name,
      date: commit.author.date,
    },
    tree: { sha: treeSha },
  };
}

function errorResult(error: unknown) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  return {
    content: [
      {
        type: "text" as const,
        text: `Error: ${errorMessage}`,
      },
    ],
    error: errorMessage,
    isError: true,
  };
}

// Commit files tool
server.tool(
  "commit_files",
  "Commit one or more files to a repository in a single commit (this will commit them atomically in the remote repository)",
  commitFilesInputSchema,
  async ({ files, message }) => {
    const owner = REPO_OWNER;
    const repo = REPO_NAME;
    const branch = BRANCH_NAME;
    try {
      const githubToken = process.env.GITHUB_TOKEN;
      if (!githubToken) {
        throw new Error("GITHUB_TOKEN environment variable is required");
      }
      const target: BranchTarget = { owner, repo, branch, githubToken };

      // Validate all paths are within repository root and get full/relative paths
      const validatedFiles = await Promise.all(
        files.map(async (filePath) => {
          const fullPath = await validatePathWithinRepo(filePath, REPO_DIR);
          return { fullPath, relativePath: toRepoRelativePath(filePath) };
        }),
      );

      // 1. Get the branch reference (create if doesn't exist) and base tree
      const head = await resolveBranchHead(target);

      // 2. Create tree entries for all files. Binary content (detected by
      // inspecting the bytes, not the extension) is uploaded as a blob so it
      // is not corrupted by a UTF-8 decode; text is inlined.
      const treeEntries = await Promise.all(
        validatedFiles.map(async ({ fullPath, relativePath }) =>
          buildTreeEntry({
            ...target,
            path: relativePath,
            mode: await getFileMode(fullPath),
            content: await readFile(fullPath),
          }),
        ),
      );

      // 3. Create the tree and commit, then update the branch reference
      const result = await commitTreeEntries(
        target,
        head,
        treeEntries,
        message,
      );

      const simplifiedResult = {
        commit: result.commit,
        files: validatedFiles.map(({ relativePath }) => ({
          path: relativePath,
        })),
        tree: result.tree,
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(simplifiedResult, null, 2),
          },
        ],
      };
    } catch (error) {
      return errorResult(error);
    }
  },
);

// Delete files tool
server.tool(
  "delete_files",
  "Delete one or more files from a repository in a single commit",
  deleteFilesInputSchema,
  async ({ paths, message }) => {
    const owner = REPO_OWNER;
    const repo = REPO_NAME;
    const branch = BRANCH_NAME;
    try {
      const githubToken = process.env.GITHUB_TOKEN;
      if (!githubToken) {
        throw new Error("GITHUB_TOKEN environment variable is required");
      }
      const target: BranchTarget = { owner, repo, branch, githubToken };

      // Validate all paths are within the repository root and normalize them to
      // repo-relative paths for the git tree entries. This mirrors the validation
      // already performed by the commit_files tool and rejects path traversal
      // ("../") and symlinked escapes as defense-in-depth.
      const processedPaths = await Promise.all(
        paths.map(async (filePath) => {
          await validatePathWithinRepo(filePath, REPO_DIR);
          return toRepoRelativePath(filePath);
        }),
      );

      // 1. Get the branch reference (create if doesn't exist) and base tree
      const head = await resolveBranchHead(target);

      // 2. Create tree entries for file deletions (setting SHA to null)
      const treeEntries: GitHubTreeEntry[] = processedPaths.map((path) => ({
        path,
        mode: "100644",
        type: "blob",
        sha: null,
      }));

      // 3. Create the tree and commit, then update the branch reference
      const result = await commitTreeEntries(
        target,
        head,
        treeEntries,
        message,
      );

      const simplifiedResult = {
        commit: result.commit,
        deletedFiles: processedPaths.map((path) => ({ path })),
        tree: result.tree,
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(simplifiedResult, null, 2),
          },
        ],
      };
    } catch (error) {
      return errorResult(error);
    }
  },
);

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.on("exit", () => {
    server.close();
  });
}

runServer().catch(console.error);
