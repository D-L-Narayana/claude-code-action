import { describe, expect, test } from "bun:test";
import {
  PrepareError,
  isPrepareError,
  type PrepareStep,
} from "../src/utils/prepare-error";

const STEPS: PrepareStep[] = [
  "branch",
  "mcp-config",
  "prompt",
  "comment",
  "git-auth",
  "fetch-data",
  "install",
];

function hasOwnCause(error: Error): boolean {
  return Object.prototype.hasOwnProperty.call(error, "cause");
}

describe("PrepareError", () => {
  test("is an Error that records the failing prepare step", () => {
    const error = new PrepareError("branch", 'Invalid branch name: "a:b"');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(PrepareError);
    expect(error.name).toBe("PrepareError");
    expect(error.step).toBe("branch");
    expect(error.message).toBe('Invalid branch name: "a:b"');
    expect(String(error)).toBe('PrepareError: Invalid branch name: "a:b"');
  });

  test("accepts every prepare step", () => {
    for (const step of STEPS) {
      expect(new PrepareError(step, `failed during ${step}`).step).toBe(step);
    }
  });

  test("keeps the original error as cause when one is provided", () => {
    const cause = new Error("git exited with code 128");

    const error = new PrepareError("git-auth", "could not configure git", {
      cause,
    });

    expect(error.cause).toBe(cause);
    expect(error.message).toBe("could not configure git");
  });

  test("accepts non-Error causes", () => {
    const error = new PrepareError("fetch-data", "fetch failed", {
      cause: "rate limited",
    });

    expect(error.cause).toBe("rate limited");
  });

  test("has no cause when none is provided", () => {
    expect(hasOwnCause(new PrepareError("prompt", "no cause"))).toBe(false);
    expect(hasOwnCause(new PrepareError("prompt", "no cause", {}))).toBe(false);
  });
});

describe("isPrepareError", () => {
  test("recognises PrepareError instances", () => {
    expect(isPrepareError(new PrepareError("comment", "x"))).toBe(true);
  });

  test("rejects other errors and non-error values", () => {
    expect(isPrepareError(new Error("plain"))).toBe(false);
    expect(
      isPrepareError({ name: "PrepareError", step: "branch", message: "x" }),
    ).toBe(false);
    expect(isPrepareError("PrepareError")).toBe(false);
    expect(isPrepareError(null)).toBe(false);
    expect(isPrepareError(undefined)).toBe(false);
  });

  test("narrows the type so the step is accessible", () => {
    const error: unknown = new PrepareError("install", "download failed");

    if (!isPrepareError(error)) {
      throw new Error("expected isPrepareError to return true");
    }
    expect(error.step).toBe("install");
  });
});
