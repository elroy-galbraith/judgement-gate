import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearConfigCache } from "../src/config";
import { processPullRequest } from "../src/handler";
import type { AnalyticsSink, Env, PullRequestEvent } from "../src/types";

type Call = { method: string; url: string; body?: any };

beforeEach(() => clearConfigCache());
afterEach(() => clearConfigCache());

async function makeEnv(extra: Partial<Env> = {}): Promise<Env> {
  const kp = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", kp.privateKey)) as ArrayBuffer);
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
  return {
    GITHUB_WEBHOOK_SECRET: "s",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: pem,
    JEV_API_KEY: "k",
    MODE: "enforce",
    GITHUB_API_URL: "https://gh.test",
    JEV_API_URL: "https://jev.test/decisions",
    ...extra,
  };
}

const prEvent = (): PullRequestEvent => ({
  action: "opened",
  installation: { id: 9 },
  repository: { name: "r", owner: { login: "o" } },
  pull_request: { number: 7, title: "SECRET-TITLE", body: "no plan SECRET-BODY", base: { ref: "main" }, head: { sha: "abc" } },
});

const CONFIG = `
judgements:
  - use: one-way-door
  - id: severity
    name: Severity
    classify:
      question: "If this change is wrong, how bad is the impact?"
      levels:
        - id: P0
          means: "customer-facing outage, data loss, or security exposure"
        - id: P1
          means: "major feature broken for many users, no workaround"
        - id: P3
          means: "internal or cosmetic; no customer impact"
    applies_to: ["services/**"]
`;

const benign = {
  is_one_way_boundary_mutation: { noul: 0.02 },
  is_additive_or_isolated: { noul: 0.9 },
  has_concrete_reversal_plan: { noul: 0.1 },
  synthetic_classification: { choice: "TYPE_2_TWO_WAY_DOOR", confidence: 0.9 },
};
const benignWithPlan = { ...benign, has_concrete_reversal_plan: { noul: 0.9 } };

const svcFile = { filename: "services/checkout/pay.ts", status: "modified", patch: "+SECRET-DIFF" };
const otherFile = { filename: "lib/other.ts", status: "modified", patch: "+x" };

function fakeNet(answers: Record<string, unknown>, files = [svcFile], config: string | null = CONFIG) {
  const calls: Call[] = [];
  const fetchFn = (async (input: any, init: any = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status });
    if (url.includes("jev.test")) return json({ answers });
    if (url.includes("/contents/")) return config === null ? new Response("", { status: 404 }) : new Response(config, { status: 200 });
    if (url.endsWith("/access_tokens")) return json({ token: "tok" }, 201);
    if (url.endsWith("/check-runs")) return json({ id: 55 }, 201);
    if (url.includes("/check-runs/55")) return json({});
    if (url.includes("/pulls/7/files")) return json(files);
    if (url.includes("/issues/7/comments") && method === "GET") return json([]);
    if (url.includes("/issues/7/comments") && method === "POST") return json({ id: 1 }, 201);
    if (url.endsWith("/issues/7/labels")) return json([{ name: "needs-human-review" }]);
    return json({ error: "unexpected " + url }, 500);
  }) as typeof fetch;
  return { calls, fetchFn };
}

const finalCheck = (calls: Call[]) => calls.filter((c) => c.method === "PATCH" && c.url.includes("/check-runs/55")).at(-1)?.body;
const comment = (calls: Call[]) => calls.find((c) => c.method === "POST" && c.url.endsWith("/issues/7/comments"))?.body?.body as string | undefined;
const labels = (calls: Call[]) => calls.filter((c) => c.url.endsWith("/issues/7/labels"));
const block = (md: string) => JSON.parse(md.match(/<!-- judgement-gate:v1 (\{.*\}) -->/)![1]);

const sev = (choice: string, confidence = 0.8) => ({ "severity.q": { choice, confidence } });

