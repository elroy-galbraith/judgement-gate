import { describe, expect, it } from "vitest";
import { aggregate, type JudgementResult } from "../src/aggregate";
import { renderComment } from "../src/comment";
import { buildRequest, evaluate, JevTimeout } from "../src/jev";
import type { Judgement, JudgementVerdict, PrContext } from "../src/types";

const pr: PrContext = { title: "t", body: "b", baseBranch: "main", headSha: "abc", files: [], patchExtract: "" };

const stub = (id: string, name = id): Judgement => ({
  id,
  name,
  questions: { q: { type: "noul", instructions: `ask ${id}`, criteria: { true: "y", false: "n" } } },
  decide: () => ({ conclusion: "success", reason: `${id}_ok`, summary: `${name} ok`, fired: false }),
  reasons: [],
  remedy: () => ({ why: `why ${id}`, fix: `fix ${id}` }),
});

const cfg = { apiKey: "k", url: "https://jev.test/d", model: "m", timeoutMs: 1000 };
const jevReturning = (answers: unknown) =>
  (async () => new Response(JSON.stringify({ answers }), { status: 200 })) as unknown as typeof fetch;

describe("jev request", () => {
  it("namespaces question keys by judgement id", () => {
    const req = buildRequest(pr, "m", [stub("a"), stub("b")]);
    expect(Object.keys(req.questions)).toEqual(["a.q", "b.q"]);
    expect(req.questions["a.q"].instructions).toBe("ask a");
  });

  it("returns answers per judgement with the namespace stripped", async () => {
    const out = await evaluate(pr, [stub("a"), stub("b")], cfg, jevReturning({ "a.q": { noul: 0.2 }, "b.q": { noul: 0.9 } }));
    expect(out).toEqual({ a: { status: "ok", answers: { q: { noul: 0.2 } } }, b: { status: "ok", answers: { q: { noul: 0.9 } } } });
  });

  it("degrades only the judgement with a missing required answer", async () => {
    const out = await evaluate(pr, [stub("a"), stub("b")], cfg, jevReturning({ "a.q": { noul: 0.2 } }));
    expect(out.a).toEqual({ status: "ok", answers: { q: { noul: 0.2 } } });
    expect(out.b).toEqual({ status: "degraded", invalidQuestions: ["b.q"] });
  });
});

const fail = (j: Judgement): { judgement: Judgement; verdict: JudgementVerdict } => ({
  judgement: j,
  verdict: { conclusion: "failure", reason: `${j.id}_bad`, summary: `${j.name} bad`, fired: true, signals: "sig" },
});
const pass = (j: Judgement) => ({ judgement: j, verdict: j.decide({}, pr) });
const rc = { owner: "o", repo: "r", headRef: "abc" };

describe("renderComment", () => {
  it("one failure: marker, summary heading, why and fix", () => {
    const md = renderComment([fail(stub("a", "Alpha"))], rc);
    expect(md.startsWith("<!-- judgement-gate -->")).toBe(true);
    expect(md).toContain("### judgement-gate: Alpha bad");
    expect(md).toContain("**Why:** why a");
    expect(md).toContain("**Fix:**");
    expect(md).toContain("fix a");
  });
  it("two failures: count heading and a section per judgement", () => {
    const md = renderComment([fail(stub("a", "Alpha")), fail(stub("b", "Beta"))], rc);
    expect(md).toContain("2 judgements need attention");
    expect(md).toContain("#### Alpha");
    expect(md).toContain("#### Beta");
  });
});

describe("aggregate", () => {
  it("empty list passes with no_applicable", () => {
    expect(aggregate([])).toEqual({ conclusion: "success", reason: "no_applicable", summary: "No applicable judgements" });
  });
  it("any failure fails with the first failing reason", () => {
    const v = aggregate([pass(stub("a")), fail(stub("b")), fail(stub("c"))]);
    expect(v.conclusion).toBe("failure");
    expect(v.reason).toBe("b_bad");
  });
  it("all pass succeeds", () => {
    expect(aggregate([pass(stub("a")), pass(stub("b"))]).conclusion).toBe("success");
  });
});

