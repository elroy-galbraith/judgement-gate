import { globMatcher } from "../glob";
import { evaluatePolicy } from "../policy";
import { isSafePath } from "../safe-paths";
import type { Judgement, JevAnswers, JevResult, JudgementVerdict } from "../types";

const pct = (n: number) => `${Math.round(n * 100)}%`;
const encodeSegment = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const FENCE = "```";
const REVERSAL_TEMPLATE = [
  "Reversal Trigger: <signal that tells us to roll back, e.g. error rate > 2% for 5 min>",
  "Rollback Path: <exact steps, e.g. revert this PR, or set flag X=off>",
  "Owner: <who acts on the trigger>",
].join("\n");
const ADR_TEMPLATE = [
  "# NNNN: <short title>",
  "",
  "## Context",
  "## Decision",
  "## Alternatives considered",
  "## Consequences",
  "## Rollback limits",
].join("\n");

function toJevResult(a: JevAnswers): JevResult {
  const cls = a.synthetic_classification;
  return {
    oneWayProb: a.is_one_way_boundary_mutation.noul!,
    additiveProb: a.is_additive_or_isolated.noul!,
    reversalProb: a.has_concrete_reversal_plan.noul!,
    classification: cls.choice === "TYPE_1_ONE_WAY_DOOR" ? "TYPE_1_ONE_WAY_DOOR" : "TYPE_2_TWO_WAY_DOOR",
    classificationConfidence: cls.confidence ?? 0,
  };
}

export interface OneWayDoorProbes {
  type1?: string[];
  type2?: string[];
}

export const DEFAULT_PROBES: { type1: string[]; type2: string[] } = {
  type1: [
    "What else reads or writes this: other services, jobs, reports, exports? How do you know?",
    "What breaks while old and new code run side by side during the rollout?",
    "If you revert, what survives? If data is lost, how do you get it back and how long does that take?",
    "What tells you within the first hour that this was wrong, and who is watching?",
    "Could this be split into steps that are each reversible? If not, why not?",
  ],
  type2: [
    "What signal tells you to roll back, and who watches it?",
    "What does the flag or config default to, and what happens if it flips unexpectedly?",
    "Does anything written by the new code outlive a rollback?",
  ],
};

export interface OneWayDoorOptions {
  confidenceThreshold?: number;
  appliesTo?: string[];
  /** Replaces the default safe set (`isSafePath`). An empty list ignores nothing, so every PR is judged. */
  ignore?: string[];
  probes?: OneWayDoorProbes;
}

