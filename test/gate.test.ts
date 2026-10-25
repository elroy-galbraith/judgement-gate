import { describe, expect, it } from "vitest";
import { verifySignature } from "../src/crypto";
import { handleWebhook, processMergeGroup, processPullRequest } from "../src/handler";
import { buildPatchExtract, clearInstallationTokenCache, COMMENT_MARKER, installationToken } from "../src/github";
import { evaluatePolicy } from "../src/policy";
import type { Env, JevResult, MergeGroupEvent, PullRequestEvent } from "../src/types";

const j = (o: Partial<JevResult> = {}): JevResult => ({
  oneWayProb: 0.05,
  additiveProb: 0.9,
  reversalProb: 0.9,
  classification: "TYPE_2_TWO_WAY_DOOR",
  classificationConfidence: 0.9,
  ...o,
});
const opts = { confidenceThreshold: 0.75 };
const adr = [{ filename: "docs/decisions/0001-x.md", status: "added" }];
const src = [{ filename: "src/a.ts", status: "modified" }];

describe("policy", () => {
  it("type1 without ADR fails", () => {
    expect(evaluatePolicy(j({ oneWayProb: 0.5 }), src, opts).reason).toBe("type1_no_adr");
  });
  it("type1 by classification with ADR passes", () => {
    expect(evaluatePolicy(j({ classification: "TYPE_1_ONE_WAY_DOOR" }), adr, opts).conclusion).toBe("success");
  });
  it("removed ADR does not count", () => {
    const v = evaluatePolicy(j({ oneWayProb: 0.9 }), [{ filename: "docs/decisions/0001-x.md", status: "removed" }], opts);
    expect(v.conclusion).toBe("failure");
  });
  it("modifying an existing ADR does not count (issue #5)", () => {
    const v = evaluatePolicy(j({ oneWayProb: 0.9 }), [{ filename: "docs/decisions/0001-x.md", status: "modified" }], opts);
    expect(v.reason).toBe("type1_no_adr");
  });
  it("an ADR renamed into docs/decisions counts", () => {
    const f = [{ filename: "docs/decisions/0002-y.md", status: "renamed", previous_filename: "notes/y.md" }];
    expect(evaluatePolicy(j({ oneWayProb: 0.9 }), f, opts).reason).toBe("type1_adr");
  });
  it("renaming an ADR within docs/decisions does not count", () => {
    const f = [{ filename: "docs/decisions/0002-y.md", status: "renamed", previous_filename: "docs/decisions/0001-y.md" }];
    expect(evaluatePolicy(j({ oneWayProb: 0.9 }), f, opts).reason).toBe("type1_no_adr");
  });
  it("a copied ADR counts as a new file", () => {
    expect(evaluatePolicy(j({ oneWayProb: 0.9 }), [{ filename: "docs/decisions/0002-y.md", status: "copied" }], opts).reason).toBe("type1_adr");
  });
  it("ADR outside docs/decisions does not count", () => {
    expect(evaluatePolicy(j({ oneWayProb: 0.9 }), [{ filename: "docs/other/x.md", status: "added" }], opts).conclusion).toBe("failure");
  });
  it("low confidence is ambiguous", () => {
    expect(evaluatePolicy(j({ classificationConfidence: 0.5 }), src, opts).reason).toBe("ambiguous");
  });
  it("type2 with plan passes, without fails", () => {
    expect(evaluatePolicy(j(), src, opts).reason).toBe("type2_ok");
    expect(evaluatePolicy(j({ reversalProb: 0.69 }), src, opts).reason).toBe("type2_no_plan");
    expect(evaluatePolicy(j({ reversalProb: 0.7 }), src, opts).reason).toBe("type2_ok");
  });
  it("one-way threshold is strictly > 0.40", () => {
    expect(evaluatePolicy(j({ oneWayProb: 0.4 }), src, opts).reason).toBe("type2_ok");
  });
});

