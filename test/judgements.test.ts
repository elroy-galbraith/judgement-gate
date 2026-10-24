import { describe, expect, it } from "vitest";
import { appliesToFiles, matchesGlob } from "../src/glob";
import { compileDeclarative } from "../src/judgements/declarative";
import { DEFAULT_PROBES, oneWayDoor } from "../src/judgements/one-way-door";
import type { JevAnswers, PrContext } from "../src/types";

describe("glob", () => {
  it("matches ** across directories", () => {
    expect(matchesGlob("services/api/**", "services/api/v1/x.ts")).toBe(true);
    expect(matchesGlob("services/api/**", "services/web/x.ts")).toBe(false);
  });
  it("* does not cross directories", () => {
    expect(matchesGlob("docs/api-changes/*.md", "docs/api-changes/a.md")).toBe(true);
    expect(matchesGlob("docs/*.md", "docs/a/b.md")).toBe(false);
  });
  it("**/ matches zero or more directories", () => {
    expect(matchesGlob("**/*.sql", "a/b/c.sql")).toBe(true);
    expect(matchesGlob("**/*.sql", "c.sql")).toBe(true);
  });
  it("? matches one non-slash char", () => {
    expect(matchesGlob("a?c", "abc")).toBe(true);
    expect(matchesGlob("a?c", "a/c")).toBe(false);
  });
  it("appliesToFiles: undefined means always, otherwise any match", () => {
    expect(appliesToFiles(undefined, [])).toBe(true);
    expect(appliesToFiles(["x/**"], [{ filename: "y.ts", status: "added" }])).toBe(false);
    expect(appliesToFiles(["x/**"], [{ filename: "x/y.ts", status: "added" }])).toBe(true);
  });
});

const pr = (files: PrContext["files"] = [{ filename: "src/a.ts", status: "modified" }]): PrContext => ({
  title: "t",
  body: "",
  baseBranch: "main",
  headSha: "abc",
  files,
  patchExtract: "",
});

function answers(o: { one: number; add: number; rev: number; cls: string; conf: number }): JevAnswers {
  return {
    is_one_way_boundary_mutation: { noul: o.one },
    is_additive_or_isolated: { noul: o.add },
    has_concrete_reversal_plan: { noul: o.rev },
    synthetic_classification: { choice: o.cls, confidence: o.conf },
  };
}
const type1 = answers({ one: 0.96, add: 0.1, rev: 0.1, cls: "TYPE_1_ONE_WAY_DOOR", conf: 0.8 });
const type2 = answers({ one: 0.02, add: 0.9, rev: 0.9, cls: "TYPE_2_TWO_WAY_DOOR", conf: 0.9 });

