import type { JudgementResult } from "./aggregate";
import { matchesGlob } from "./glob";
import type { ChangedFile } from "./types";

export const DEFAULT_LABEL = "needs-human-review";

export type RoutingRule = { judgement: string; reason?: string } | { files: string[] };

export const DEFAULT_RULES: RoutingRule[] = [{ judgement: "one-way-door" }, { judgement: "one-way-door", reason: "ambiguous" }];

export type RoutingSetup =
  | { status: "ok"; rules: RoutingRule[]; label: string }
  | { status: "config_error"; message: string; label: string }
  | { status: "unavailable"; message: string; label: string };

export interface RoutingResult {
  route: "human" | "agent" | "unavailable";
  reasons: string[];
  label: string;
}

/** Returns the reason a rule matched, or null. `results === null` means the audit was degraded. */
function matchRule(rule: RoutingRule, results: JudgementResult[] | null, files: ChangedFile[]): string | null {
  if ("files" in rule) {
    // Any changed file counts, whatever its status, so deletions are covered.
    const glob = rule.files.find((g) => files.some((f) => matchesGlob(g, f.filename)));
    return glob === undefined ? null : `files: ${glob}`;
  }
  const hit = results?.find((r) => r.judgement.id === rule.judgement);
  if (!hit || hit.verdict.conclusion === "neutral") return null;
  if (rule.reason !== undefined) return hit.verdict.reason === rule.reason ? `${rule.judgement}: ${rule.reason}` : null;
  return hit.verdict.fired ? `${rule.judgement} flagged` : null;
}

/** Decides whether a PR needs a human reviewer. Pure: no I/O, no config loading. */
export function evaluateRouting(setup: RoutingSetup, results: JudgementResult[] | null, files: ChangedFile[]): RoutingResult {
  const { label } = setup;
  if (setup.status === "config_error") return { route: "human", reasons: [`config error: ${setup.message}`], label };
  if (setup.status === "unavailable") return { route: "unavailable", reasons: [setup.message], label };

  const reasons: string[] = [];
  for (const rule of setup.rules) {
    const reason = matchRule(rule, results, files);
    if (reason !== null && !reasons.includes(reason)) reasons.push(reason);
  }
  if (reasons.length > 0) return { route: "human", reasons, label };
  // Without judgement results, "no rule matched" does not mean an agent can take it.
  if (results === null) return { route: "unavailable", reasons: ["audit degraded"], label };
  // Only a missing result used by a routing rule makes an otherwise unmatched route uncertain.
  if (setup.rules.some((rule) => "judgement" in rule && results.some((r) =>
    r.judgement.id === rule.judgement && r.verdict.conclusion === "neutral"))) {
    return { route: "unavailable", reasons: ["judgement rules skipped (audit degraded)"], label };
  }
  return { route: "agent", reasons: [], label };
}