describe("severity through the handler", () => {
  it("asks Jev the choice question in the same request, namespaced and in level order", async () => {
    const net = fakeNet({ ...benignWithPlan, ...sev("P1") });
    await processPullRequest(prEvent(), await makeEnv(), net.fetchFn);
    const jevCalls = net.calls.filter((c) => c.url.includes("jev.test"));
    expect(jevCalls).toHaveLength(1);
    const q = jevCalls[0].body.questions["severity.q"];
    expect(q.type).toBe("choice");
    expect(q.instructions).toBe("If this change is wrong, how bad is the impact?");
    expect(Object.keys(q.criteria)).toEqual(["P0", "P1", "P3"]);
    expect(jevCalls[0].body.questions.synthetic_classification).toBeDefined();
  });

  it("puts the level in the summary line and posts no comment when nothing fails", async () => {
    const net = fakeNet({ ...benignWithPlan, ...sev("P1") });
    const v = await processPullRequest(prEvent(), await makeEnv(), net.fetchFn);
    expect(v.conclusion).toBe("success");
    const check = finalCheck(net.calls);
    expect(check.conclusion).toBe("success");
    expect(check.output.summary).toContain("- pass: Severity (P1)");
    expect(comment(net.calls)).toBeUndefined();
  });

  it("is P0 and still passes in enforce mode: it informs and never fails", async () => {
    const net = fakeNet({ ...benignWithPlan, ...sev("P0", 0.99) });
    await processPullRequest(prEvent(), await makeEnv({ MODE: "enforce" }), net.fetchFn);
    expect(finalCheck(net.calls).conclusion).toBe("success");
    expect(comment(net.calls)).toBeUndefined();
  });

  it("alone, never posts a comment and reports the level in the title", async () => {
    const config = CONFIG.replace("  - use: one-way-door\n", "");
    const net = fakeNet(sev("P3"), [svcFile], config);
    await processPullRequest(prEvent(), await makeEnv(), net.fetchFn);
    const check = finalCheck(net.calls);
    expect(check.conclusion).toBe("success");
    expect(check.output.title).toBe("Severity: P3");
    expect(check.output.summary).toContain("- pass: Severity (P3)");
    expect(comment(net.calls)).toBeUndefined();
  });

  it("rides along on a comment that is already posted for a failing judgement", async () => {
    const net = fakeNet({ ...benign, ...sev("P1", 0.82) });
    const v = await processPullRequest(prEvent(), await makeEnv(), net.fetchFn);
    expect(v.reason).toBe("type2_no_plan");
    expect(finalCheck(net.calls).conclusion).toBe("failure");
    const md = comment(net.calls)!;
    expect(md).toContain("**Severity:** P1 (confidence 0.82)");
    const b = block(md);
    expect(b.schema).toBe(1);
    expect(b.classification).toEqual([{ id: "severity", level: "P1", confidence: 0.82 }]);
    expect(b.failing.map((f: { id: string }) => f.id)).toEqual(["one-way-door"]);
    expect(md).not.toContain("#### Severity");
  });

  it("keeps PR and diff content out of the comment block", async () => {
    const net = fakeNet({ ...benign, ...sev("P1") });
    await processPullRequest(prEvent(), await makeEnv(), net.fetchFn);
    const raw = comment(net.calls)!.match(/<!-- judgement-gate:v1 .* -->/)![0];
    expect(raw).not.toContain("SECRET");
  });

  it("a level the model invents is reported as no level and cannot reach the comment", async () => {
    const net = fakeNet({ ...benign, "severity.q": { choice: "P0--><script>SECRET", confidence: 0.9 } });
    await processPullRequest(prEvent(), await makeEnv(), net.fetchFn);
    const md = comment(net.calls)!;
    expect(md).not.toContain("Severity:");
    expect(md).not.toContain("SECRET");
    expect(block(md)).not.toHaveProperty("classification");
    expect(finalCheck(net.calls).output.summary).toContain("- pass: Severity (no level reported)");
  });

  it.each([
    ["is missing", {}],
    ["has no choice", { "severity.q": {} }],
    ["is malformed", { "severity.q": { choice: 7 } }],
  ])("a severity answer that %s does not degrade the other judgements", async (_n, extra) => {
    const net = fakeNet({ ...benign, ...extra });
    const v = await processPullRequest(prEvent(), await makeEnv(), net.fetchFn);
    expect(v.reason).toBe("type2_no_plan");
    const check = finalCheck(net.calls);
    expect(check.conclusion).toBe("failure");
    expect(check.output.title).not.toContain("Degraded");
    expect(check.output.summary).toContain("FAIL: One-way door");
    expect(check.output.summary).toContain("- pass: Severity (no level reported)");
  });

  it("a missing one-way-door answer degrades without hiding severity", async () => {
    const net = fakeNet({ ...sev("P1"), is_one_way_boundary_mutation: { noul: 0.1 } });
    const v = await processPullRequest(prEvent(), await makeEnv(), net.fetchFn);
    expect(v.summary).toBe("[Audit Degraded]");
    expect(finalCheck(net.calls).output.summary).toContain("- pass: Severity (P1)");
    expect(finalCheck(net.calls).output.summary).toContain("- degraded: One-way door");
  });

  it("is not asked about, nor shown, when applies_to does not match", async () => {
    const net = fakeNet({ ...benignWithPlan }, [otherFile]);
    await processPullRequest(prEvent(), await makeEnv(), net.fetchFn);
    const jev = net.calls.find((c) => c.url.includes("jev.test"))!;
    expect(jev.body.questions["severity.q"]).toBeUndefined();
    expect(finalCheck(net.calls).output.summary).not.toContain("Severity");
  });

  it("does not influence review routing: a P0 on a reversible change still routes to an agent", async () => {
    const net = fakeNet({ ...benignWithPlan, ...sev("P0", 0.99) });
    await processPullRequest(prEvent(), await makeEnv(), net.fetchFn);
    expect(labels(net.calls)).toHaveLength(0);
    expect(finalCheck(net.calls).output.summary).toContain("Review routing: agent");
  });

  it("routing can still target an unreported severity", async () => {
    const config = CONFIG + "routing:\n  human_when:\n    - judgement: severity\n      reason: severity_unreported\n";
    const net = fakeNet({ ...benignWithPlan }, [svcFile], config);
    await processPullRequest(prEvent(), await makeEnv(), net.fetchFn);
    expect(labels(net.calls)).toHaveLength(1);
    expect(finalCheck(net.calls).output.summary).toContain("severity: severity_unreported");
  });

  it("a bare routing rule naming the classifier is a routing config error, judgements and check unaffected", async () => {
    const config = CONFIG + "routing:\n  human_when:\n    - judgement: severity\n";
    const net = fakeNet({ ...benignWithPlan, ...sev("P1") }, [svcFile], config);
    await processPullRequest(prEvent(), await makeEnv(), net.fetchFn);
    const check = finalCheck(net.calls);
    expect(check.conclusion).toBe("success");
    expect(check.output.summary).toContain("- pass: Severity (P1)");
    expect(check.output.summary).toContain("config error");
  });
});

