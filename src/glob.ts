import type { ChangedFile } from "./types";

const cache = new Map<string, RegExp>();

function toRegExp(pattern: string): RegExp {
  let re = cache.get(pattern);
  if (re) return re;
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?"; // zero or more directories
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  re = new RegExp(`^${out}$`);
  cache.set(pattern, re);
  return re;
}

export function matchesGlob(pattern: string, filename: string): boolean {
  return toRegExp(pattern).test(filename);
}

/** True when a filename matches any of the globs. An empty list matches nothing. */
export function globMatcher(globs: string[]): (filename: string) => boolean {
  return (filename) => globs.some((g) => matchesGlob(g, filename));
}

/**
 * A judgement applies when some changed file is not ignored and, if it has `appliesTo` globs, matches one of them.
 * With no globs and no ignore it always applies, even to a PR with no changed files.
 * A renamed file counts as ignored only when both its old and new names are, so a move cannot hide a risky file.
 */
export function appliesToFiles(
  appliesTo: string[] | undefined,
  files: ChangedFile[],
  ignores?: (filename: string) => boolean,
): boolean {
  const live = ignores
    ? files.filter((f) => !(ignores(f.filename) && (f.previous_filename === undefined || ignores(f.previous_filename))))
    : files;
  if (!appliesTo || appliesTo.length === 0) return live.length > 0 || files.length === 0;
  return live.some((f) => appliesTo.some((g) => matchesGlob(g, f.filename)));
}

/**
 * True when the PR brings a file matching `matches` into existence: added, copied, or renamed from outside the match.
 * Modifying an existing file does not count, and neither does renaming within the match (that edits an old file).
 */
export function hasNewFile(files: ChangedFile[], matches: (filename: string) => boolean): boolean {
  return files.some((f) => {
    if (!matches(f.filename)) return false;
    if (f.status === "added" || f.status === "copied") return true;
    return f.status === "renamed" && !(f.previous_filename && matches(f.previous_filename));
  });
}
