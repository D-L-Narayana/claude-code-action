import {
  describe,
  expect,
  test,
  beforeEach,
  afterEach,
  mock,
  spyOn,
} from "bun:test";
import * as core from "@actions/core";
import {
  setupGitHubToken,
  WorkflowValidationSkipError,
} from "../src/github/token";

describe("setupGitHubToken", () => {
  let originalOverrideToken: string | undefined;
  let originalAdditionalPermissions: string | undefined;
  let getIDTokenSpy: any;
  let setSecretSpy: any;
  let warningSpy: any;
  let fetchSpy: any;
  let setTimeoutSpy: any;
  let consoleLogSpy: any;
  let consoleErrorSpy: any;

  beforeEach(() => {
    originalOverrideToken = process.env.OVERRIDE_GITHUB_TOKEN;
    originalAdditionalPermissions = process.env.ADDITIONAL_PERMISSIONS;
    delete process.env.OVERRIDE_GITHUB_TOKEN;
    delete process.env.ADDITIONAL_PERMISSIONS;

    getIDTokenSpy = spyOn(core, "getIDToken").mockResolvedValue("oidc-token");
    setSecretSpy = spyOn(core, "setSecret").mockImplementation(() => {});
    warningSpy = spyOn(core, "warning").mockImplementation(() => {});
    fetchSpy = spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ token: "app-token" }), {
        status: 200,
        statusText: "OK",
      }),
    );
    setTimeoutSpy = spyOn(global, "setTimeout").mockImplementation(((
      handler: any,
    ) => {
      handler();
      return 0 as any;
    }) as any);
    consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalOverrideToken === undefined) {
      delete process.env.OVERRIDE_GITHUB_TOKEN;
    } else {
      process.env.OVERRIDE_GITHUB_TOKEN = originalOverrideToken;
    }

    if (originalAdditionalPermissions === undefined) {
      delete process.env.ADDITIONAL_PERMISSIONS;
    } else {
      process.env.ADDITIONAL_PERMISSIONS = originalAdditionalPermissions;
    }

    getIDTokenSpy.mockRestore();
    setSecretSpy.mockRestore();
    warningSpy.mockRestore();
    fetchSpy.mockRestore();
    setTimeoutSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  test("returns app token from OIDC exchange", async () => {
    await expect(setupGitHubToken()).resolves.toBe("app-token");

    expect(getIDTokenSpy).toHaveBeenCalledWith("claude-code-github-action");
    expect(setSecretSpy).toHaveBeenCalledWith("app-token");
  });

  test("skips without retrying when workflow is missing from default branch", async () => {
    const message =
      "Workflow validation failed. The workflow file must exist and have identical content to the version on the repository's default branch.";
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message,
            details: {
              error_code: "workflow_not_found_on_default_branch",
            },
          },
        }),
        { status: 401, statusText: "Unauthorized" },
      ),
    );

    await expect(setupGitHubToken()).rejects.toBeInstanceOf(
      WorkflowValidationSkipError,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(warningSpy).toHaveBeenCalledWith(
      `Skipping action due to workflow validation: ${message}`,
    );
  });

  test("skips without retrying when workflow validation message has no error code", async () => {
    const message =
      "Workflow validation failed. The workflow file must exist and have identical content to the version on the repository's default branch.";
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message,
          },
        }),
        { status: 401, statusText: "Unauthorized" },
      ),
    );

    await expect(setupGitHubToken()).rejects.toBeInstanceOf(
      WorkflowValidationSkipError,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(warningSpy).toHaveBeenCalledWith(
      `Skipping action due to workflow validation: ${message}`,
    );
  });

  test("retries ordinary token exchange errors instead of skipping", async () => {
    const message = "Bad credentials";
    fetchSpy.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message,
            },
          }),
          { status: 401, statusText: "Unauthorized" },
        ),
    );

    await expect(setupGitHubToken()).rejects.toThrow(message);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(warningSpy).not.toHaveBeenCalled();
  });

  test("does not skip message-only workflow validation errors with unexpected status", async () => {
    const message =
      "Workflow validation failed. The workflow file must exist and have identical content to the version on the repository's default branch.";
    fetchSpy.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message,
            },
          }),
          { status: 500, statusText: "Internal Server Error" },
        ),
    );

    await expect(setupGitHubToken()).rejects.toThrow(message);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(warningSpy).not.toHaveBeenCalled();
  });

  describe("token exchange timeout", () => {
    // A hung socket keeps the exchange pending forever and defeats
    // retryWithBackoff, which only sees settled promises. This fake fetch
    // never settles on its own: it rejects only once the abort signal it was
    // handed fires, so the exchange has to wire up a real timeout to pass.
    // AbortSignal.timeout does not go through the mocked global setTimeout.
    const createHungFetch = () =>
      mock(
        (_input: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) {
              reject(new Error("fetch was called without an abort signal"));
              return;
            }
            if (signal.aborted) {
              reject(signal.reason);
              return;
            }
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
      );

    test("fails a hung token exchange with a timeout error and retries before giving up", async () => {
      const hungFetch = createHungFetch();

      await expect(
        setupGitHubToken({ fetchFn: hungFetch, timeoutMs: 20 }),
      ).rejects.toThrow("timed out after 20 ms");

      expect(hungFetch).toHaveBeenCalledTimes(3);
      expect(hungFetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
      expect(fetchSpy).not.toHaveBeenCalled();
      // A timeout is an ordinary retryable failure, not a workflow
      // validation skip, so no skip warning may be emitted.
      expect(warningSpy).not.toHaveBeenCalled();
    });

    test("uses the injected fetch implementation for a successful exchange", async () => {
      const okFetch = mock(
        async (_input: string | URL | Request, init?: RequestInit) => {
          expect(init?.signal).toBeInstanceOf(AbortSignal);
          return new Response(JSON.stringify({ token: "injected-token" }), {
            status: 200,
            statusText: "OK",
          });
        },
      );

      await expect(setupGitHubToken({ fetchFn: okFetch })).resolves.toBe(
        "injected-token",
      );

      expect(okFetch).toHaveBeenCalledTimes(1);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(setSecretSpy).toHaveBeenCalledWith("injected-token");
    });
  });
});