describe("patch extract", () => {
  it("puts migrations first and respects the budget", () => {
    const files = [
      { filename: "src/readme.ts", status: "modified", patch: "x".repeat(100) },
      { filename: "migrations/001.sql", status: "added", patch: "CREATE TABLE a;" },
    ];
    expect(buildPatchExtract(files).startsWith("--- migrations/001.sql")).toBe(true);
    expect(buildPatchExtract(files, 50).length).toBeLessThanOrEqual(50);
  });
});

async function sign(secret: string, body: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return "sha256=" + [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("signature", () => {
  it("accepts valid, rejects tampered or missing", async () => {
    const sig = await sign("s", "body");
    expect(await verifySignature("s", "body", sig)).toBe(true);
    expect(await verifySignature("s", "body2", sig)).toBe(false);
    expect(await verifySignature("s", "body", null)).toBe(false);
    expect(await verifySignature("wrong", "body", sig)).toBe(false);
  });
});

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

function prEvent(over: Partial<PullRequestEvent> = {}, body = "no plan"): PullRequestEvent {
  return {
    action: "opened",
    installation: { id: 9 },
    repository: { name: "r", owner: { login: "o" } },
    pull_request: { number: 7, title: "t", body, base: { ref: "main" }, head: { sha: "abc" } },
    ...over,
  };
}

function jevAnswer(o: { one: number; add: number; rev: number; cls: string; conf: number }) {
  return {
    answers: {
      is_one_way_boundary_mutation: { type: "noul", noul: o.one },
      is_additive_or_isolated: { type: "noul", noul: o.add },
      has_concrete_reversal_plan: { type: "noul", noul: o.rev },
      synthetic_classification: { type: "choice", choice: o.cls, confidence: o.conf, probabilities: {} },
    },
  };
}

/** Fake GitHub + Jev. Records calls and persists comment writes across evaluations. */
function fakeNet(jev: () => Response | Promise<Response>, existingComments: { id: number; body: string }[] = []) {
  const calls: { method: string; url: string; body?: any }[] = [];
  const comments = existingComments.map((comment) => ({ ...comment }));
  let nextCommentId = Math.max(0, ...comments.map((comment) => comment.id)) + 1;
  const fetchFn = (async (input: any, init: any = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
    if (url.includes("jev.test")) return jev();
    if (url.endsWith("/access_tokens")) return json({ token: "tok" }, 201);
    if (url.endsWith("/check-runs")) return json({ id: 55 }, 201);
    if (url.includes("/check-runs/55")) return json({});
    if (url.includes("/pulls/7/files")) return json([{ filename: "src/a.ts", status: "modified", patch: "+x" }]);
    if (url.includes("/issues/7/comments") && method === "GET") return json(comments);
    if (url.includes("/issues/7/comments") && method === "POST") {
      const comment = { id: nextCommentId++, body: body.body };
      comments.push(comment);
      return json(comment, 201);
    }
    if (url.includes("/issues/comments/") && method === "PATCH") {
      const comment = comments.find((c) => url.endsWith(`/issues/comments/${c.id}`));
      if (!comment) return json({ error: "comment not found" }, 404);
      comment.body = body.body;
      return json(comment);
    }
    return json({ error: "unexpected " + url }, 500);
  }) as typeof fetch;
  return { calls, comments, fetchFn };
}

const finalCheck = (calls: any[]) => calls.filter((c) => c.method === "PATCH" && c.url.includes("/check-runs/55")).at(-1)?.body;

describe("end to end", () => {
  it("type2 with plan -> success, no comment", async () => {
    const env = await makeEnv();
    const net = fakeNet(() => new Response(JSON.stringify(jevAnswer({ one: 0.02, add: 0.9, rev: 0.9, cls: "TYPE_2_TWO_WAY_DOOR", conf: 0.9 }))));
    await processPullRequest(prEvent(), env, net.fetchFn);
    expect(finalCheck(net.calls).conclusion).toBe("success");
    expect(net.calls.some((c) => c.method !== "GET" && c.url.includes("/issues/7/comments"))).toBe(false);
    expect(net.comments).toHaveLength(0);
  });

  it("type1 without ADR -> failure + one comment", async () => {
    const env = await makeEnv();
    const net = fakeNet(() => new Response(JSON.stringify(jevAnswer({ one: 0.96, add: 0.1, rev: 0.1, cls: "TYPE_1_ONE_WAY_DOOR", conf: 0.8 }))));
    await processPullRequest(prEvent(), env, net.fetchFn);
    expect(finalCheck(net.calls).conclusion).toBe("failure");
    expect(net.calls.filter((c) => c.method === "POST" && c.url.endsWith("/issues/7/comments"))).toHaveLength(1);
  });

  it("existing bot comment is edited, not duplicated", async () => {
    const env = await makeEnv();
    const net = fakeNet(
      () => new Response(JSON.stringify(jevAnswer({ one: 0.96, add: 0.1, rev: 0.1, cls: "TYPE_1_ONE_WAY_DOOR", conf: 0.8 }))),
      [{ id: 42, body: "<!-- judgement-gate --> old" }],
    );
    await processPullRequest(prEvent(), env, net.fetchFn);
    expect(net.calls.some((c) => c.method === "POST" && c.url.endsWith("/issues/7/comments"))).toBe(false);
    expect(net.calls.some((c) => c.method === "PATCH" && c.url.endsWith("/issues/comments/42"))).toBe(true);
  });

  it("fail then pass on the same PR updates the existing remediation comment", async () => {
    const env = await makeEnv({ CONFIG_REPO: "issue-4-config" });
    let reversalProbability = 0.1;
    const net = fakeNet(() => new Response(JSON.stringify(jevAnswer({
      one: 0.02, add: 0.9, rev: reversalProbability, cls: "TYPE_2_TWO_WAY_DOOR", conf: 0.9,
    }))));
    // Missing optional config selects the built-in judgements and default agent routing for Type 2.
    const fetchFn: typeof fetch = (input, init) =>
      String(input) === "https://gh.test/repos/o/issue-4-config/contents/.github/judgement-gate.yml"
        ? Promise.resolve(new Response("not found", { status: 404 }))
        : net.fetchFn(input, init);
    const event = prEvent();

    const failed = await processPullRequest(event, env, fetchFn);
    expect(failed.reason).toBe("type2_no_plan");
    expect(finalCheck(net.calls).conclusion).toBe("failure");
    expect(net.comments).toHaveLength(1);
    const original = { ...net.comments[0] };
    expect(original.body).toContain(COMMENT_MARKER);
    expect(original.body).toContain("**Fix:**");

    // The author edits the description; Jev now recognises a concrete reversal plan.
    event.action = "edited";
    event.changes = { body: { from: event.pull_request.body ?? "" } };
    event.pull_request.body = "Reversal Trigger: error rate exceeds 2% for 5 minutes\nRollback Path: revert this PR";
    reversalProbability = 0.9;
    const passed = await processPullRequest(event, env, fetchFn);

    expect(passed.reason).toBe("type2_ok");
    expect(finalCheck(net.calls).conclusion).toBe("success");
    expect(finalCheck(net.calls).output.summary).toContain("Review routing: agent");
    expect(net.comments).toHaveLength(1);
    expect(net.comments[0].id).toBe(original.id);
    expect(net.calls.filter((c) => c.method === "POST" && c.url.endsWith("/issues/7/comments"))).toHaveLength(1);
    expect.soft(net.comments[0].body).not.toBe(original.body);
    expect.soft(net.comments[0].body).toContain(COMMENT_MARKER);
    expect.soft(net.comments[0].body).toMatch(/passed|verified/i);
    expect.soft(net.comments[0].body).not.toContain("**Fix:**");
    expect.soft(net.comments[0].body).not.toContain("type2_no_plan");
    expect.soft(net.calls.filter((c) => c.method === "PATCH" && c.url.endsWith(`/issues/comments/${original.id}`))).toHaveLength(1);

    const agentBlock = net.comments[0].body.match(/<!-- judgement-gate:v1 (\{.*\}) -->/);
    expect(agentBlock).not.toBeNull();
    expect(JSON.parse(agentBlock![1]).failing).toEqual([]);

    // Re-evaluating the same passing PR does not write the unchanged note again.
    await processPullRequest(event, env, fetchFn);
    expect(net.calls.filter((c) => c.method === "PATCH" && c.url.endsWith(`/issues/comments/${original.id}`))).toHaveLength(1);

    reversalProbability = 0.1;
    event.pull_request.body = "no plan";
    await processPullRequest(event, env, fetchFn);
    expect(finalCheck(net.calls).conclusion).toBe("failure");
    expect(net.comments).toEqual([original]);
    expect(net.calls.filter((c) => c.method === "POST" && c.url.endsWith("/issues/7/comments"))).toHaveLength(1);
  });

  it.each(["GET", "PATCH"])("a passing comment %s failure keeps the successful verdict", async (method) => {
    const env = await makeEnv();
    const old = { id: 42, body: `${COMMENT_MARKER} old remediation` };
    const net = fakeNet(
      () => new Response(JSON.stringify(jevAnswer({ one: 0.02, add: 0.9, rev: 0.9, cls: "TYPE_2_TWO_WAY_DOOR", conf: 0.9 }))),
      [old],
    );
    const fetchFn: typeof fetch = (input, init) =>
      String(input).includes("/issues/") && (init?.method ?? "GET") === method
        ? Promise.resolve(new Response("forbidden", { status: 403 }))
        : net.fetchFn(input, init);
    const verdict = await processPullRequest(prEvent(), env, fetchFn);
    expect(verdict.reason).toBe("type2_ok");
    expect(finalCheck(net.calls).conclusion).toBe("success");
    expect(finalCheck(net.calls).output.summary).toContain("Could not post the passing comment");
    expect(net.comments).toEqual([old]);
  });

  it.each([false, true])("passing cleanup leaves unrelated comments untouched (gate comment present: %s)", async (hasGateComment) => {
    const unrelated = { id: 10, body: "Please review the rollback instructions." };
    const old = { id: 42, body: `${COMMENT_MARKER} old remediation` };
    const net = fakeNet(
      () => new Response(JSON.stringify(jevAnswer({ one: 0.02, add: 0.9, rev: 0.9, cls: "TYPE_2_TWO_WAY_DOOR", conf: 0.9 }))),
      hasGateComment ? [unrelated, old] : [unrelated],
    );
    await processPullRequest(prEvent(), await makeEnv(), net.fetchFn);
    expect(finalCheck(net.calls).conclusion).toBe("success");
    expect(net.comments[0]).toEqual(unrelated);
    expect(net.comments).toHaveLength(hasGateComment ? 2 : 1);
    expect(net.calls.filter((c) => c.method === "POST" && c.url.endsWith("/issues/7/comments"))).toHaveLength(0);
    const patches = net.calls.filter((c) => c.method === "PATCH" && c.url.includes("/issues/comments/"));
    expect(patches).toHaveLength(hasGateComment ? 1 : 0);
    if (hasGateComment) {
      expect(patches[0].url).toMatch(/\/issues\/comments\/42$/);
      expect(net.comments[1].body).toContain("all applicable judgements passed");
    }
  });

  it("two failures then one then none update the same comment and clear its agent instructions", async () => {
    const env = await makeEnv({ CONFIG_REPO: "issue-4-multiple" });
    const config = `judgements:\n${["alpha", "beta"].map((id) => `
  - id: ${id}
    name: ${id}
    question: "Does this change need a ${id} plan?"
    true: "needs a plan"
    false: "no plan needed"
    threshold: 0.6
    satisfied_by:
      - pr_body_matches: "${id} plan"
    why: "A plan makes this change safe."
    fix: "Add the ${id} plan."
`).join("")}`;
    const net = fakeNet(() => new Response(JSON.stringify({ answers: { "alpha.q": { noul: 0.9 }, "beta.q": { noul: 0.9 } } })));
    const fetchFn: typeof fetch = (input, init) =>
      String(input) === "https://gh.test/repos/o/issue-4-multiple/contents/.github/judgement-gate.yml"
        ? Promise.resolve(new Response(config))
        : net.fetchFn(input, init);
    const event = prEvent();
    const failingIds = () => JSON.parse(net.comments[0].body.match(/<!-- judgement-gate:v1 (\{.*\}) -->/)![1]).failing.map((f: { id: string }) => f.id);

    await processPullRequest(event, env, fetchFn);
    expect(finalCheck(net.calls).conclusion).toBe("failure");
    expect(failingIds()).toEqual(["alpha", "beta"]);
    expect(net.comments[0].body).toContain("2 judgements need attention");
    const id = net.comments[0].id;

    event.pull_request.body = "alpha plan";
    await processPullRequest(event, env, fetchFn);
    expect(finalCheck(net.calls).conclusion).toBe("failure");
    expect(failingIds()).toEqual(["beta"]);
    expect(net.comments[0].body).not.toContain("#### alpha");
    expect(net.comments[0].body).toContain("#### beta");

    event.pull_request.body = "alpha plan\nbeta plan";
    await processPullRequest(event, env, fetchFn);
    expect(finalCheck(net.calls).conclusion).toBe("success");
    expect(failingIds()).toEqual([]);
    expect(net.comments[0].body).toContain("all applicable judgements passed");
    expect(net.comments[0].body).not.toContain("**Fix:**");
    expect(net.comments).toHaveLength(1);
    expect(net.comments[0].id).toBe(id);
    expect(net.calls.filter((c) => c.method === "POST" && c.url.endsWith("/issues/7/comments"))).toHaveLength(1);
    expect(net.calls.filter((c) => c.method === "PATCH" && c.url.endsWith(`/issues/comments/${id}`))).toHaveLength(2);
  });

  it("comment failure keeps the real verdict", async () => {
    const env = await makeEnv();
    const net = fakeNet(() => new Response(JSON.stringify(jevAnswer({ one: 0.96, add: 0.1, rev: 0.1, cls: "TYPE_1_ONE_WAY_DOOR", conf: 0.8 }))));
    const failing = ((input: any, init: any) =>
      String(input).includes("/issues/7/comments") ? Promise.resolve(new Response("forbidden", { status: 403 })) : net.fetchFn(input, init)) as typeof fetch;
    const v = await processPullRequest(prEvent(), env, failing);
    expect(v.reason).toBe("type1_no_adr");
    expect(finalCheck(net.calls).conclusion).toBe("failure");
    expect(finalCheck(net.calls).output.summary).toContain("Could not post");
  });

  it("shadow mode always concludes success", async () => {
    const env = await makeEnv({ MODE: "shadow" });
    const net = fakeNet(() => new Response(JSON.stringify(jevAnswer({ one: 0.96, add: 0.1, rev: 0.1, cls: "TYPE_1_ONE_WAY_DOOR", conf: 0.8 }))));
    await processPullRequest(prEvent(), env, net.fetchFn);
    expect(finalCheck(net.calls).conclusion).toBe("success");
    expect(finalCheck(net.calls).output.title).toContain("[Shadow]");
    expect(net.comments[0].body).toContain("**Fix:**");
  });

  it("Jev outage -> neutral [Audit Degraded]", async () => {
    const env = await makeEnv();
    const old = { id: 42, body: `${COMMENT_MARKER} old remediation` };
    const net = fakeNet(() => new Response("boom", { status: 503 }), [old]);
    const v = await processPullRequest(prEvent(), env, net.fetchFn);
    expect(v.reason).toBe("degraded");
    expect(finalCheck(net.calls).conclusion).toBe("neutral");
    expect(net.comments).toEqual([old]);
    expect(net.calls.some((c) => c.url.includes("/issues/"))).toBe(false);
  });

  it("Jev timeout -> neutral", async () => {
    const env = await makeEnv({ JEV_TIMEOUT_MS: "20" });
    const net = fakeNet(() => new Promise<Response>(() => {}));
    const fetchFn = ((input: any, init: any) =>
      String(input).includes("jev.test")
        ? new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))))
        : net.fetchFn(input, init)) as typeof fetch;
    const v = await processPullRequest(prEvent(), env, fetchFn);
    expect(v.reason).toBe("degraded");
    expect(finalCheck(net.calls).output.summary).toContain("20ms");
  });
});

