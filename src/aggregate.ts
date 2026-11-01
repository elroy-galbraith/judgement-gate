import type { Judgement, JudgementVerdict, Verdict } from "./types";

/** Produced by orchestration; judgement decision rules only produce success or failure. */
export interface DegradedVerdict extends Omit<JudgementVerdict, "conclusion" | "reason" | "fired"> {
  conclusion: "neutral";
  reason: "degraded";
  fired: false;
  invalidQuestions: string[];
}

export interface JudgementResult {
  judgement: Judgement;
  verdict: JudgementVerdict | DegradedVerdict;
}

/** Narrow before calling judgement-authored remediation code. */
export function isDecided(result: JudgementResult): result is JudgementResult & { verdict: JudgementVerdict } {
  return result.verdict.conclusion !== "neutral";
}

/**
 * Only enforced failures block; raw verdicts stay intact for comments and routing.
 * Orchestration supplies resolved modes. An omitted mode retains the original aggregate semantics (enforce).
 */
export function aggregate(results: JudgementResult[]): Verdict {
  if (results.length === 0) return { conclusion: "success", reason: "no_applicable", summary: "No applicable judgements" };
  const enforced = results.filter((r) => r.judgement.mode !== "shadow");
  const failed = enforced.filter((r) => r.verdict.conclusion === "failure");
  if (failed.length === 0) {
    if (enforced.some((r) => r.verdict.conclusion === "neutral")) {
      return { conclusion: "neutral", reason: "degraded", summary: "[Audit Degraded]" };
    }
    const shadowIssues = results.filter((r) => r.judgement.mode === "shadow" && r.verdict.conclusion !== "success");
    if (shadowIssues.length > 0) return {
      conclusion: "success", reason: "shadow_findings",
      summary: `No enforced failures; ${shadowIssues.length} shadow judgement${shadowIssues.length === 1 ? "" : "s"} need${shadowIssues.length === 1 ? "s" : ""} attention`,
    };
    const first = results[0].verdict;
    return { conclusion: "success", reason: first.reason, summary: results.length === 1 ? first.summary : `${results.length} judgements passed` };
  }
  const first = failed[0].verdict;
  return {
    conclusion: "failure",
    reason: first.reason,
    summary: failed.length === 1 ? first.summary : `${failed.length} judgements need attention`,
  };
}
