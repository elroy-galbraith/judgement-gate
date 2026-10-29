import { describe, expect, it } from "vitest";
import { DEFAULT_LABEL, DEFAULT_RULES, evaluateRouting, type RoutingRule, type RoutingSetup } from "../src/routing";
import type { JudgementResult } from "../src/aggregate";
import type { ChangedFile, Judgement } from "../src/types";

function res(id: string, reason: string, fired: boolean, probability?: number): JudgementResult {
  const judgement = { id, name: id, reasons: [reason] } as unknown as Judgement;
  return {
    judgement,
    verdict: {
      conclusion: "success",
      reason,
      summary: reason,
      fired,
      ...(probability === undefined ? {} : { metrics: { probability } }),
    },
  };
}

const ok = (rules: RoutingRule[] = DEFAULT_RULES): RoutingSetup => ({ status: "ok", rules, label: DEFAULT_LABEL });
const noFiles: ChangedFile[] = [];

describe("evaluateRouting with the default rules", () => {
  it("routes a fired type 1 to a human", () => {
    const r = evaluateRouting(ok(), [res("one-way-door", "type1_adr", true, 0.9)], noFiles);
    expect(r).toEqual({ route: "human", reasons: ["one-way-door flagged"], label: DEFAULT_LABEL });
  });

  it("routes an ambiguous verdict to a human even though it did not fire", () => {
    const r = evaluateRouting(ok(), [res("one-way-door", "ambiguous", false)], noFiles);
    expect(r.route).toBe("human");
    expect(r.reasons).toEqual(["one-way-door: ambiguous"]);
  });

  it.each(["type2_ok", "type2_no_plan"])("routes %s to an agent", (reason) => {
    const r = evaluateRouting(ok(), [res("one-way-door", reason, false)], noFiles);
    expect(r).toEqual({ route: "agent", reasons: [], label: DEFAULT_LABEL });
  });
});

describe("judgement rules", () => {
  const rules: RoutingRule[] = [{ judgement: "api" }];

  it("does not match an unfired judgement", () => {
    expect(evaluateRouting(ok(rules), [res("api", "no_break", false)], noFiles).route).toBe("agent");
  });

  it("matches a fired judgement", () => {
    const r = evaluateRouting(ok(rules), [res("api", "breaking", true)], noFiles);
    expect(r.route).toBe("human");
    expect(r.reasons).toEqual(["api flagged"]);
  });

  it("routes to an agent when the judgement was skipped", () => {
    expect(() => evaluateRouting(ok(rules), [res("other", "x", true)], noFiles)).not.toThrow();
    expect(evaluateRouting(ok(rules), [res("other", "x", false)], noFiles).route).toBe("agent");
  });

  it("matches a reason rule on reason alone, fired or not", () => {
    const r = evaluateRouting(ok([{ judgement: "api", reason: "odd" }]), [res("api", "odd", true)], noFiles);
    expect(r.reasons).toEqual(["api: odd"]);
    expect(evaluateRouting(ok([{ judgement: "api", reason: "odd" }]), [res("api", "odd", false)], noFiles).route).toBe("human");
  });

  it("does not match a reason rule when the reason differs", () => {
    expect(evaluateRouting(ok([{ judgement: "api", reason: "odd" }]), [res("api", "fine", true)], noFiles).route).toBe("agent");
  });

  it("lists every matching rule once", () => {
    const r = evaluateRouting(ok(), [res("one-way-door", "ambiguous", true)], noFiles);
    expect(r.route).toBe("human");
    expect(r.reasons).toEqual(["one-way-door flagged", "one-way-door: ambiguous"]);
  });

  it("does not duplicate identical rules", () => {
    const r = evaluateRouting(ok([{ judgement: "api" }, { judgement: "api" }]), [res("api", "x", true)], noFiles);
    expect(r.reasons).toEqual(["api flagged"]);
  });
});

describe("files rules", () => {
  const rules: RoutingRule[] = [{ files: ["migrations/**", "infra/*.tf"] }];

  it("matches a removed file", () => {
    const files: ChangedFile[] = [{ filename: "migrations/001.sql", status: "removed" }];
    const r = evaluateRouting(ok(rules), [], files);
    expect(r.route).toBe("human");
    expect(r.reasons).toEqual(["files: migrations/**"]);
  });

  it("reports the first matching glob", () => {
    const files: ChangedFile[] = [{ filename: "infra/main.tf", status: "modified" }];
    expect(evaluateRouting(ok(rules), [], files).reasons).toEqual(["files: infra/*.tf"]);
  });

  it("routes to an agent when no file matches", () => {
    const files: ChangedFile[] = [{ filename: "src/a.ts", status: "modified" }];
    expect(evaluateRouting(ok(rules), [], files).route).toBe("agent");
  });

  it("combines with judgement rules", () => {
    const files: ChangedFile[] = [{ filename: "migrations/001.sql", status: "added" }];
    const r = evaluateRouting(ok([...DEFAULT_RULES, ...rules]), [res("one-way-door", "type1_adr", true)], files);
    expect(r.reasons).toEqual(["one-way-door flagged", "files: migrations/**"]);
  });
});

describe("degraded audit (results null)", () => {
  const files: ChangedFile[] = [{ filename: "migrations/001.sql", status: "added" }];

  it("still routes a files match to a human", () => {
    const r = evaluateRouting(ok([{ files: ["migrations/**"] }]), null, files);
    expect(r.route).toBe("human");
    expect(r.reasons).toEqual(["files: migrations/**"]);
  });

  it("is unavailable when only judgement rules exist", () => {
    const r = evaluateRouting(ok(), null, files);
    expect(r).toEqual({ route: "unavailable", reasons: ["audit degraded"], label: DEFAULT_LABEL });
  });

  it("is unavailable when a files rule does not match", () => {
    const r = evaluateRouting(ok([{ files: ["docs/**"] }]), null, files);
    expect(r).toEqual({ route: "unavailable", reasons: ["audit degraded"], label: DEFAULT_LABEL });
  });
});

describe("non-ok setups", () => {
  it("routes a config error to a human", () => {
    const r = evaluateRouting({ status: "config_error", message: "bad rule", label: "custom" }, [], noFiles);
    expect(r).toEqual({ route: "human", reasons: ["config error: bad rule"], label: "custom" });
  });

  it("reports unavailable with the setup message", () => {
    const r = evaluateRouting({ status: "unavailable", message: "fetch failed", label: "custom" }, [], noFiles);
    expect(r).toEqual({ route: "unavailable", reasons: ["fetch failed"], label: "custom" });
  });
});


describe("partial degradation", () => {
  const degraded: JudgementResult = {
    judgement: res("api", "x", false).judgement,
    verdict: { conclusion: "neutral", reason: "degraded", fired: false, summary: "missing answers", invalidQuestions: ["api.q"] },
  };
  it("does not turn degradation into a matching judgement reason", () => {
    expect(evaluateRouting(ok([{ judgement: "api", reason: "degraded" }]), [degraded], noFiles).route).toBe("unavailable");
  });
  it("preserves a human match from a healthy judgement despite another missing result", () => {
    expect(evaluateRouting(ok([{ judgement: "api" }, { judgement: "good" }]), [degraded, res("good", "flagged", true)], noFiles))
      .toEqual({ route: "human", reasons: ["good flagged"], label: DEFAULT_LABEL });
  });
  it("does not make unrelated routing rules unavailable", () => {
    expect(evaluateRouting(ok([{ judgement: "good" }]), [degraded, res("good", "ok", false)], noFiles).route).toBe("agent");
  });
});
