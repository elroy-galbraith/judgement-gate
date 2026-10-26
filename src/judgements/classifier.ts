import { globMatcher } from "../glob";
import type { JevAnswers, Judgement } from "../types";

export interface ClassifierLevel {
  id: string;
  means: string;
}

export interface ClassifierSpec {
  id: string;
  name: string;
  question: string;
  /** Ordered, most severe first. */
  levels: ClassifierLevel[];
  appliesTo?: string[];
  ignore?: string[];
}

/**
 * One choice question; the answer is one of the org's levels. It informs and never fails: there is nothing for an
 * author to clear, so it never fires either. An answer that is not a configured level is "no level reported".
 */
export function compileClassifier(spec: ClassifierSpec): Judgement {
  const classified = `${spec.id}_classified`;
  const unreported = `${spec.id}_unreported`;
  return {
    id: spec.id,
    name: spec.name,
    kind: "classifier",
    optionalAnswers: true,
    appliesTo: spec.appliesTo,
    ignores: spec.ignore && spec.ignore.length > 0 ? globMatcher(spec.ignore) : undefined,
    reasons: [classified, unreported],
    questions: {
      q: { type: "choice", instructions: spec.question, criteria: Object.fromEntries(spec.levels.map((l) => [l.id, l.means])) },
    },
    decide(answers) {
      const a = answers.q as JevAnswers[string] | undefined;
      const wanted = typeof a?.choice === "string" ? a.choice.trim().toLowerCase() : "";
      const level = spec.levels.find((l) => l.id.toLowerCase() === wanted);
      if (!level) {
        return { conclusion: "success", fired: false, reason: unreported, summary: `${spec.name}: no level reported` };
      }
      const confidence = typeof a?.confidence === "number" ? a.confidence : undefined;
      return {
        conclusion: "success",
        fired: false,
        reason: classified,
        summary: `${spec.name}: ${level.id}`,
        metrics: confidence === undefined ? undefined : { confidence },
        classification: confidence === undefined ? { level: level.id } : { level: level.id, confidence },
      };
    },
    // Unreachable: only failing judgements are rendered, and a classifier never fails.
    remedy: () => ({ why: "", fix: "" }),
  };
}
