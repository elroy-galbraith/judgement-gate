import { describe, expect, it } from "vitest";
import { aggregate } from "../src/aggregate";
import { clearConfigCache, ConfigError, loadGateConfig, parseConfig, parseGateConfig } from "../src/config";
import type { GitHubClient } from "../src/github";
import { buildRequest, evaluate } from "../src/jev";
import { compileClassifier } from "../src/judgements/classifier";
import { oneWayDoor } from "../src/judgements/one-way-door";
import type { Env, JevAnswers, PrContext } from "../src/types";

const pr: PrContext = { title: "t", body: "", baseBranch: "main", headSha: "abc", files: [{ filename: "services/a.ts", status: "modified" }], patchExtract: "" };

const severity = () =>
  compileClassifier({
    id: "severity",
    name: "Severity",
    question: "If this change is wrong, how bad is the impact?",
    levels: [
      { id: "P0", means: "outage or data loss" },
      { id: "P1", means: "major feature broken" },
      { id: "P3", means: "cosmetic" },
    ],
    appliesTo: ["services/**"],
  });

describe("classifier judgement", () => {
  const j = severity();

  it("asks one choice question whose criteria are level -> means, in order", () => {
    expect(j.id).toBe("severity");
    expect(j.kind).toBe("classifier");
    expect(j.appliesTo).toEqual(["services/**"]);
    expect(Object.keys(j.questions)).toEqual(["q"]);
    expect(j.questions.q.type).toBe("choice");
    expect(j.questions.q.instructions).toBe("If this change is wrong, how bad is the impact?");
    expect(Object.entries(j.questions.q.criteria)).toEqual([
      ["P0", "outage or data loss"],
      ["P1", "major feature broken"],
      ["P3", "cosmetic"],
    ]);
    expect(j.reasons).toEqual(["severity_classified", "severity_unreported"]);
  });

  it("reports the level and confidence, succeeds, and never fires", () => {
    const v = j.decide({ q: { choice: "P1", confidence: 0.82 } }, pr);
    expect(v).toMatchObject({
      conclusion: "success",
      fired: false,
      reason: "severity_classified",
      summary: "Severity: P1",
      classification: { level: "P1", confidence: 0.82 },
    });
    expect(v.metrics?.confidence).toBe(0.82);
  });

  it("matches the level ignoring case and whitespace, returning the configured spelling", () => {
    expect(j.decide({ q: { choice: " p0 " } }, pr).classification).toEqual({ level: "P0" });
  });

  it("omits confidence when the model gave none", () => {
    expect(j.decide({ q: { choice: "P3" } }, pr).classification).toEqual({ level: "P3" });
  });

  it.each([
    ["a level that is not configured", { q: { choice: "P9" } } as JevAnswers],
    ["an empty answer", { q: {} } as JevAnswers],
    ["no answer at all", {} as JevAnswers],
  ])("%s means no level reported, still success", (_n, answers) => {
    const v = j.decide(answers, pr);
    expect(v).toMatchObject({ conclusion: "success", fired: false, reason: "severity_unreported", summary: "Severity: no level reported" });
    expect(v.classification).toBeUndefined();
  });

  it("a successful classifier does not change aggregate()", () => {
    const v = j.decide({ q: { choice: "P0" } }, pr);
    expect(aggregate([{ judgement: j, verdict: v }])).toEqual({ conclusion: "success", reason: "severity_classified", summary: "Severity: P0" });
  });
});