/** Wrap a fake network so that the first `times` calls whose URL matches (and method, if given) answer 500. */
function failing(net: ReturnType<typeof fakeNet>, match: (url: string, method: string) => boolean, times = Infinity) {
  let seen = 0;
  const fetchFn = ((input: any, init: any = {}) =>
    match(String(input), init.method ?? "GET") && seen++ < times ? Promise.resolve(new Response("down", { status: 500 })) : net.fetchFn(input, init)) as typeof fetch;
  return fetchFn;
}
const answer = () => new Response(JSON.stringify(jevAnswer({ one: 0.02, add: 0.9, rev: 0.9, cls: "TYPE_2_TWO_WAY_DOOR", conf: 0.9 })));
const createsCheck = (u: string, m: string) => m === "POST" && u.endsWith("/check-runs");
const completesCheck = (u: string, m: string) => m === "PATCH" && u.includes("/check-runs/55");
const noWait = [0, 0];

describe("required check is never left missing or in progress (issue #14)", () => {
  it("failing to list files after the check run exists completes it neutral", async () => {
    clearInstallationTokenCache();
    const env = await makeEnv();
    const net = fakeNet(answer);
    const v = await processPullRequest(prEvent(), env, failing(net, (u) => u.includes("/pulls/7/files")), noWait);
    expect(v.reason).toBe("degraded");
    expect(finalCheck(net.calls).conclusion).toBe("neutral");
    expect(finalCheck(net.calls).output.title).toBe("[Audit Degraded]");
  });

  it("retries a failed token request", async () => {
    clearInstallationTokenCache();
    const env = await makeEnv();
    const net = fakeNet(answer);
    await processPullRequest(prEvent(), env, failing(net, (u) => u.endsWith("/access_tokens"), 2), noWait);
    expect(net.calls.filter((c) => c.url.endsWith("/access_tokens"))).toHaveLength(1);
    expect(finalCheck(net.calls).conclusion).toBe("success");
  });

  it("retries a failed check run creation", async () => {
    clearInstallationTokenCache();
    const env = await makeEnv();
    const net = fakeNet(answer);
    await processPullRequest(prEvent(), env, failing(net, createsCheck, 2), noWait);
    expect(net.calls.filter((c) => createsCheck(c.url, c.method))).toHaveLength(1);
    expect(finalCheck(net.calls).conclusion).toBe("success");
  });

  it("retries completing the check run", async () => {
    clearInstallationTokenCache();
    const env = await makeEnv();
    const net = fakeNet(answer);
    await processPullRequest(prEvent(), env, failing(net, completesCheck, 2), noWait);
    expect(net.calls.filter((c) => completesCheck(c.url, c.method))).toHaveLength(1);
    expect(finalCheck(net.calls).conclusion).toBe("success");
  });

  it("gives up after three attempts and reports nothing when no check run can be created", async () => {
    clearInstallationTokenCache();
    const env = await makeEnv();
    const net = fakeNet(answer);
    const fetchFn = failing(net, createsCheck);
    await expect(processPullRequest(prEvent(), env, fetchFn, noWait)).rejects.toThrow(/check-runs/);
    expect(net.calls.filter((c) => createsCheck(c.url, c.method))).toHaveLength(0);
    expect(net.calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(net.calls.some((c) => c.url.includes("jev.test"))).toBe(false);
  });

  it("gives up after three attempts when no installation token can be made", async () => {
    clearInstallationTokenCache();
    const env = await makeEnv();
    const net = fakeNet(answer);
    await expect(processPullRequest(prEvent(), env, failing(net, (u) => u.endsWith("/access_tokens")), noWait)).rejects.toThrow(/installation token/);
    expect(net.calls).toHaveLength(0);
  });

  it("still resolves when the check run cannot be completed at all", async () => {
    clearInstallationTokenCache();
    const env = await makeEnv();
    const net = fakeNet(answer);
    const attempts: string[] = [];
    const fetchFn = ((input: any, init: any = {}) => {
      if (completesCheck(String(input), init.method ?? "GET")) attempts.push(init.body);
      return failing(net, completesCheck)(input, init);
    }) as typeof fetch;
    const v = await processPullRequest(prEvent(), env, fetchFn, noWait);
    expect(v.reason).toBe("degraded");
    // Three attempts at the real verdict, then three at the neutral fallback.
    expect(attempts).toHaveLength(6);
    expect(JSON.parse(attempts[0]).conclusion).toBe("success");
    expect(JSON.parse(attempts[5]).conclusion).toBe("neutral");
  });
});

describe("webhook filtering", () => {
  async function post(ev: any, opts: { event?: string; sig?: string | null } = {}) {
    const env = await makeEnv();
    const body = JSON.stringify(ev);
    const pending: Promise<unknown>[] = [];
    const headers: Record<string, string> = { "X-GitHub-Event": opts.event ?? "pull_request" };
    const sig = opts.sig === undefined ? await sign(env.GITHUB_WEBHOOK_SECRET, body) : opts.sig;
    if (sig) headers["X-Hub-Signature-256"] = sig;
    const net = fakeNet(() => new Response(JSON.stringify(jevAnswer({ one: 0, add: 1, rev: 1, cls: "TYPE_2_TWO_WAY_DOOR", conf: 1 }))));
    const res = await handleWebhook(new Request("https://w/webhook", { method: "POST", body, headers }), env, {
      fetchFn: net.fetchFn,
      waitUntil: (p) => pending.push(p),
    });
    await Promise.all(pending);
    return { res, net, started: pending.length > 0 };
  }

  it("rejects bad signature", async () => {
    expect((await post(prEvent(), { sig: "sha256=00" })).res.status).toBe(401);
    expect((await post(prEvent(), { sig: null })).res.status).toBe(401);
  });
  it("processes opened PRs", async () => {
    const r = await post(prEvent());
    expect(r.res.status).toBe(202);
    expect(r.started).toBe(true);
  });
  it("ignores drafts, closed, other events, and non-text edits", async () => {
    const draft = prEvent();
    draft.pull_request.draft = true;
    expect((await post(draft)).started).toBe(false);
    expect((await post(prEvent({ action: "closed" }))).started).toBe(false);
    expect((await post(prEvent(), { event: "push" })).started).toBe(false);
    expect((await post(prEvent({ action: "edited", changes: { base: {} } }))).started).toBe(false);
    expect((await post(prEvent({ action: "edited", changes: { body: { from: "x" } } }))).started).toBe(true);
  });
  it("processes ready_for_review", async () => {
    expect((await post(prEvent({ action: "ready_for_review" }))).started).toBe(true);
  });

  const mergeGroup = (over: Partial<MergeGroupEvent> = {}): MergeGroupEvent => ({
    action: "checks_requested",
    installation: { id: 9 },
    repository: { name: "r", owner: { login: "o" } },
    merge_group: { head_sha: "queue-sha", head_ref: "refs/heads/gh-readonly-queue/main/pr-7-abc", base_ref: "refs/heads/main" },
    ...over,
  });

  it("reports success on the merge group head without evaluating it (issue #14)", async () => {
    const r = await post(mergeGroup(), { event: "merge_group" });
    expect(r.res.status).toBe(202);
    expect(r.started).toBe(true);
    const created = r.net.calls.filter((c) => c.method === "POST" && c.url.endsWith("/check-runs"));
    expect(created).toHaveLength(1);
    expect(created[0].body).toMatchObject({ name: "judgement-gate", head_sha: "queue-sha", status: "completed", conclusion: "success" });
    expect(r.net.calls.some((c) => c.url.includes("jev.test") || c.url.includes("/pulls/"))).toBe(false);
    expect(r.net.calls.some((c) => c.method === "PATCH")).toBe(false);
  });
  it("ignores merge group events other than checks_requested, or without an installation", async () => {
    expect((await post(mergeGroup({ action: "destroyed" }), { event: "merge_group" })).started).toBe(false);
    expect((await post(mergeGroup({ installation: undefined }), { event: "merge_group" })).started).toBe(false);
  });
  it("retries a failed merge group check", async () => {
    clearInstallationTokenCache();
    const env = await makeEnv();
    const net = fakeNet(answer);
    await processMergeGroup(mergeGroup(), env, failing(net, createsCheck, 2), noWait);
    expect(net.calls.filter((c) => createsCheck(c.url, c.method))).toHaveLength(1);
    await expect(processMergeGroup(mergeGroup(), env, failing(net, createsCheck), noWait)).rejects.toThrow(/check-runs/);
  });
});

describe("installation token cache", () => {
  it("reuses a cached installation token before expiry minus safety margin", async () => {
    clearInstallationTokenCache();
    const env = await makeEnv();
    const t0 = Date.parse("2026-10-19T12:00:00Z");
    const expiresAt = new Date(t0 + 60 * 60 * 1000).toISOString();
    let count = 0;
    const fetchFn = (async () => {
      count++;
      return new Response(JSON.stringify({ token: `tok-${count}`, expires_at: expiresAt }), { status: 201 });
    }) as unknown as typeof fetch;

    const first = await installationToken(env, 101, fetchFn, t0);
    const second = await installationToken(env, 101, fetchFn, t0 + 54 * 60 * 1000);

    expect(first).toBe("tok-1");
    expect(second).toBe("tok-1");
    expect(count).toBe(1);
  });

  it("refreshes the token once within the 5-minute safety margin or after expiry", async () => {
    clearInstallationTokenCache();
    const env = await makeEnv();
    const t0 = Date.parse("2026-10-19T12:00:00Z");
    let count = 0;
    const fetchFn = (async () => {
      count++;
      const expiresAt = new Date(t0 + count * 60 * 60 * 1000).toISOString();
      return new Response(JSON.stringify({ token: `tok-${count}`, expires_at: expiresAt }), { status: 201 });
    }) as unknown as typeof fetch;

    const first = await installationToken(env, 202, fetchFn, t0);
    // Exactly 5 minutes before the 1-hour expiry -> within safety margin -> refreshes
    const second = await installationToken(env, 202, fetchFn, t0 + 55 * 60 * 1000);
    // 10 minutes later -> still well before the second token's 2-hour expiry -> cached
    const third = await installationToken(env, 202, fetchFn, t0 + 65 * 60 * 1000);

    expect(first).toBe("tok-1");
    expect(second).toBe("tok-2");
    expect(third).toBe("tok-2");
    expect(count).toBe(2);
  });

  it("keeps cached tokens isolated per installation id", async () => {
    clearInstallationTokenCache();
    const env = await makeEnv();
    const t0 = Date.parse("2026-10-19T12:00:00Z");
    const expiresAt = new Date(t0 + 60 * 60 * 1000).toISOString();
    const seenUrls: string[] = [];
    const fetchFn = (async (input: any) => {
      const url = String(input);
      seenUrls.push(url);
      const id = url.match(/\/installations\/(\d+)\/access_tokens$/)?.[1];
      return new Response(JSON.stringify({ token: `tok-for-${id}`, expires_at: expiresAt }), { status: 201 });
    }) as unknown as typeof fetch;

    expect(await installationToken(env, 301, fetchFn, t0)).toBe("tok-for-301");
    expect(await installationToken(env, 302, fetchFn, t0)).toBe("tok-for-302");
    expect(await installationToken(env, 301, fetchFn, t0 + 60_000)).toBe("tok-for-301");
    expect(await installationToken(env, 302, fetchFn, t0 + 60_000)).toBe("tok-for-302");
    expect(seenUrls).toHaveLength(2);
  });
});
