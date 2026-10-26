import { matchesGlob } from "./glob";

/**
 * Files that cannot make a change hard to undo: docs, images and lockfiles. The built-in `one-way-door` skips a PR
 * whose changed files are all in this set (see `ignore` in docs/configuration.md). Globs are matched against the
 * lower-cased filename, so write them in lower case.
 */
export const SAFE_PATHS: readonly string[] = [
  "**/*.md",
  "**/*.png",
  "**/*.jpg",
  "**/*.jpeg",
  "**/*.gif",
  "**/*.svg",
  "**/*.webp",
  "**/*.ico",
  ".github/issue_template/**",
  "**/license",
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/bun.lockb",
  "**/cargo.lock",
  "**/poetry.lock",
  "**/uv.lock",
  "**/gemfile.lock",
  "**/composer.lock",
  "**/go.sum",
];

/**
 * Never safe, even when `SAFE_PATHS` matches. An ADR is the evidence the gate looks for, and the instruction files
 * below are Markdown that steers an agent, so editing one is a change to behaviour.
 */
export const NEVER_SAFE_PATHS: readonly string[] = [
  "docs/decisions/**",
  "**/claude.md",
  "**/agents.md",
  "**/gemini.md",
  ".claude/**",
  ".cursor/**",
  ".github/copilot-instructions.md",
  ".github/instructions/**",
  ".github/prompts/**",
];

export function isSafePath(filename: string): boolean {
  const name = filename.toLowerCase();
  return SAFE_PATHS.some((g) => matchesGlob(g, name)) && !NEVER_SAFE_PATHS.some((g) => matchesGlob(g, name));
}
