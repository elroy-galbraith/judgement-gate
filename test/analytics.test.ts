import { describe, expect, it } from "vitest";
import { parseFalsePositive, record } from "../src/analytics";
import { renderComment } from "../src/comment";
import { handleWebhook, processPullRequest } from "../src/handler";
import { oneWayDoor } from "../src/judgements/one-way-door";
import type { AnalyticsSink, Env, PullRequestEvent } from "../src/types";

type Point = { indexes?: string[]; blobs?: string[]; doubles?: number[] };
const sink = () => {
  const points: Point[] = [];
  const s: AnalyticsSink = { writeDataPoint: (p) => void points.push(p) };
  return { points, s };
};

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
    MODE: "shadow",
    GITHUB_API_URL: "https://gh.test",
    JEV_API_URL: "https://jev.test/decisions",
    ...extra,
  };
}

const SECRET_PATCH = "+SECRET-DIFF-TEXT";
const prEvent = (): PullRequestEvent => ({
  action: "opened",
  installation: { id: 9 },
  repository: { name: "r", owner: { login: "o" } },
  pull_request: { number: 7, title: "SECRET-TITLE", body: "SECRET-PR-BODY-TEXT", base: { ref: "main" }, head: { sha: "abc" } },
});

const jevBody = (one: number, cls: string, conf: number) =>
  JSON.stringify({
    answers: {
      is_one_way_boundary_mutation: { type: "noul", noul: one },
      is_additive_or_isolated: { type: "noul", noul: 0.5 },
      has_concrete_reversal_plan: { type: "noul", noul: 0.9 },
      synthetic_classification: { type: "choice", choice: cls, confidence: conf, probabilities: {} },
    },
  });

function net(jev: () => Response | Promise<Response>, files: unknown[] = [{ filename: "src/a.ts", status: "modified", patch: SECRET_PATCH }]) {
  return (async (input: any, init: any = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
    if (url.includes("jev.test")) return jev();
    if (url.endsWith("/access_tokens")) return json({ token: "t" }, 201);
    if (url.endsWith("/check-runs")) return json({ id: 55 }, 201);
    if (url.includes("/check-runs/55")) return json({});
    if (url.includes("/pulls/7/files")) return json(files);
    if (url.includes("/contents/")) return new Response("", { status: 404 });
    if (url.includes("/issues/7/comments")) return method === "GET" ? json([]) : json({ id: 1 }, 201);
    return json({ error: url }, 500);
  }) as typeof fetch;
}

const flaggedJev = () => new Response(jevBody(0.96, "TYPE_1_ONE_WAY_DOOR", 0.8));

describe("evaluation events", () => {
  it("records a flagged one-way-door with probability, confidence, mode and latency", async () => {
    const { points, s } = sink();
    await processPullRequest(prEvent(), await makeEnv({ ANALYTICS: s }), net(flaggedJev));
    // One evaluation point per judgement, then the PR's single routing point.
    expect(points.map((x) => x.blobs?.[0])).toEqual(["evaluation", "routing"]);
    const p = points[0];
    expect(p.indexes).toEqual(["o/r"]);
    expect(p.blobs?.slice(0, 6)).toEqual(["evaluation", "o/r", "one-way-door", "shadow", "flagged", "type1_no_adr"]);
    // pr, flagged, probability, confidence, cleared, latency, degraded
    expect(p.doubles?.slice(0, 5)).toEqual([7, 1, 0.96, 0.8, 0]);
    expect(p.doubles![5]).toBeGreaterThanOrEqual(0);
    expect(p.doubles![6]).toBe(0);
  });

  it("marks an ADR-satisfied type 1 as cleared, not flagged", async () => {
    const { points, s } = sink();
    const files = [{ filename: "docs/decisions/0001-x.md", status: "added", patch: "+x" }];
    await processPullRequest(prEvent(), await makeEnv({ ANALYTICS: s }), net(flaggedJev, files));
    expect(points[0].blobs?.[4]).toBe("cleared");
    expect(points[0].doubles?.slice(1, 5)).toEqual([0, 0.96, 0.8, 1]);
  });

  it("records a degraded outcome when Jev is down", async () => {
    const { points, s } = sink();
    await processPullRequest(prEvent(), await makeEnv({ ANALYTICS: s }), net(() => new Response("boom", { status: 503 })));
    expect(points.map((x) => x.blobs?.[0])).toEqual(["evaluation", "routing"]);
    expect(points[0].blobs?.[2]).toBe("one-way-door");
    expect(points[0].blobs?.[4]).toBe("degraded");
    expect(points[0].doubles?.[6]).toBe(1);
  });

  it("never records PR title, body or diff content", async () => {
    const { points, s } = sink();
    const env = await makeEnv({ ANALYTICS: s });
    await processPullRequest(prEvent(), env, net(flaggedJev));
    await processPullRequest(prEvent(), env, net(() => new Response("boom", { status: 503 })));
    expect(JSON.stringify(points)).not.toContain("SECRET");
  });

  it("works exactly as before without the binding", async () => {
    const v = await processPullRequest(prEvent(), await makeEnv(), net(flaggedJev));
    expect(v).toMatchObject({ conclusion: "success", reason: "shadow_findings" });
  });

  it("a throwing binding does not affect the verdict", async () => {
    const bad: AnalyticsSink = {
      writeDataPoint: () => {
        throw new Error("analytics down");
      },
    };
    const v = await processPullRequest(prEvent(), await makeEnv({ ANALYTICS: bad }), net(flaggedJev));
    expect(v).toMatchObject({ conclusion: "success", reason: "shadow_findings" });
    expect(() => record(bad, { event: "feedback", repo: "o/r", pr: 1, judgement: "x", mode: "shadow", outcome: "false_positive" })).not.toThrow();
  });
});

