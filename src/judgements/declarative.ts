import { hasNewFile, matchesGlob } from "../glob";
import type { JevAnswers, JevQuestion, Judgement, PrContext } from "../types";

/**
 * `pr_body_matches` and `file_added` prove a line or file exists, not that it means anything (`Impact: n/a` matches
 * `^Impact:`). `answers` is the stricter form: the model judges whether the PR body gives a concrete answer.
 */
export type SatisfiedBy = { pr_body_matches: RegExp } | { file_added: string } | { answers: string };

export interface DeclarativeSpec {
  id: string;
  name: string;
  question: string;
  whenTrue: string;
  whenFalse: string;
  threshold: number;
  appliesTo?: string[];
  satisfiedBy: SatisfiedBy[];
  why: string;
  fix: string;
  probes?: string[];
}

/** Only this much of the PR body is matched, so a regex has bounded input however long the body is. */
export const MAX_MATCH_BODY = 10_000;

/** An `answers` rule clears when the model's P(concrete answer) is at least this. */
export const EVIDENCE_THRESHOLD = 0.5;

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** Question key for the `answers` rule at this position in satisfied_by. */
const evidenceKey = (i: number) => `evidence${i}`;

function evidenceQuestion(question: string): JevQuestion {
  return {
    type: "noul",
    instructions:
      `Read only the PR description. Does it give a concrete, specific answer to this: "${question}"? ` +
      `A placeholder such as n/a, none, tbd or "see above", or a line that restates the question without detail, is not an answer.`,
    criteria: {
      true: "the PR description gives a specific answer about this change",
      false: "the answer is missing, a placeholder, or too vague to act on",
    },
  };
}

function satisfied(rules: SatisfiedBy[], pr: PrContext, answers: JevAnswers): boolean {
  const body = pr.body.slice(0, MAX_MATCH_BODY);
  return rules.some((r, i) => {
    if ("pr_body_matches" in r) return r.pr_body_matches.test(body);
    if ("file_added" in r) return hasNewFile(pr.files, (name) => matchesGlob(r.file_added, name));
    return (answers[evidenceKey(i)]?.noul ?? 0) >= EVIDENCE_THRESHOLD;
  });
}

/** Evidence probabilities for the `answers` rules, for the signals line. */
function evidenceSignal(rules: SatisfiedBy[], answers: JevAnswers): string {
  const parts = rules.flatMap((r, i) => {
    const p = "answers" in r ? answers[evidenceKey(i)]?.noul : undefined;
    return p === undefined ? [] : [`Evidence ${pct(p)} (needs ${pct(EVIDENCE_THRESHOLD)})`];
  });
  return parts.length === 0 ? "" : ` ${parts.join(", ")}.`;
}

/** One yes/no question; flagged at P(true) >= threshold; cleared by any satisfied_by rule. Each `answers` rule adds a question to the same Jev request. */
export function compileDeclarative(spec: DeclarativeSpec): Judgement {
  const evidence = Object.fromEntries(
    spec.satisfiedBy.flatMap((r, i) => ("answers" in r ? [[evidenceKey(i), evidenceQuestion(r.answers)] as const] : [])),
  );
  return {
    id: spec.id,
    name: spec.name,
    appliesTo: spec.appliesTo,
    reasons: [`${spec.id}_unsatisfied`, `${spec.id}_ok`],
    questions: {
      q: { type: "noul", instructions: spec.question, criteria: { true: spec.whenTrue, false: spec.whenFalse } },
      ...evidence,
    },
    decide(answers, pr) {
      const p = answers.q.noul!;
      const over = p >= spec.threshold;
      const signals = `Signals: ${spec.name} ${pct(p)} (threshold ${pct(spec.threshold)}).${over ? evidenceSignal(spec.satisfiedBy, answers) : ""}`;
      const metrics = { probability: p, confidence: answers.q.confidence };
      if (over && !satisfied(spec.satisfiedBy, pr, answers)) {
        return { conclusion: "failure", reason: `${spec.id}_unsatisfied`, summary: `${spec.name}: not satisfied`, fired: over, signals, metrics: { ...metrics, cleared: false } };
      }
      return { conclusion: "success", reason: `${spec.id}_ok`, summary: `${spec.name}: ok`, fired: over, signals, metrics: { ...metrics, cleared: over } };
    },
    remedy: () => ({ why: spec.why, fix: spec.fix }),
    probes: () => [...(spec.probes ?? [])],
    agent: () => ({
      threshold: spec.threshold,
      satisfied_by: spec.satisfiedBy.map((r) => {
        if ("pr_body_matches" in r) {
          return { type: "pr_body_matches" as const, regex: r.pr_body_matches.source, ...(r.pr_body_matches.flags ? { flags: r.pr_body_matches.flags } : {}) };
        }
        if ("file_added" in r) return { type: "file_added" as const, glob: r.file_added };
        return { type: "answers" as const, question: r.answers };
      }),
    }),
  };
}
