import { isDecided, type JudgementResult } from "./aggregate";
import { FALSE_POSITIVE_COMMAND } from "./analytics";
import { COMMENT_MARKER } from "./github";
import type { RoutingResult } from "./routing";
import type { RemedyContext } from "./types";

export const AGENT_BLOCK_VERSION = 1;

/** Escape so the JSON can never close the HTML comment or inject markup. */
const safeJson = (o: unknown) =>
  JSON.stringify(o)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

/** Hidden, machine-readable twin of the comment. Ids, reasons, numbers, fix templates and authored probes only: no PR or diff content. */
function agentBlock(failing: JudgementResult[], rc: RemedyContext, mode: string, routing?: RoutingResult, classified: JudgementResult[] = []): string {
  const payload = {
    schema: AGENT_BLOCK_VERSION,
    mode,
    failing: failing.filter(isDecided).map(({ judgement, verdict }) => {
      const hint = judgement.agent?.(verdict, rc);
      return {
        id: judgement.id,
        name: judgement.name,
        reason: verdict.reason,
        probability: verdict.metrics?.probability ?? null,
        threshold: hint?.threshold ?? null,
        satisfied_by: hint?.satisfied_by ?? [],
        suggested_template: hint?.suggested_template ?? null,
        probes: judgement.probes?.(verdict) ?? [],
      };
    }),
    ...(classified.length > 0 && {
      classification: classified.map(({ judgement, verdict }) => ({
        id: judgement.id,
        level: verdict.classification!.level,
        confidence: verdict.classification!.confidence ?? null,
      })),
    }),
    ...(routing && { routing: { route: routing.route, reasons: routing.reasons, label: routing.label } }),
  };
  return `<!-- judgement-gate:v${AGENT_BLOCK_VERSION} ${safeJson(payload)} -->`;
}

/** Reasons come from config ids, globs and reason codes; code spans keep `**` in a glob from becoming markdown. */
const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;

/** The routing recommendation in words, so the person reading the comment sees what the hidden block and the label say. */
function routingLine(routing: RoutingResult, routingMode: string): string {
  const why = routing.reasons.map(code).join(", ");
  switch (routing.route) {
    case "human":
      return routingMode === "shadow"
        ? `**Review routing:** human review recommended: ${why}. Routing is in shadow mode, so no label is added.`
        : `**Review routing:** human review recommended: ${why}. The gate adds the ${code(routing.label)} label.`;
    case "agent":
      return "**Review routing:** agent review is fine: no rule requires a human.";
    default:
      return `**Review routing:** could not be decided: ${why}.`;
  }
}

/** The classifier lines (severity) then the routing line, shown under the heading of either kind of comment. */
function headerLines(classified: JudgementResult[], routing: RoutingResult | undefined, routingMode: string): string[] {
  const labels = classified.map(({ judgement, verdict }) => {
    const { level, confidence } = verdict.classification!;
    return `**${judgement.name}:** ${level}${confidence === undefined ? "" : ` (confidence ${confidence.toFixed(2)})`}`;
  });
  return [...labels, ...(routing ? [routingLine(routing, routingMode)] : [])];
}

/**
 * One comment for the PR: a teaching section (why + fix) per failing judgement. `all` is every result; classifiers
 * (severity) among them are reported alongside, never as a reason to post. With no failures, render a passing note.
 */
export function renderComment(
  failing: JudgementResult[],
  rc: RemedyContext,
  mode = "shadow",
  routing?: RoutingResult,
  all: JudgementResult[] = [],
  routingMode = mode,
): string {
  const classified = all.filter((r) => r.verdict.classification);
  const header = headerLines(classified, routing, routingMode);
  const degraded = degradationNote(all);
  const heading =
    failing.length === 0 ? (degraded ? "audit incomplete; no failures in evaluated judgements" : "all applicable judgements passed") : failing.length === 1 ? failing[0].verdict.summary : `${failing.length} judgements need attention`;
  const sections = failing.filter(isDecided).map(({ judgement, verdict }) => {
    const r = judgement.remedy(verdict, rc);
    const parts = [`#### ${judgement.name}`, "", `**Why:** ${r.why}`, "", "**Fix:**", "", r.fix];
    const probes = judgement.probes?.(verdict) ?? [];
    if (probes.length > 0) parts.push("", "**Questions a reviewer will ask:**", "", ...probes.map((p) => `- ${p}`));
    if (verdict.signals) parts.push("", `<sub>${verdict.signals}</sub>`);
    parts.push("", `<sub>Not a real issue? Reply \`${FALSE_POSITIVE_COMMAND} ${judgement.id}\` to help calibrate.</sub>`);
    return parts.join("\n");
  });
  return `${COMMENT_MARKER}\n### judgement-gate: ${heading}\n\n${header.length > 0 ? `${header.join("  \n")}\n\n` : ""}${sections.join("\n\n")}${degraded ? `\n\n${degraded}` : ""}\n\n${agentBlock(failing, rc, mode, routing, classified)}`;
}

/**
 * The comment for a PR that passed every judgement but is routed to a human: why a person reviews it. It reuses the
 * gate's marker, so it replaces a failing comment from an earlier push. `all` is every result: judgements that fired
 * and were cleared are explained, and their probes are questions for the reviewer, not the author.
 */
export function renderRoutingComment(routing: RoutingResult, rc: RemedyContext, mode: string, routingMode: string, all: JudgementResult[]): string {
  const classified = all.filter((r) => r.verdict.classification);
  const header = headerLines(classified, routing, routingMode);
  const degraded = degradationNote(all);
  const heading = degraded ? "audit incomplete, human review recommended" : routingMode === "shadow" ? "passed the checks, human review recommended" : "passed the checks, routed to a human reviewer";
  const sections = all
    .filter(isDecided)
    .filter((r) => r.verdict.conclusion === "success" && r.verdict.fired)
    .map(({ judgement, verdict }) => {
      const parts = [`#### ${judgement.name}`, "", judgement.remedy(verdict, rc).why];
      const probes = judgement.probes?.(verdict) ?? [];
      if (probes.length > 0) parts.push("", "**Questions a reviewer will ask:**", "", ...probes.map((p) => `- ${p}`));
      return parts.join("\n");
    });
  const body = [COMMENT_MARKER, `### judgement-gate: ${heading}`, "", header.join("  \n"), "", ...(degraded ? [degraded, ""] : []), ...sections.flatMap((x) => [x, ""]), agentBlock([], rc, mode, routing, classified)];
  return body.join("\n");
}

/** Only authored judgement names are shown; model-provided answer text is never echoed. */
function degradationNote(all: JudgementResult[]): string {
  const degraded = all.filter((r) => r.verdict.conclusion === "neutral");
  return degraded.length > 0 ? `**Audit degraded:** ${degraded.map(r => code(r.judgement.name)).join(", ")}. These judgements could not be evaluated.` : "";
}
