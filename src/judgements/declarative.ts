import { hasNewFile, matchesGlob } from "../glob";
import type { Judgement, PrContext } from "../types";

export type SatisfiedBy = { pr_body_matches: RegExp } | { file_added: string };

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

const pct = (n: number) => `${Math.round(n * 100)}%`;

function satisfied(rules: SatisfiedBy[], pr: PrContext): boolean {
  return rules.some((r) =>
    "pr_body_matches" in r
      ? r.pr_body_matches.test(pr.body)
      : hasNewFile(pr.files, (name) => matchesGlob(r.file_added, name)),
  );
}

/** One yes/no question; flagged at P(true) >= threshold; cleared by any satisfied_by rule. */
export function compileDeclarative(spec: DeclarativeSpec): Judgement {
  return {
    id: spec.id,
    name: spec.name,
    appliesTo: spec.appliesTo,
    reasons: [`${spec.id}_unsatisfied`, `${spec.id}_ok`],
    questions: {
      q: { type: "noul", instructions: spec.question, criteria: { true: spec.whenTrue, false: spec.whenFalse } },
    },
    decide(answers, pr) {
      const p = answers.q.noul!;
      const signals = `Signals: ${spec.name} ${pct(p)} (threshold ${pct(spec.threshold)}).`;
      const over = p >= spec.threshold;
      const metrics = { probability: p, confidence: answers.q.confidence };
      if (over && !satisfied(spec.satisfiedBy, pr)) {
        return { conclusion: "failure", reason: `${spec.id}_unsatisfied`, summary: `${spec.name}: not satisfied`, fired: over, signals, metrics: { ...metrics, cleared: false } };
      }
      return { conclusion: "success", reason: `${spec.id}_ok`, summary: `${spec.name}: ok`, fired: over, signals, metrics: { ...metrics, cleared: over } };
    },
    remedy: () => ({ why: spec.why, fix: spec.fix }),
    probes: () => [...(spec.probes ?? [])],
    agent: () => ({
      threshold: spec.threshold,
      satisfied_by: spec.satisfiedBy.map((r) =>
        "pr_body_matches" in r
          ? { type: "pr_body_matches" as const, regex: r.pr_body_matches.source, ...(r.pr_body_matches.flags ? { flags: r.pr_body_matches.flags } : {}) }
          : { type: "file_added" as const, glob: r.file_added },
      ),
    }),
  };
}
