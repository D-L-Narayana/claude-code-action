#!/usr/bin/env bun

import * as core from "@actions/core";
import { retryWithBackoff } from "../utils/retry";

export class WorkflowValidationSkipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowValidationSkipError";
  }
}

type AppTokenExchangeErrorResponse = {
  error?: {
    message?: string;
    details?: {
      error_code?: string;
    };
  };
  type?: string;
  message?: string;
};

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type TokenExchangeOptions = {
  /** Replacement for the global fetch; tests inject a controlled one. */
  fetchFn?: FetchFn;
  /** How long one exchange attempt may take before it is aborted. */
  timeoutMs?: number;
};

const APP_TOKEN_EXCHANGE_URL =
  "https://api.anthropic.com/api/github/github-app-token-exchange";

// Without a deadline, a hung socket keeps a single attempt pending forever,
// and retryWithBackoff never gets a settled promise to retry from.
const DEFAULT_EXCHANGE_TIMEOUT_MS = 30_000;

const WORKFLOW_VALIDATION_ERROR_CODES = new Set([
  "workflow_not_found_on_default_branch",
]);

function getAppTokenExchangeErrorMessage(
  responseJson: AppTokenExchangeErrorResponse,
): string {
  return responseJson.error?.message ?? responseJson.message ?? "Unknown error";
}

function isWorkflowValidationError(
  status: number,
  responseJson: AppTokenExchangeErrorResponse,
): boolean {
  const errorCode = responseJson.error?.details?.error_code;
  if (
    errorCode !== undefined &&
    WORKFLOW_VALIDATION_ERROR_CODES.has(errorCode)
  ) {
    return true;
  }

  if (status !== 401) {
    return false;
  }

  const workflowValidationMessage = "workflow validation failed";
  return [responseJson.message, responseJson.error?.message].some((message) =>
    message?.toLowerCase().includes(workflowValidationMessage),
  );
}

/**
 * Whether an error came from the abort signal firing. AbortSignal.timeout
 * rejects with a DOMException named "TimeoutError"; a manual abort uses
 * "AbortError". Checked by name because the DOMException class differs
 * between runtimes.
 */
function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { name } = error as { name?: unknown };
  return name === "AbortError" || name === "TimeoutError";
}

async function getOidcToken(): Promise<string> {
  try {
    const oidcToken = await core.getIDToken("claude-code-github-action");

    return oidcToken;
  } catch (error) {
    console.error("Failed to get OIDC token:", error);
    throw new Error(
      "Could not fetch an OIDC token. Did you remember to add `id-token: write` to your workflow permissions?",
    );
  }
}

const DEFAULT_PERMISSIONS: Record<string, string> = {
  contents: "write",
  pull_requests: "write",
  issues: "write",
};

export function parseAdditionalPermissions():
  | Record<string, string>
  | undefined {
  const raw = process.env.ADDITIONAL_PERMISSIONS;
  if (!raw || !raw.trim()) {
    return undefined;
  }

  const additional: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) continue;
    const key = trimmed.slice(0, colonIndex).trim();
    const value = trimmed.slice(colonIndex + 1).trim();
    if (key && value) {
      additional[key] = value;
    }
  }

  if (Object.keys(additional).length === 0) {
    return undefined;
  }

  return { ...DEFAULT_PERMISSIONS, ...additional };
}

async function exchangeForAppToken(
  oidcToken: string,
  permissions?: Record<string, string>,
  {
    fetchFn = fetch,
    timeoutMs = DEFAULT_EXCHANGE_TIMEOUT_MS,
  }: TokenExchangeOptions = {},
): Promise<string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${oidcToken}`,
  };
  const fetchOptions: RequestInit = {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  };

  if (permissions) {
    headers["Content-Type"] = "application/json";
    fetchOptions.body = JSON.stringify({ permissions });
  }

  let response: Response;
  let responseJson: unknown;
  try {
    response = await fetchFn(APP_TOKEN_EXCHANGE_URL, fetchOptions);
    // The signal also governs reading the body, so a stalled body read
    // surfaces here as well.
    responseJson = await response.json();
  } catch (error) {
    if (isAbortError(error)) {
      // A plain Error, not a WorkflowValidationSkipError, so that
      // retryWithBackoff treats the timeout as retryable.
      throw new Error(`App token exchange timed out after ${timeoutMs} ms`);
    }
    throw error;
  }

  if (!response.ok) {
    const errorResponse = responseJson as AppTokenExchangeErrorResponse;

    if (isWorkflowValidationError(response.status, errorResponse)) {
      const message = getAppTokenExchangeErrorMessage(errorResponse);
      core.warning(`Skipping action due to workflow validation: ${message}`);
      console.log(
        "Action skipped due to workflow validation error. This is expected when adding Claude Code workflows to new repositories or on PRs with workflow changes. If you're seeing this, your workflow will begin working once you merge your PR.",
      );
      throw new WorkflowValidationSkipError(message);
    }

    const message = getAppTokenExchangeErrorMessage(errorResponse);
    console.error(
      `App token exchange failed: ${response.status} ${response.statusText} - ${message}`,
    );
    throw new Error(message);
  }

  const appTokenData = responseJson as {
    token?: string;
    app_token?: string;
  };
  const appToken = appTokenData.token || appTokenData.app_token;

  if (!appToken) {
    throw new Error("App token not found in response");
  }

  return appToken;
}

export async function setupGitHubToken(
  options: TokenExchangeOptions = {},
): Promise<string> {
  // Check if GitHub token was provided as override
  const providedToken = process.env.OVERRIDE_GITHUB_TOKEN;

  if (providedToken) {
    console.log("Using provided GITHUB_TOKEN for authentication");
    return providedToken;
  }

  console.log("Requesting OIDC token...");
  const oidcToken = await retryWithBackoff(() => getOidcToken());
  console.log("OIDC token successfully obtained");

  const permissions = parseAdditionalPermissions();

  console.log("Exchanging OIDC token for app token...");
  const appToken = await retryWithBackoff(
    () => exchangeForAppToken(oidcToken, permissions, options),
    {
      shouldRetry: (error) => !(error instanceof WorkflowValidationSkipError),
    },
  );
  console.log("App token successfully obtained");
  core.setSecret(appToken);

  console.log("Using GITHUB_TOKEN from OIDC");
  return appToken;
}
