import { hasNewFile } from "./glob";
import type { ChangedFile, JevResult, Verdict } from "./types";

export interface PolicyOptions {
  confidenceThreshold: number;
}

const ADR = /^docs\/decisions\/.+\.md$/;

/** An ADR counts only if this PR adds it: editing an old ADR does not verify an unrelated change. */
export function hasAdr(files: ChangedFile[]): boolean {
  return hasNewFile(files, (name) => ADR.test(name));
}

export function evaluatePolicy(j: JevResult, files: ChangedFile[], opts: PolicyOptions): Verdict {
  if (j.oneWayProb > 0.4 || j.classification === "TYPE_1_ONE_WAY_DOOR") {
    return hasAdr(files)
      ? { conclusion: "success", reason: "type1_adr", summary: "Type 1 verified with ADR" }
      : { conclusion: "failure", reason: "type1_no_adr", summary: "Type 1 requires an ADR under docs/decisions/" };
  }
  if (j.classificationConfidence < opts.confidenceThreshold) {
    return {
      conclusion: "failure",
      reason: "ambiguous",
      summary: "Ambiguous blast radius; escalate to human peer review or document ADR",
    };
  }
  if (j.reversalProb >= 0.7) {
    return { conclusion: "success", reason: "type2_ok", summary: "Type 2 verified with clean reversal plan" };
  }
  return {
    conclusion: "failure",
    reason: "type2_no_plan",
    summary: "Type 2 requires Reversal Trigger and Rollback Path in PR body",
  };
}