describe("Jev request and answer handling", () => {
  const answersFor = (extra: Record<string, unknown>) => ({
    "severity.q": { choice: "P0", confidence: 0.9 },
    is_one_way_boundary_mutation: { noul: 0.1 },
    is_additive_or_isolated: { noul: 0.9 },
    has_concrete_reversal_plan: { noul: 0.9 },
    synthetic_classification: { choice: "TYPE_2_TWO_WAY_DOOR", confidence: 0.9 },
    ...extra,
  });
  const cfg = { apiKey: "k", url: "https://jev.test", model: "m", timeoutMs: 1000 };
  const run = (answers: Record<string, unknown>) =>
    evaluate(pr, [oneWayDoor(), severity()], cfg, (async () => new Response(JSON.stringify({ answers }))) as typeof fetch);

  it("sends the question under the namespaced key in the same request", () => {
    const req = buildRequest(pr, "m", [oneWayDoor(), severity()]);
    expect(Object.keys(req.questions)).toContain("severity.q");
    expect(Object.keys(req.questions)).toContain("synthetic_classification");
  });

  it("passes a good severity answer through", async () => {
    const out = await run(answersFor({}));
    expect(out.severity).toEqual({ status: "ok", answers: { q: { choice: "P0", confidence: 0.9 } } });
  });

  it.each([
    ["missing", { "severity.q": undefined }],
    ["an empty choice", { "severity.q": { choice: "" } }],
    ["a non-string choice", { "severity.q": { choice: 3 } }],
    ["a non-numeric confidence", { "severity.q": { choice: "P0", confidence: "high" } }],
  ])("a %s severity answer is left out and does not fail the request", async (_n, extra) => {
    const out = await run(answersFor(extra));
    expect(out.severity).toEqual({ status: "ok", answers: {} });
    expect(out["one-way-door"]).toMatchObject({ status: "ok", answers: { is_one_way_boundary_mutation: { noul: 0.1 } } });
    if (out.severity.status !== "ok") throw new Error("optional judgement degraded");
    expect(severity().decide(out.severity.answers, pr).reason).toBe("severity_unreported");
  });

  it("a missing one-way-door answer degrades only that judgement", async () => {
    const out = await run(answersFor({ is_additive_or_isolated: undefined }));
    expect(out["one-way-door"]).toEqual({ status: "degraded", invalidQuestions: ["is_additive_or_isolated"] });
    expect(out.severity.status).toBe("ok");
  });
});

