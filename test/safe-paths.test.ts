import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/config";
import { appliesToFiles, globMatcher } from "../src/glob";
import { isSafePath, NEVER_SAFE_PATHS, SAFE_PATHS } from "../src/safe-paths";
import type { ChangedFile } from "../src/types";

const defaults = { confidenceThreshold: 0.75 };
const file = (filename: string, status = "modified", previous_filename?: string): ChangedFile => ({ filename, status, previous_filename });

describe("isSafePath", () => {
  it.each([
    "README.md",
    "docs/guide/intro.md",
    "docs/decisions-notes.md",
    "services/api/CHANGELOG.md",
    "assets/logo.svg",
    "img/Photo.PNG",
    "package-lock.json",
    "web/pnpm-lock.yaml",
    "crates/x/Cargo.lock",
    "go.sum",
    ".github/ISSUE_TEMPLATE/bug.yml",
    ".github/PULL_REQUEST_TEMPLATE.md",
  ])("%s is safe", (name) => {
    expect(isSafePath(name)).toBe(true);
  });

  it.each([
    "src/index.ts",
    "package.json",
    "requirements.txt",
    "migrations/0001_users.sql",
    "Dockerfile",
    ".github/workflows/deploy.yml",
    "docs/decisions/0001-use-postgres.md",
    "docs/decisions/sub/0002.md",
    "Docs/Decisions/0003.md",
    "CLAUDE.md",
    "services/api/AGENTS.md",
    ".claude/skills/x/SKILL.md",
    ".github/copilot-instructions.md",
    ".github/prompts/review.md",
  ])("%s is not safe", (name) => {
    expect(isSafePath(name)).toBe(false);
  });

  it("keeps the globs lower case, because paths are lower-cased before matching", () => {
    for (const g of [...SAFE_PATHS, ...NEVER_SAFE_PATHS]) expect(g).toBe(g.toLowerCase());
  });
});

describe("appliesToFiles with ignores", () => {
  const docs = globMatcher(["docs/**"]);

  it("does not apply when every changed file is ignored", () => {
    expect(appliesToFiles(undefined, [file("docs/a.md"), file("docs/b/c.md")], docs)).toBe(false);
  });
  it("applies when any changed file is not ignored", () => {
    expect(appliesToFiles(undefined, [file("docs/a.md"), file("src/a.ts")], docs)).toBe(true);
  });
  it("applies_to is checked only against files that are not ignored", () => {
    expect(appliesToFiles(["**/*.md"], [file("docs/a.md")], docs)).toBe(false);
    expect(appliesToFiles(["**/*.md"], [file("docs/a.md"), file("README.md")], docs)).toBe(true);
  });
  it("a PR with no changed files still applies, as before", () => {
    expect(appliesToFiles(undefined, [], docs)).toBe(true);
  });
  it("a rename is ignored only when both names are", () => {
    expect(appliesToFiles(undefined, [file("docs/schema.md", "renamed", "db/schema.sql")], docs)).toBe(true);
    expect(appliesToFiles(undefined, [file("docs/b.md", "renamed", "docs/a.md")], docs)).toBe(false);
  });
});

describe("ignore in config", () => {
  const oneWayDoor = (extra: string) => parseConfig(`judgements:\n  - use: one-way-door\n${extra}`, defaults)[0];

  it("the built-in ignores the safe set by default", () => {
    const j = oneWayDoor("");
    expect(j.ignores?.("README.md")).toBe(true);
    expect(j.ignores?.("src/a.ts")).toBe(false);
  });
  it("use: one-way-door ignore replaces the safe set", () => {
    const j = oneWayDoor("    ignore: ['vendor/**']");
    expect(j.ignores?.("vendor/x.go")).toBe(true);
    expect(j.ignores?.("README.md")).toBe(false);
  });
  it("use: one-way-door ignore: [] opts out of the safe set", () => {
    expect(oneWayDoor("    ignore: []").ignores).toBeUndefined();
  });

  const declarative = (extra: Record<string, unknown>) =>
    parseConfig(
      JSON.stringify({
        judgements: [
          { id: "x", name: "X", question: "Q?", true: "t", false: "f", threshold: 0.5, satisfied_by: [{ pr_body_matches: "ok" }], why: "w", fix: "f", ...extra },
        ],
      }),
      defaults,
    )[0];

  it("a custom judgement ignores nothing by default", () => {
    expect(declarative({}).ignores).toBeUndefined();
    expect(declarative({ ignore: [] }).ignores).toBeUndefined();
  });
  it("a custom judgement can ignore globs", () => {
    const j = declarative({ ignore: ["docs/**", "**/*.md"] });
    expect(j.ignores?.("docs/a.txt")).toBe(true);
    expect(j.ignores?.("src/a.ts")).toBe(false);
  });
  it("a classifier can ignore globs", () => {
    const [j] = parseConfig(
      JSON.stringify({ judgements: [{ id: "sev", name: "Sev", classify: { question: "Q?", levels: [{ id: "P0", means: "a" }, { id: "P1", means: "b" }] }, ignore: ["docs/**"] }] }),
      defaults,
    );
    expect(j.ignores?.("docs/a.md")).toBe(true);
  });

  it.each([
    ["a string", "    ignore: docs/**"],
    ["a mapping", "    ignore: {a: b}"],
    ["a non-string entry", "    ignore: [3]"],
    ["an empty glob", "    ignore: ['']"],
    ["null", "    ignore:"],
  ])("rejects ignore as %s", (_n, line) => {
    expect(() => parseConfig(`judgements:\n  - use: one-way-door\n${line}`, defaults)).toThrow(ConfigError);
  });
});