describe("parseFalsePositive", () => {
  it("accepts the command on its own line", () => {
    expect(parseFalsePositive("/judgement-gate false-positive one-way-door")).toBe("one-way-door");
    expect(parseFalsePositive("thanks, noisy\n  /judgement-gate false-positive pii_data  \nbye")).toBe("pii_data");
  });
  it("rejects prose, missing ids, extra args and odd characters", () => {
    expect(parseFalsePositive("")).toBeNull();
    expect(parseFalsePositive("/judgement-gate false-positive")).toBeNull();
    expect(parseFalsePositive("I think /judgement-gate false-positive x is wrong")).toBeNull();
    expect(parseFalsePositive("/judgement-gate false-positive a b")).toBeNull();
    expect(parseFalsePositive("/judgement-gate false-positive a$b")).toBeNull();
  });
  it("the remediation comment names the command but does not itself parse as one", () => {
    const md = renderComment(
      [{ judgement: oneWayDoor(), verdict: { conclusion: "failure", reason: "type1_no_adr", summary: "s", fired: true } }],
      { owner: "o", repo: "r", headRef: "abc" },
    );
    expect(md).toContain("/judgement-gate false-positive one-way-door");
    expect(parseFalsePositive(md)).toBeNull();
  });
});

describe("issue_comment feedback", () => {
  async function post(over: { action?: string; body?: string; userType?: string; pr?: boolean; sink?: AnalyticsSink } = {}) {
    const env = await makeEnv({ ANALYTICS: over.sink });
    const body = JSON.stringify({
      action: over.action ?? "created",
      repository: { name: "r", owner: { login: "o" } },
      issue: { number: 7, ...(over.pr === false ? {} : { pull_request: {} }) },
      comment: { body: over.body ?? "/judgement-gate false-positive one-way-door", user: { type: over.userType ?? "User" }, author_association: "MEMBER" },
    });
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("s"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
    const calls: string[] = [];
    const res = await handleWebhook(
      new Request("https://w/webhook", {
        method: "POST",
        body,
        headers: { "X-GitHub-Event": "issue_comment", "X-Hub-Signature-256": "sha256=" + [...sig].map((b) => b.toString(16).padStart(2, "0")).join("") },
      }),
      env,
      { fetchFn: (async (i: any) => (calls.push(String(i)), new Response("{}"))) as typeof fetch, waitUntil: () => {} },
    );
    return { res, calls };
  }

  it("logs a false-positive event linked to the PR and judgement id, with no GitHub calls", async () => {
    const { points, s } = sink();
    const { res, calls } = await post({ sink: s });
    expect(res.status).toBe(202);
    expect(calls).toEqual([]);
    expect(points).toHaveLength(1);
    expect(points[0].blobs).toEqual(["feedback", "o/r", "one-way-door", "shadow", "false_positive", "", "MEMBER"]);
    expect(points[0].doubles?.[0]).toBe(7);
  });

  it("ignores bots, edits, non-PR issues and ordinary comments", async () => {
    for (const o of [{ userType: "Bot" }, { action: "edited" }, { pr: false }, { body: "lgtm" }]) {
      const { points, s } = sink();
      await post({ ...o, sink: s });
      expect(points).toHaveLength(0);
    }
  });

  it("is a harmless no-op without the binding", async () => {
    expect((await post({})).res.status).toBe(202);
  });
});