describe("severity config", () => {
  const defaults = { confidenceThreshold: 0.75 };
  const levels = (n = 2) =>
    Array.from({ length: n }, (_v, i) => ({ id: `P${i}`, means: `means ${i}` }));
  const sev = (over: Record<string, unknown> = {}, classify: Record<string, unknown> = {}) => ({
    id: "severity",
    name: "Severity",
    classify: { question: "How bad?", levels: levels(2), ...classify },
    ...over,
  });
  const cfg = (...entries: unknown[]) => JSON.stringify({ judgements: entries });

  it("parses a classifier next to the built-in, keeping level order", () => {
    const list = parseConfig(
      cfg({ use: "one-way-door" }, sev({ applies_to: ["services/**"] }, { levels: [{ id: "P0", means: "a" }, { id: "P1", means: "b" }, { id: "P2", means: "c" }] })),
      defaults,
    );
    expect(list.map((j) => j.id)).toEqual(["one-way-door", "severity"]);
    const s = list[1];
    expect(s.kind).toBe("classifier");
    expect(s.appliesTo).toEqual(["services/**"]);
    expect(Object.keys(s.questions.q.criteria)).toEqual(["P0", "P1", "P2"]);
  });

  it("accepts free-form level ids", () => {
    const list = parseConfig(cfg(sev({}, { levels: [{ id: "Sev1", means: "a" }, { id: "S-2", means: "b" }, { id: "L3", means: "c" }] })), defaults);
    expect(Object.keys(list[0].questions.q.criteria)).toEqual(["Sev1", "S-2", "L3"]);
  });

  const bad: [string, string][] = [
    ["fewer than 2 levels", cfg(sev({}, { levels: levels(1) }))],
    ["levels not a list", cfg(sev({}, { levels: { P0: "a", P1: "b" } }))],
    ["no levels", cfg(sev({}, { levels: undefined }))],
    ["duplicate level ids", cfg(sev({}, { levels: [{ id: "P0", means: "a" }, { id: "P0", means: "b" }] }))],
    ["level ids that differ only in case", cfg(sev({}, { levels: [{ id: "P0", means: "a" }, { id: "p0", means: "b" }] }))],
    ["empty level id", cfg(sev({}, { levels: [{ id: "", means: "a" }, { id: "P1", means: "b" }] }))],
    ["all-digit level id (JS would reorder the question's criteria)", cfg(sev({}, { levels: [{ id: "2", means: "a" }, { id: "1", means: "b" }] }))],
    ["numeric level id", cfg(sev({}, { levels: [{ id: 0, means: "a" }, { id: 1, means: "b" }] }))],
    ["over-long level id", cfg(sev({}, { levels: [{ id: "P".repeat(33), means: "a" }, { id: "P1", means: "b" }] }))],
    ["level id with a space", cfg(sev({}, { levels: [{ id: "P 0", means: "a" }, { id: "P1", means: "b" }] }))],
    ["level without means", cfg(sev({}, { levels: [{ id: "P0" }, { id: "P1", means: "b" }] }))],
    ["level with empty means", cfg(sev({}, { levels: [{ id: "P0", means: " " }, { id: "P1", means: "b" }] }))],
    ["unknown key in a level", cfg(sev({}, { levels: [{ id: "P0", means: "a", mean: "x" }, { id: "P1", means: "b" }] }))],
    ["missing question", cfg(sev({}, { question: undefined }))],
    ["unknown key in classify", cfg(sev({}, { threshold: 0.5 }))],
    ["unknown key on the entry", cfg(sev({ threshold: 0.5 }))],
    ["satisfied_by on a classifier", cfg(sev({ satisfied_by: [{ file_added: "x" }] }))],
    ["missing name", cfg(sev({ name: undefined }))],
    ["classify not a mapping", cfg({ id: "severity", name: "S", classify: [] })],
    ["non-kebab id", cfg(sev({ id: "Severity Level" }))],
    ["id collides with a built-in", cfg(sev({ id: "one-way-door" }))],
    ["duplicate judgement id", cfg(sev(), sev())],
    ["empty applies_to", cfg(sev({ applies_to: [] }))],
    ["classify together with use", cfg({ use: "one-way-door", classify: {} })],
  ];
  it.each(bad)("rejects %s", (_n, text) => {
    expect(() => parseConfig(text, defaults)).toThrow(ConfigError);
  });

  it("names the judgement and level in errors", () => {
    expect(() => parseConfig(cfg(sev({}, { levels: [{ id: "P0", means: "a" }, { id: "P1" }] })), defaults)).toThrow(/severity.*levels\[1\].*means/);
  });

  it("a bad severity block falls back to the built-in with a note, and the routing label survives", async () => {
    clearConfigCache();
    const text = ["judgements:", "  - id: severity", "    name: S", "    classify:", "      question: q", "      levels: []", "routing:", "  label: mine", ""].join("\n");
    const gh = { getFileContents: async () => text } as unknown as GitHubClient;
    const out = await loadGateConfig(gh, "o", { CONFIDENCE_THRESHOLD: "0.75" } as Env);
    expect(out.judgements.map((j) => j.id)).toEqual(["one-way-door"]);
    expect(out.note).toMatch(/Config error: .*severity/);
    expect(out.routing).toMatchObject({ status: "config_error", label: "mine" });
    clearConfigCache();
  });

  describe("routing interaction", () => {
    const withRouting = (rule: unknown) => parseGateConfig(JSON.stringify({ judgements: [sev()], routing: { human_when: [rule] } }), defaults).routing;

    it("a bare judgement rule naming a classifier is a routing config error (it can never match)", () => {
      const r = withRouting({ judgement: "severity" });
      expect(r.status).toBe("config_error");
      expect((r as { message: string }).message).toMatch(/severity.*classifier.*never/);
    });

    it("judgement + severity_unreported is accepted", () => {
      expect(withRouting({ judgement: "severity", reason: "severity_unreported" }).status).toBe("ok");
    });

    it("an invalid routing block does not discard the classifier", () => {
      const text = JSON.stringify({ judgements: [sev()], routing: { human_when: [{ judgement: "severity" }] } });
      const g = parseGateConfig(text, defaults);
      expect(g.judgements.map((j) => j.id)).toEqual(["severity"]);
      expect(g.routing.status).toBe("config_error");
    });
  });
});