describe("one-way-door judgement", () => {
  const j = oneWayDoor();
  it("has a stable id and the four questions", () => {
    expect(j.id).toBe("one-way-door");
    expect(Object.keys(j.questions)).toEqual([
      "is_one_way_boundary_mutation",
      "is_additive_or_isolated",
      "has_concrete_reversal_plan",
      "synthetic_classification",
    ]);
  });
  it("type1 without ADR fails; with ADR passes", () => {
    const f = j.decide(type1, pr());
    expect(f.conclusion).toBe("failure");
    expect(f.reason).toBe("type1_no_adr");
    const ok = j.decide(type1, pr([{ filename: "docs/decisions/0001-x.md", status: "added" }]));
    expect(ok.conclusion).toBe("success");
    expect(ok.reason).toBe("type1_adr");
  });
  it("type2 with plan passes", () => {
    expect(j.decide(type2, pr()).reason).toBe("type2_ok");
  });
  it("low confidence is ambiguous, and the threshold is overridable", () => {
    const low = answers({ one: 0.02, add: 0.9, rev: 0.9, cls: "TYPE_2_TWO_WAY_DOOR", conf: 0.5 });
    expect(j.decide(low, pr()).reason).toBe("ambiguous");
    expect(oneWayDoor({ confidenceThreshold: 0.4 }).decide(low, pr()).reason).toBe("type2_ok");
  });
  it("remedy teaches why and says what to do", () => {
    const rc = { owner: "o", repo: "r", headRef: "abc" };
    const r1 = j.remedy(j.decide(type1, pr()), rc);
    expect(r1.why).toContain("one-way door");
    expect(r1.fix).toContain("docs/decisions/");
    expect(r1.fix).toContain("https://github.com/o/r/new/abc");
    const noPlan = answers({ one: 0.02, add: 0.9, rev: 0.3, cls: "TYPE_2_TWO_WAY_DOOR", conf: 0.9 });
    const r2 = j.remedy(j.decide(noPlan, pr()), rc);
    expect(r2.fix).toContain("Reversal Trigger:");
    expect(r2.fix).toContain("Rollback Path:");
  });
  it("type1_adr remedy explains why a person still reviews it, not the ambiguous text", () => {
    const rc = { owner: "o", repo: "r", headRef: "abc" };
    const v = j.decide(type1, pr([{ filename: "docs/decisions/0001-x.md", status: "added" }]));
    const r = j.remedy(v, rc);
    expect(r.why).toContain("one-way door");
    expect(r.why).toContain("ADR");
    expect(r.why).not.toContain("could not confidently");
  });
  it("carries appliesTo", () => {
    expect(oneWayDoor({ appliesTo: ["db/**"] }).appliesTo).toEqual(["db/**"]);
  });
  it("remedy uses the branch name (not SHA) and falls back to plain text with the path when headRef is absent", () => {
    const verdict = j.decide(type1, pr());
    const withBranch = j.remedy(verdict, { owner: "o", repo: "r", headRef: "feat/add-adr" });
    expect(withBranch.fix).toContain("https://github.com/o/r/new/feat/add-adr?filename=docs/decisions/0001-title.md");
    expect(withBranch.fix).not.toContain("/new/abc");

    const fallback = j.remedy(verdict, { owner: "o", repo: "r" });
    expect(fallback.fix).toContain("`docs/decisions/NNNN-short-title.md`");
    expect(fallback.fix).not.toContain("Create one");
    expect(fallback.fix).not.toContain("/new/");
  });
  it("remedy escapes parentheses and RFC 3986 sub-delims in branch names so markdown links do not break", () => {
    const verdict = j.decide(type1, pr());
    const withParens = j.remedy(verdict, { owner: "o", repo: "r", headRef: "feature/fix)(x)" });
    expect(withParens.fix).toContain("%29%28x%29");
    const match = withParens.fix.match(/\[Create one\]\((https:\/\/[^)]+)\)\./);
    expect(match).not.toBeNull();
    const url = match![1];
    expect(url).toBe("https://github.com/o/r/new/feature/fix%29%28x%29?filename=docs/decisions/0001-title.md");
    expect(url).not.toContain(")");
  });
});

describe("one-way-door probes", () => {
  const j = oneWayDoor();
  const noPlan = answers({ one: 0.02, add: 0.9, rev: 0.3, cls: "TYPE_2_TWO_WAY_DOOR", conf: 0.9 });
  it("type1_no_adr gets the type 1 probes", () => {
    const v = j.decide(type1, pr());
    expect(v.reason).toBe("type1_no_adr");
    expect(j.probes!(v)).toEqual(DEFAULT_PROBES.type1);
    expect(DEFAULT_PROBES.type1).toHaveLength(5);
  });
  it("type2_no_plan gets the type 2 probes", () => {
    const v = j.decide(noPlan, pr());
    expect(v.reason).toBe("type2_no_plan");
    expect(j.probes!(v)).toEqual(DEFAULT_PROBES.type2);
    expect(DEFAULT_PROBES.type2).toHaveLength(3);
  });
  it("ambiguous gets the type 1 probes", () => {
    const low = answers({ one: 0.02, add: 0.9, rev: 0.9, cls: "TYPE_2_TWO_WAY_DOOR", conf: 0.5 });
    const v = j.decide(low, pr());
    expect(v.reason).toBe("ambiguous");
    expect(j.probes!(v)).toEqual(DEFAULT_PROBES.type1);
  });
  it("type1_adr (cleared) gets the type 1 probes, for the human reviewer", () => {
    const v = j.decide(type1, pr([{ filename: "docs/decisions/0001-x.md", status: "added" }]));
    expect(v.reason).toBe("type1_adr");
    expect(j.probes!(v)).toEqual(DEFAULT_PROBES.type1);
  });
  it("a passing verdict has no probes", () => {
    expect(j.probes!(j.decide(type2, pr()))).toEqual([]);
  });
  it("options override one list and keep the other default", () => {
    const custom = oneWayDoor({ probes: { type2: ["Custom?"] } });
    expect(custom.probes!(custom.decide(noPlan, pr()))).toEqual(["Custom?"]);
    expect(custom.probes!(custom.decide(type1, pr()))).toEqual(DEFAULT_PROBES.type1);
  });
});

