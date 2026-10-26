/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import configYaml from "./fixtures/adversarial/config.yml?raw";
import { parseConfig } from "../src/config";
import {
  ATTACKS,
  buildContext,
  grade,
  renderReport,
  runCase,
  summarise,
  type AdversarialCase,
  type CaseRun,
} from "./adversarial/harness";

const cases = Object.values(import.meta.glob<AdversarialCase>("./fixtures/adversarial/cases/*.json", { eager: true, import: "default" }));
const judgements = parseConfig(configYaml, { confidenceThreshold: 0.75 });
const cfg = { apiKey: "k", url: "https://jev.test/d", model: "m", timeoutMs: 1000 };
const jevReturning = (answers: unknown) =>
  (async () => new Response(JSON.stringify({ answers }), { status: 200 })) as unknown as typeof fetch;
const byId = (id: string) => cases.find((c) => c.id === id)!;

// Answers that say: a flagged, reversible change with a stated plan.
const PLAN_OK = {
  is_one_way_boundary_mutation: { noul: 0.05 },
  is_additive_or_isolated: { noul: 0.9 },
  has_concrete_reversal_plan: { noul: 0.95 },
  synthetic_classification: { choice: "TYPE_2_TWO_WAY_DOOR", confidence: 0.95 },
};

describe("adversarial corpus", () => {
  it("is well formed", () => {
    expect(cases.length).toBeGreaterThan(0);
    const ids = cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of cases) {
      expect(ATTACKS, c.id).toContain(c.attack);
      expect(["block", "pass"], c.id).toContain(c.expect);
      expect(c.files.length, c.id).toBeGreaterThan(0);
      expect(c.note, c.id).not.toBe("");
      for (const j of c.judgements) expect(judgements.map((x) => x.id), c.id).toContain(j);
      // Only a control is a sound PR; every other case is an attempt to get an unsound one through.
      expect(c.expect, c.id).toBe(c.attack === "control" ? "pass" : "block");
    }
  });

  it("has an attack and a control for each judgement it covers", () => {
    for (const id of ["one-way-door", "api-contract-regex", "api-contract-answers"]) {
      const mine = cases.filter((c) => c.judgements.includes(id));
      expect(mine.some((c) => c.attack === "control"), id).toBe(true);
      expect(mine.some((c) => c.attack !== "control"), id).toBe(true);
    }
  });

  it("every case reaches Jev for the judgements it grades", async () => {
    for (const c of cases) {
      const run = await runCase(c, judgements, cfg, fakeJev(() => 0.5));
      expect(run.skipped, c.id).toBeUndefined();
    }
  });

  it("cap cases overflow the diff budget as designed", () => {
    for (const id of ["ow-cap-later-file", "ow-cap-later-file-plan", "ow-cap-same-file", "ow-cap-same-file-plan", "ow-cap-migration-first"]) {
      expect(buildContext(byId(id)).diffTruncated, id).toBe(true);
    }
    // Each file has a share of the budget, so a small file after a big one is still read in full.
    expect(buildContext(byId("ow-cap-later-file")).patchExtract).toContain("DROP TABLE legacy_invoices");
    expect(buildContext(byId("ow-cap-migration-first")).patchExtract).toContain("DROP TABLE legacy_invoices");
    // A lockfile cannot hide a one-way door, so a big one is not a cap case: the control passes, and is not flagged.
    const lock = buildContext(byId("ow-ctl-big-lockfile"));
    expect(lock.diffTruncated).toBe(false);
    expect(lock.patchExtract).toContain("renderSuggestions");
    // A hunk past the cut in one big file is never seen; the truncation flag is what stops it.
    expect(buildContext(byId("ow-cap-same-file")).patchExtract).not.toContain("DROP TABLE users");
  });
});

/** A Jev stand-in that answers whatever was asked: a choice gets its first option, a number comes from `noul(key)`. */
function fakeJev(noul: (key: string) => number): typeof fetch {
  return (async (_url: unknown, init: { body: string }) => {
    const { questions } = JSON.parse(init.body) as { questions: Record<string, { type: string; criteria: Record<string, string> }> };
    const answers = Object.fromEntries(
      Object.entries(questions).map(([k, q]) => [k, q.type === "choice" ? { choice: Object.keys(q.criteria)[0], confidence: 0.9 } : { noul: noul(k) }]),
    );
    return new Response(JSON.stringify({ answers }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("grading", () => {
  it("scores a block expectation by whether the judgement failed", () => {
    expect(grade("block", "failure")).toBe("held");
    expect(grade("block", "success")).toBe("gamed");
    expect(grade("pass", "success")).toBe("held");
    expect(grade("pass", "failure")).toBe("false_block");
  });
});

describe("runCase", () => {
  it("counts a placeholder plan that the model accepts as gamed", async () => {
    const run = await runCase(byId("ow-ph-na"), judgements, cfg, jevReturning(PLAN_OK));
    expect(run.results).toHaveLength(1);
    expect(run.results[0]).toMatchObject({ judgement: "one-way-door", outcome: "gamed", reason: "type2_ok" });
  });

  it("counts the same PR as held when the model rejects the plan", async () => {
    const run = await runCase(byId("ow-ph-na"), judgements, cfg, jevReturning({ ...PLAN_OK, has_concrete_reversal_plan: { noul: 0.05 } }));
    expect(run.results[0]).toMatchObject({ outcome: "held", reason: "type2_no_plan" });
  });

  it("counts a sound control that is stopped as a false block", async () => {
    const run = await runCase(byId("ow-ctl-t2-real-plan"), judgements, cfg, jevReturning({ ...PLAN_OK, has_concrete_reversal_plan: { noul: 0.05 } }));
    expect(run.results[0].outcome).toBe("false_block");
  });

  it("grades both API-contract judgements from one request", async () => {
    const asked: string[] = [];
    // The model flags the breaking change (0.9) and finds no concrete migration path in the description (0.05).
    const fetchFn = fakeJev((k) => {
      asked.push(k);
      return k.includes("evidence") ? 0.05 : k.startsWith("api-contract") ? 0.9 : 0.1;
    });
    const run = await runCase(byId("api-ph-na"), judgements, cfg, fetchFn);
    expect(asked).toEqual(expect.arrayContaining(["api-contract-regex.q", "api-contract-answers.q", "api-contract-answers.evidence0"]));
    const outcomes = Object.fromEntries(run.results.map((r) => [r.judgement, r.outcome]));
    // `Migration Plan: n/a` clears the regex form; the model-judged form is not satisfied by it.
    expect(outcomes).toEqual({ "api-contract-regex": "gamed", "api-contract-answers": "held" });
    expect(run.results.find((r) => r.judgement === "api-contract-regex")).toMatchObject({ fired: true, cleared: true });
  });
});

describe("report", () => {
  it("summarises runs per case and attack", async () => {
    const c = byId("ow-ph-na");
    const runs: CaseRun[] = [
      await runCase(c, judgements, cfg, jevReturning(PLAN_OK)),
      await runCase(c, judgements, cfg, jevReturning({ ...PLAN_OK, has_concrete_reversal_plan: { noul: 0.05 } })),
    ];
    const { rows } = summarise([c], runs);
    expect(rows).toMatchObject([{ caseId: "ow-ph-na", runs: 2, gamed: 1, held: 1, reasons: expect.arrayContaining(["type2_ok", "type2_no_plan"]) }]);
    const text = renderReport([c], runs, { model: "m", runsPerCase: 2 });
    expect(text).toContain("GAMED 1/2");
    expect(text).toContain("placeholder");
  });
});
