// Bun preload (`bun --preload test/e2e/preload-fake-claude.ts run …`) that swaps
// base-action/src/run-claude.ts for ./fake-run-claude.ts inside the spawned
// action process. Everything else loads from the real source tree, so the
// harness exercises the production orchestrator with only the model call
// replaced. Using a loader plugin (rather than editing the source) keeps the
// substitution out of the shipped code and lets the same harness run against
// any checkout of the action (see E2E_ACTION_ROOT in run-orchestrator.test.ts).
import { plugin } from "bun";
import { join } from "path";

const FAKE_RUN_CLAUDE = join(import.meta.dir, "fake-run-claude.ts");

plugin({
  name: "e2e-fake-run-claude",
  setup(build) {
    build.onLoad(
      { filter: /[\\/]base-action[\\/]src[\\/]run-claude\.ts$/ },
      async () => ({
        contents: await Bun.file(FAKE_RUN_CLAUDE).text(),
        loader: "ts",
      }),
    );
  },
});
