import { describe, expect, test } from "bun:test";
import {
  isAllowedBot,
  normalizeLogin,
} from "../src/github/validation/allowed-bots";

describe("normalizeLogin", () => {
  test("lowercases the login", () => {
    expect(normalizeLogin("Dependabot")).toBe("dependabot");
  });

  test("trims surrounding whitespace", () => {
    expect(normalizeLogin("  renovate  ")).toBe("renovate");
  });

  test("strips a trailing [bot] suffix regardless of its case", () => {
    expect(normalizeLogin("dependabot[bot]")).toBe("dependabot");
    expect(normalizeLogin("Dependabot[BOT]")).toBe("dependabot");
  });

  test("strips only one trailing [bot] suffix", () => {
    expect(normalizeLogin("weird[bot][bot]")).toBe("weird[bot]");
  });

  test("leaves [bot] alone when it is not a suffix", () => {
    expect(normalizeLogin("[bot]something")).toBe("[bot]something");
    expect(normalizeLogin("a[bot]b")).toBe("a[bot]b");
  });

  test("returns an empty string for whitespace-only input", () => {
    expect(normalizeLogin("   ")).toBe("");
  });
});

describe("isAllowedBot", () => {
  test("'*' allows every actor", () => {
    expect(isAllowedBot("anything[bot]", "*")).toBe(true);
    expect(isAllowedBot("Copilot", "*")).toBe(true);
  });

  test("'*' is recognised with surrounding whitespace", () => {
    expect(isAllowedBot("anything[bot]", "  *  ")).toBe(true);
  });

  test("'*' is only a wildcard when it is the whole value", () => {
    expect(isAllowedBot("other[bot]", "*,dependabot")).toBe(false);
  });

  test("an empty or whitespace-only list allows nobody", () => {
    expect(isAllowedBot("dependabot[bot]", "")).toBe(false);
    expect(isAllowedBot("dependabot[bot]", "   ")).toBe(false);
  });

  test("matches an entry written with the [bot] suffix", () => {
    expect(
      isAllowedBot("dependabot[bot]", "dependabot[bot],renovate[bot]"),
    ).toBe(true);
  });

  test("matches an entry written without the [bot] suffix", () => {
    expect(isAllowedBot("dependabot[bot]", "dependabot,renovate")).toBe(true);
  });

  test("matches a non-suffixed actor against a suffixed entry", () => {
    expect(isAllowedBot("SomeNewBot", "somenewbot[bot]")).toBe(true);
  });

  test("matches case-insensitively", () => {
    expect(isAllowedBot("Copilot", "COPILOT")).toBe(true);
  });

  test("ignores whitespace and empty entries in the list", () => {
    expect(isAllowedBot("renovate[bot]", " dependabot , , renovate ")).toBe(
      true,
    );
  });

  test("rejects actors that are not listed", () => {
    expect(
      isAllowedBot("other-bot[bot]", "dependabot[bot],renovate[bot]"),
    ).toBe(false);
    expect(isAllowedBot("other-bot[bot]", "dependabot,renovate")).toBe(false);
  });

  test("does not treat an entry as a prefix or substring match", () => {
    expect(isAllowedBot("dependabot-preview[bot]", "dependabot")).toBe(false);
    expect(isAllowedBot("dependabot[bot]", "dependabot-preview")).toBe(false);
  });
});