describe("severity analytics", () => {
  const sink = () => {
    const points: { blobs?: string[]; doubles?: number[] }[] = [];
    const s: AnalyticsSink = { writeDataPoint: (p) => void points.push(p) };
    return { points, s };
  };

  it("records an evaluation event with the level, reason and confidence", async () => {
    const { points, s } = sink();
    const net = fakeNet({ ...benignWithPlan, ...sev("P1", 0.8) });
    await processPullRequest(prEvent(), await makeEnv({ ANALYTICS: s }), net.fetchFn);
    const p = points.find((x) => x.blobs?.[0] === "evaluation" && x.blobs[2] === "severity")!;
    expect(p.blobs?.slice(0, 6)).toEqual(["evaluation", "o/r", "severity", "enforce", "passed", "severity_classified"]);
    expect(p.blobs?.[7]).toBe("P1");
    expect(p.doubles?.slice(0, 5)).toEqual([7, 0, -1, 0.8, 0]);
  });

  it("records severity_unreported with no level blob", async () => {
    const { points, s } = sink();
    const net = fakeNet({ ...benignWithPlan });
    await processPullRequest(prEvent(), await makeEnv({ ANALYTICS: s }), net.fetchFn);
    const p = points.find((x) => x.blobs?.[2] === "severity")!;
    expect(p.blobs?.[5]).toBe("severity_unreported");
    expect(p.blobs).toHaveLength(7);
  });

  it("leaves other judgements' rows exactly as they were", async () => {
    const { points, s } = sink();
    const net = fakeNet({ ...benignWithPlan, ...sev("P1") });
    await processPullRequest(prEvent(), await makeEnv({ ANALYTICS: s }), net.fetchFn);
    const p = points.find((x) => x.blobs?.[2] === "one-way-door")!;
    expect(p.blobs).toHaveLength(7);
  });
});