describe("jev answer validation", () => {
  it("degrades a judgement with a noul outside 0..1", async () => {
    await expect(evaluate(pr, [stub("a")], cfg, jevReturning({ "a.q": { noul: 1.5 } }))).resolves.toEqual({
      a: { status: "degraded", invalidQuestions: ["a.q"] },
    });
  });
  it("degrades a judgement with non-numeric choice confidence", async () => {
    const choice: Judgement = {
      ...stub("c"),
      questions: { k: { type: "choice", instructions: "pick", criteria: { A: "a", B: "b" } } },
    };
    await expect(evaluate(pr, [choice], cfg, jevReturning({ "c.k": { choice: "A", confidence: "high" } }))).resolves.toEqual({ c: { status: "degraded", invalidQuestions: ["c.k"] } });
  });
});


describe("validation isolation", () => {
  it.each([undefined, null, {}, { noul: "0.5" }, { noul: -0.1 }, { noul: 1.1 }])("isolates malformed answer %j", async (bad) => {
    const out = await evaluate(pr, [stub("a"), stub("b")], cfg, jevReturning({ "a.q": bad, "b.q": { noul: 0.4 } }));
    expect(out.a).toEqual({ status: "degraded", invalidQuestions: ["a.q"] });
    expect(out.b).toEqual({ status: "ok", answers: { q: { noul: 0.4 } } });
  });
  it("drops all partial answers for a required judgement and lists all invalid keys", async () => {
    const j = stub("a");
    j.questions = { q: j.questions.q, x: j.questions.q, y: j.questions.q };
    const out = await evaluate(pr, [j], cfg, jevReturning({ "a.q": { noul: 0.4 } }));
    expect(out.a).toEqual({ status: "degraded", invalidQuestions: ["a.x", "a.y"] });
  });
  it("retains valid optional answers and drops invalid ones", async () => {
    const j = { ...stub("a"), optionalAnswers: true };
    j.questions = { q: j.questions.q, x: j.questions.q };
    expect((await evaluate(pr, [j], cfg, jevReturning({ "a.q": { noul: 0.4 } }))).a)
      .toEqual({ status: "ok", answers: { q: { noul: 0.4 } } });
  });
  it.each(["not json", "null", "[]", '{"answers":5}', '{"answers":[]}'])("rejects an unreadable response %s", async (body) => {
    await expect(evaluate(pr, [stub("a")], cfg, (async () => new Response(body)) as typeof fetch)).rejects.toThrow();
  });
});

const degraded: JudgementResult = { judgement: stub("bad"), verdict: {
  conclusion: "neutral", reason: "degraded", summary: "missing answers", fired: false, invalidQuestions: ["bad.q"],
} };
describe("mixed aggregation", () => {
  it("preserves the reason and summary of a healthy failure", () => {
    expect(aggregate([degraded, fail(stub("good"))])).toEqual({ conclusion: "failure", reason: "good_bad", summary: "good bad" });
  });
  it.each([[degraded], [degraded, pass(stub("good"))]])("reports incomplete coverage as neutral", (...results) => {
    expect(aggregate(results)).toEqual({ conclusion: "neutral", reason: "degraded", summary: "[Audit Degraded]" });
  });
  it("does not claim every judgement passed in a partial comment", () => {
    const md = renderComment([], rc, "enforce", undefined, [degraded, pass(stub("good"))]);
    expect(md).toContain("audit incomplete");
    expect(md).toContain("Audit degraded");
    expect(md).not.toContain("all applicable judgements passed");
    expect(md).not.toContain("**Fix:**");
  });
});

const choiceJudgement = (optional = false): Judgement => ({
  ...stub("c"),
  optionalAnswers: optional,
  questions: { k: { type: "choice", instructions: "pick", criteria: { TYPE_1: "a", TYPE_2: "b" } } },
});

describe("jev choice answers", () => {
  it("degrades only the judgement whose choice is not one of the offered keys", async () => {
    const out = await evaluate(
      pr,
      [choiceJudgement(), stub("a")],
      cfg,
      jevReturning({ "c.k": { choice: "TYPE_3", confidence: 0.5 }, "a.q": { noul: 0.2 } }),
    );
    expect(out.c).toEqual({ status: "degraded", invalidQuestions: ["c.k"] });
    expect(out.a).toEqual({ status: "ok", answers: { q: { noul: 0.2 } } });
  });
  it("hands on the offered key for a choice that differs only in case or space", async () => {
    const out = await evaluate(pr, [choiceJudgement()], cfg, jevReturning({ "c.k": { choice: " type_1 ", confidence: 0.5 } }));
    expect(out.c).toEqual({ status: "ok", answers: { k: { choice: "TYPE_1", confidence: 0.5 } } });
  });
  it("leaves an unoffered choice out when the judgement tolerates missing answers", async () => {
    const out = await evaluate(pr, [choiceJudgement(true)], cfg, jevReturning({ "c.k": { choice: "TYPE_3" } }));
    expect(out.c).toEqual({ status: "ok", answers: {} });
  });
});