export function oneWayDoor(opts: OneWayDoorOptions = {}): Judgement {
  const confidenceThreshold = opts.confidenceThreshold ?? 0.75;
  const probes = { type1: opts.probes?.type1 ?? DEFAULT_PROBES.type1, type2: opts.probes?.type2 ?? DEFAULT_PROBES.type2 };
  return {
    id: "one-way-door",
    name: "One-way door",
    appliesTo: opts.appliesTo,
    ignores: opts.ignore === undefined ? isSafePath : opts.ignore.length > 0 ? globMatcher(opts.ignore) : undefined,
    unprefixedKeys: true,
    reasons: ["type1_adr", "type1_no_adr", "ambiguous", "type2_ok", "type2_no_plan"],
    questions: {
      is_one_way_boundary_mutation: {
        type: "noul",
        instructions:
          "Does this pull request make a one-way-door change: a persistent database/schema change, an authentication or authorization refactor, or an infrastructure topology shift that cannot easily be undone?",
        criteria: {
          true: "alters persistent schema or data, auth model, or infrastructure topology in a way that is hard to reverse",
          false: "no persistent, auth or infrastructure boundary mutation",
        },
      },
      is_additive_or_isolated: {
        type: "noul",
        instructions: "Is this change strictly additive and non-breaking, or isolated behind an adapter or feature flag?",
        criteria: {
          true: "only adds behaviour, or is guarded by a flag/adapter so existing behaviour is unchanged",
          false: "modifies or removes existing behaviour without a guard",
        },
      },
      has_concrete_reversal_plan: {
        type: "noul",
        instructions:
          "Does the pull request description state BOTH a concrete reversal trigger (an operational signal that says to roll back) AND a rollback procedure?",
        criteria: {
          true: "description names a trigger condition and the steps to roll back",
          false: "no trigger, or no rollback steps, or only vague statements",
        },
      },
      synthetic_classification: {
        type: "choice",
        instructions: "Classify this change as a one-way door (hard to reverse) or a two-way door (easy to reverse).",
        criteria: {
          TYPE_1_ONE_WAY_DOOR: "irreversible, schema-altering, or infrastructure-critical",
          TYPE_2_TWO_WAY_DOOR: "easily reversible by revert or flag flip",
        },
      },
    },
    decide(answers, pr): JudgementVerdict {
      const j = toJevResult(answers);
      const v = evaluatePolicy(j, pr.files, { confidenceThreshold, diffTruncated: pr.diffTruncated });
      return {
        conclusion: v.conclusion === "success" ? "success" : "failure",
        reason: v.reason,
        summary: v.summary,
        fired: v.reason.startsWith("type1"),
        metrics: { probability: j.oneWayProb, confidence: j.classificationConfidence, cleared: v.reason === "type1_adr" },
        signals: `Signals: one-way boundary ${pct(j.oneWayProb)}, additive/isolated ${pct(j.additiveProb)}, reversal plan ${pct(j.reversalProb)}, classified ${j.classification} (confidence ${j.classificationConfidence.toFixed(2)}).${pr.diffTruncated ? " The diff was too large to read in full." : ""}`,
      };
    },
    remedy(v, rc) {
      switch (v.reason) {
        case "type1_adr":
          // Not a failure: shown when the PR passed but a person still reviews it.
          return {
            why: "The change looks like a one-way door (schema, auth or infrastructure), so it is hard to undo. The ADR records the reasoning, but a person who is accountable for the decision still reviews it.",
            fix: "Nothing to fix. A reviewer will read the ADR and check the rollback limits it names.",
          };
        case "type1_no_adr": {
          const pathInstruction =
            "Add an Architecture Decision Record at `docs/decisions/NNNN-short-title.md` covering context, decision, alternatives, consequences and rollback limits.";
          const encodedRef = rc.headRef ? rc.headRef.split("/").map(encodeSegment).join("/") : "";
          return {
            why: "The change looks like a one-way door (schema, auth or infrastructure). Once it ships it is hard to undo, so the reasoning behind it must be recorded where the next person will find it.",
            fix: encodedRef
              ? [
                  pathInstruction,
                  `[Create one](https://github.com/${rc.owner}/${rc.repo}/new/${encodedRef}?filename=docs/decisions/0001-title.md).`,
                ].join("\n")
              : pathInstruction,
          };
        }
        case "type2_no_plan":
          return {
            why: "The change is reversible, but only if someone knows when and how to reverse it. The PR description has no concrete reversal plan.",
            fix: [
              "Add these three lines to the PR description:",
              "",
              FENCE,
              REVERSAL_TEMPLATE,
              FENCE,
            ].join("\n"),
          };
        default:
          return {
            why: "The model could not confidently size the blast radius of this change, or the diff was too large for it to read in full.",
            fix: "Split the PR into smaller ones, request a human peer review, or document the decision in an ADR under `docs/decisions/`.",
          };
      }
    },
    probes(v) {
      switch (v.reason) {
        case "type1_adr":
        case "type1_no_adr":
        case "ambiguous":
          return [...probes.type1];
        case "type2_no_plan":
          return [...probes.type2];
        default:
          return [];
      }
    },
    agent(v, rc) {
      const adr = { type: "file_added" as const, glob: "docs/decisions/*.md", example_path: "docs/decisions/0001-title.md" };
      const fields = { type: "pr_body_fields" as const, fields: ["Reversal Trigger", "Rollback Path"], template: REVERSAL_TEMPLATE };
      switch (v.reason) {
        case "type1_no_adr":
          return { satisfied_by: [adr], suggested_template: { target: "file", path: adr.example_path, content: ADR_TEMPLATE } };
        case "type2_no_plan":
          return { satisfied_by: [fields], suggested_template: { target: "pr_body", content: REVERSAL_TEMPLATE } };
        default:
          return { threshold: confidenceThreshold, satisfied_by: [adr, fields], suggested_template: { target: "file", path: adr.example_path, content: ADR_TEMPLATE } };
      }
    },
  };
}
