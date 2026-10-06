/**
 * Failure contract for the prepare phase.
 *
 * Library code must throw instead of calling process.exit()/core.setFailed():
 * exiting bypasses the `finally` in src/entrypoints/run.ts, which is what
 * updates the tracking comment and sets the action outputs. A PrepareError
 * names the step that failed so the entrypoint can attribute the failure.
 */

export type PrepareStep =
  | "branch"
  | "mcp-config"
  | "prompt"
  | "comment"
  | "git-auth"
  | "fetch-data"
  | "install";

export class PrepareError extends Error {
  readonly step: PrepareStep;

  constructor(
    step: PrepareStep,
    message: string,
    options?: { cause?: unknown },
  ) {
    // Only forward `cause` when the caller supplied one, so an absent cause
    // stays absent instead of becoming an own `cause: undefined` property.
    super(
      message,
      options && "cause" in options ? { cause: options.cause } : undefined,
    );
    this.name = "PrepareError";
    this.step = step;
  }
}

export function isPrepareError(error: unknown): error is PrepareError {
  return error instanceof PrepareError;
}