// Two required judgements share one model response: neither may disable the other.
describe("partial degradation through the handler", () => {
  const rule = (id: string) => ({ id, name: id, question: `Risk for ${id}?`, true: "risky", false: "safe",
    threshold: 0.6, satisfied_by: [{ pr_body_matches: "^Plan:" }], why: "needs a plan", fix: "add Plan:" });
  const config = (reverse = false, routing?: unknown) => JSON.stringify({
    judgements: (reverse ? ["good", "bad"] : ["bad", "good"]).map(rule),
    routing: routing ?? { include_defaults: false, human_when: [{ judgement: "good" }, { judgement: "bad" }] },
  });

  it.each([false, true])("retains a healthy failure and its analytics (reverse=%s)", async (reverse) => {
    const points: { blobs?: string[] }[] = [];
    const net = fakeNet({ "bad.q": { noul: "broken" }, "good.q": { noul: 0.9 } }, [svcFile], config(reverse));
    const v = await processPullRequest(prEvent(), await makeEnv({ ANALYTICS: { writeDataPoint: p => void points.push(p) } }), net.fetchFn);
    expect(v).toMatchObject({ conclusion: "failure", reason: "good_unsatisfied" });
    const check = finalCheck(net.calls);
    expect(check.conclusion).toBe("failure");
    expect(check.output.summary).toContain("- degraded: bad");
    expect(check.output.summary).toContain("- FAIL: good");
    expect(labels(net.calls)).toHaveLength(1);
    const md = comment(net.calls)!;
    expect(md).toContain("**Fix:**");
    expect(md).toContain("bad");
    expect(block(md).failing.map((f: { id: string }) => f.id)).toEqual(["good"]);
    expect(points.filter(p => p.blobs?.[0] === "evaluation").map(p => p.blobs?.slice(2, 6))).toEqual(
      (reverse ? ["good", "bad"] : ["bad", "good"]).map(id =>
        [id, "enforce", id === "bad" ? "degraded" : "flagged", id === "bad" ? "degraded" : "good_unsatisfied"]));
  });

  it.each(["enforce", "shadow"])("keeps a healthy pass visible with incomplete coverage (%s)", async (mode) => {
    const points: { blobs?: string[] }[] = [];
    const net = fakeNet({ "good.q": { noul: 0.1 } }, [svcFile], config());
    const v = await processPullRequest(prEvent(), await makeEnv({ MODE: mode, ANALYTICS: { writeDataPoint: p => void points.push(p) } }), net.fetchFn);
    expect(v.conclusion).toBe(mode === "shadow" ? "success" : "neutral");
    expect(finalCheck(net.calls).conclusion).toBe(mode === "shadow" ? "success" : "neutral");
    expect(points.filter(p => p.blobs?.[0] === "evaluation").map(p => p.blobs?.[4])).toEqual(["degraded", "passed"]);
    expect(finalCheck(net.calls).output.summary).toContain("- pass: good");
    expect(finalCheck(net.calls).output.summary).toContain("- degraded: bad");
    expect(finalCheck(net.calls).output.summary).toContain("Review routing: unavailable");
    expect(comment(net.calls)).toBeUndefined();
  });

  it("still routes on changed files when all required answers are missing", async () => {
    const net = fakeNet({}, [svcFile], config(false, { include_defaults: false, human_when: [{ files: ["services/**"] }] }));
    expect((await processPullRequest(prEvent(), await makeEnv(), net.fetchFn)).conclusion).toBe("neutral");
    expect(labels(net.calls)).toHaveLength(1);
    expect(comment(net.calls)).not.toContain("passed the checks");
    expect(comment(net.calls)).not.toContain("all applicable judgements passed");
  });

  it("uses success in shadow mode and reports the underlying partial failure", async () => {
    const net = fakeNet({ "good.q": { noul: 0.9 } }, [svcFile], config());
    expect((await processPullRequest(prEvent(), await makeEnv({ MODE: "shadow" }), net.fetchFn)).conclusion).toBe("success");
    expect(finalCheck(net.calls).conclusion).toBe("success");
    expect(finalCheck(net.calls).output.summary).toContain("- FAIL: good (good: not satisfied) [shadow]");
    expect(block(comment(net.calls)!).failing[0].id).toBe("good");
  });
});

describe("classifier repository scope", () => {
  it("skips a classifier in another repo without degrading healthy judgements", async () => {
    const config = CONFIG.replace('    name: Severity', '    repos: [other]\n    mode: enforce\n    name: Severity');
    const net = fakeNet(benignWithPlan, [svcFile], config);
    await processPullRequest(prEvent(), await makeEnv(), net.fetchFn);
    const questions = net.calls.find(c => c.url.includes('jev.test'))!.body.questions;
    expect(questions['severity.q']).toBeUndefined();
    expect(questions.synthetic_classification).toBeDefined();
    expect(finalCheck(net.calls).conclusion).toBe('success');
    expect(finalCheck(net.calls).output.summary).not.toContain('Severity');
  });

  it("shows a classifier's effective mode and level when its repo glob matches", async () => {
    const config = CONFIG.replace('    name: Severity', '    repos: ["r*"]\n    mode: shadow\n    name: Severity');
    const net = fakeNet({ ...benignWithPlan, ...sev('P0') }, [svcFile], config);
    await processPullRequest(prEvent(), await makeEnv(), net.fetchFn);
    expect(finalCheck(net.calls).output.summary).toContain('Severity (P0) [shadow]');
    expect(finalCheck(net.calls).conclusion).toBe('success');
  });
});