describe("jev retry", () => {
  const retryCfg = { ...cfg, retryDelayMs: 0 };
  const ok = () => new Response(JSON.stringify({ answers: { "a.q": { noul: 0.2 } } }), { status: 200 });
  const sequence = (...steps: (() => Response | Promise<Response>)[]) => {
    const calls = { n: 0 };
    const fn = (async () => {
      const step = steps[Math.min(calls.n, steps.length - 1)];
      calls.n++;
      return step();
    }) as unknown as typeof fetch;
    return { fn, calls };
  };

  it.each([429, 500, 503])("a %i then a 200 succeeds on the second attempt", async (status) => {
    const { fn, calls } = sequence(() => new Response("busy", { status }), ok);
    const out = await evaluate(pr, [stub("a")], retryCfg, fn);
    expect(out.a).toEqual({ status: "ok", answers: { q: { noul: 0.2 } } });
    expect(calls.n).toBe(2);
  });
  it("a network error then a 200 succeeds on the second attempt", async () => {
    const { fn, calls } = sequence(() => {
      throw new TypeError("network down");
    }, ok);
    await evaluate(pr, [stub("a")], retryCfg, fn);
    expect(calls.n).toBe(2);
  });
  it("tries only twice, then reports the last status", async () => {
    const { fn, calls } = sequence(() => new Response("busy", { status: 503 }));
    await expect(evaluate(pr, [stub("a")], retryCfg, fn)).rejects.toThrow("Jev -> 503 busy");
    expect(calls.n).toBe(2);
  });
  it("does not retry a 400 or a 401", async () => {
    for (const status of [400, 401]) {
      const { fn, calls } = sequence(() => new Response("no", { status }));
      await expect(evaluate(pr, [stub("a")], retryCfg, fn)).rejects.toThrow(`Jev -> ${status}`);
      expect(calls.n).toBe(1);
    }
  });
  it("a timeout during the retry is still reported as a timeout, within the original budget", async () => {
    const hang = (_url: string, init: RequestInit) =>
      new Promise<Response>((_res, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted"))));
    let n = 0;
    const fn = (async (url: string, init: RequestInit) => (n++ === 0 ? new Response("busy", { status: 503 }) : hang(url, init))) as unknown as typeof fetch;
    const start = Date.now();
    await expect(evaluate(pr, [stub("a")], { ...retryCfg, timeoutMs: 60 }, fn)).rejects.toBeInstanceOf(JevTimeout);
    expect(n).toBe(2);
    expect(Date.now() - start).toBeLessThan(500);
  });
  it("a pause longer than the budget times out instead of retrying late", async () => {
    const { fn, calls } = sequence(() => new Response("busy", { status: 503 }), ok);
    await expect(evaluate(pr, [stub("a")], { ...cfg, timeoutMs: 30, retryDelayMs: 5000 }, fn)).rejects.toBeInstanceOf(JevTimeout);
    expect(calls.n).toBe(1);
  });
});

describe("mode-aware aggregation", () => {
  const shadow = (r: JudgementResult): JudgementResult => ({ ...r, judgement: { ...r.judgement, mode: "shadow" } });
  it("ignores shadow failures when choosing the enforced failure reason", () => {
    expect(aggregate([shadow(fail(stub("trial"))), fail(stub("required"))])).toMatchObject({ conclusion: "failure", reason: "required_bad" });
  });
  it("does not claim all judgements passed with shadow findings", () => {
    const v = aggregate([pass(stub("required")), shadow(fail(stub("trial")))]);
    expect(v.conclusion).toBe("success");
    expect(v.summary).not.toContain("judgements passed");
  });
  it("keeps enforced incomplete coverage neutral despite a shadow failure", () => {
    expect(aggregate([degraded, shadow(fail(stub("trial")))])).toMatchObject({ conclusion: "neutral", reason: "degraded" });
  });
  it("does not let degraded shadow coverage neutralize an enforced pass or failure", () => {
    expect(aggregate([shadow(degraded), pass(stub("required"))]).conclusion).toBe("success");
    expect(aggregate([shadow(degraded), fail(stub("required"))]).conclusion).toBe("failure");
    expect(aggregate([shadow(degraded)]).conclusion).toBe("success");
  });
});