describe("fired and reasons", () => {
  const src = [{ filename: "src/a.ts", status: "modified" }];
  const withAdr = [...src, { filename: "docs/decisions/0001-x.md", status: "added" }];
  const cases: [string, JevAnswers, PrContext["files"], string, boolean][] = [
    ["type1 without ADR", answers({ one: 0.9, add: 0.1, rev: 0.1, cls: "TYPE_1_ONE_WAY_DOOR", conf: 0.8 }), src, "type1_no_adr", true],
    ["type1 with ADR", answers({ one: 0.9, add: 0.1, rev: 0.1, cls: "TYPE_1_ONE_WAY_DOOR", conf: 0.8 }), withAdr, "type1_adr", true],
    ["ambiguous", answers({ one: 0.05, add: 0.9, rev: 0.9, cls: "TYPE_2_TWO_WAY_DOOR", conf: 0.5 }), src, "ambiguous", false],
    ["type2 with plan", answers({ one: 0.05, add: 0.9, rev: 0.9, cls: "TYPE_2_TWO_WAY_DOOR", conf: 0.9 }), src, "type2_ok", false],
    ["type2 without plan", answers({ one: 0.05, add: 0.9, rev: 0.1, cls: "TYPE_2_TWO_WAY_DOOR", conf: 0.9 }), src, "type2_no_plan", false],
  ];

  it.each(cases)("one-way-door %s", (_name, a, files, reason, fired) => {
    const j = oneWayDoor();
    const v = j.decide(a, pr(files));
    expect(v.reason).toBe(reason);
    expect(v.fired).toBe(fired);
    expect(j.reasons).toContain(reason);
  });

  it("one-way-door lists every reason code", () => {
    expect(oneWayDoor().reasons).toEqual(["type1_adr", "type1_no_adr", "ambiguous", "type2_ok", "type2_no_plan"]);
  });

  describe("declarative", () => {
    const j = compileDeclarative({
      id: "x",
      name: "X",
      question: "q?",
      whenTrue: "t",
      whenFalse: "f",
      threshold: 0.6,
      satisfiedBy: [{ pr_body_matches: /^Plan:/m }],
      why: "w",
      fix: "f",
    });
    const ans = (p: number): JevAnswers => ({ q: { noul: p } });
    const prBody = (body: string): PrContext => ({ ...pr(), body });

    it("over threshold and unsatisfied fails and fired", () => {
      const v = j.decide(ans(0.9), prBody("nothing"));
      expect(v.conclusion).toBe("failure");
      expect(v.fired).toBe(true);
    });
    it("over threshold and satisfied succeeds and fired", () => {
      const v = j.decide(ans(0.9), prBody("Plan: y"));
      expect(v.conclusion).toBe("success");
      expect(v.fired).toBe(true);
    });
    it("under threshold succeeds and did not fire", () => {
      const v = j.decide(ans(0.2), prBody("nothing"));
      expect(v.conclusion).toBe("success");
      expect(v.fired).toBe(false);
    });
    it("lists its reason codes", () => {
      expect(j.reasons).toEqual(["x_unsatisfied", "x_ok"]);
    });
  });
});
