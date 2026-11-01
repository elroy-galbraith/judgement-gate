import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache } from "../src/config";
import { processPullRequest } from "../src/handler";
import type { Env, PullRequestEvent } from "../src/types";

beforeEach(() => {
  clearConfigCache();
});

afterEach(() => {
  clearConfigCache();
  vi.restoreAllMocks();
});

const CONFIG = `
judgements:
  - use: one-way-door
  - id: public-api-contract
    name: Public API contract change
    question: "Does this change break or remove a public API contract?"
    true: "removes/renames endpoints, fields or exported symbols"
    false: "additive or internal only"
    threshold: 0.6
    applies_to: ["services/api/**"]
    satisfied_by:
      - pr_body_matches: "(?i)^Migration Plan:"
    why: "Consumers cannot roll back with us."
    fix: "Add a 'Migration Plan:' line to the PR description."
`;

const API_ONLY = CONFIG.replace("  - use: one-way-door\n", "");

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

function prEvent(body = "no plan"): PullRequestEvent {
  return {
    action: "opened",
    installation: { id: 9 },
    repository: { name: "r", owner: { login: "o" } },
    pull_request: { number: 7, title: "t", body, base: { ref: "main" }, head: { sha: "abc" } },
  };
}

const benign = {
  is_one_way_boundary_mutation: { noul: 0.02 },
  is_additive_or_isolated: { noul: 0.9 },
  has_concrete_reversal_plan: { noul: 0.9 },
  synthetic_classification: { choice: "TYPE_2_TWO_WAY_DOOR", confidence: 0.9 },
};
const type1 = {
  is_one_way_boundary_mutation: { noul: 0.96 },
  is_additive_or_isolated: { noul: 0.1 },
  has_concrete_reversal_plan: { noul: 0.1 },
  synthetic_classification: { choice: "TYPE_1_ONE_WAY_DOOR", confidence: 0.8 },
};

interface NetOpts {
  config: { status: number; body?: string };
  answers: Record<string, unknown>;
  files?: { filename: string; status: string; patch?: string }[];
}

function fakeNet(o: NetOpts) {
  const calls: { method: string; url: string; body?: any }[] = [];
  const fetchFn = (async (input: any, init: any = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status });
    if (url.includes("jev.test")) return json({ answers: o.answers });
    if (url.includes("/contents/")) return new Response(o.config.body ?? "", { status: o.config.status });
    if (url.endsWith("/access_tokens")) return json({ token: "tok" }, 201);
    if (url.endsWith("/check-runs")) return json({ id: 55 }, 201);
    if (url.includes("/check-runs/55")) return json({});
    if (url.includes("/pulls/7/files")) return json(o.files ?? [{ filename: "src/a.ts", status: "modified", patch: "+x" }]);
    if (url.includes("/issues/7/comments") && method === "GET") return json([]);
    if (url.includes("/issues/7/comments") && method === "POST") return json({ id: 1 }, 201);
    if (url.endsWith("/issues/7/labels") && method === "POST") return json([]);
    return json({ error: "unexpected " + url }, 500);
  }) as typeof fetch;
  return { calls, fetchFn };
}

const finalCheck = (calls: any[]) => calls.filter((c) => c.method === "PATCH" && c.url.includes("/check-runs/55")).at(-1)?.body;
const jevBody = (calls: any[]) => calls.find((c) => c.url.includes("jev.test"))?.body;
const postedComment = (calls: any[]) => calls.find((c) => c.method === "POST" && c.url.endsWith("/issues/7/comments"))?.body?.body as string | undefined;
const apiFiles = [{ filename: "services/api/v1.ts", status: "modified", patch: "-x" }];

describe("config loading", () => {
  it("404 -> built-in only, no config note", async () => {
    const net = fakeNet({ config: { status: 404 }, answers: type1 });
    const v = await processPullRequest(prEvent(), await makeEnv(), net.fetchFn);
    expect(v.reason).toBe("type1_no_adr");
    expect(finalCheck(net.calls).output.summary).not.toContain("fell back");
  });

  it.each([500, 403])("%i -> falls back to built-in with a note, still evaluates", async (status) => {
    const net = fakeNet({ config: { status, body: "nope" }, answers: type1 });
    await processPullRequest(prEvent(), await makeEnv(), net.fetchFn);
    expect(finalCheck(net.calls).conclusion).toBe("failure");
    expect(finalCheck(net.calls).output.summary).toContain("fell back to built-in judgements");
  });

  it("reads .github/judgement-gate.yml from the owner's .github repo's default branch", async () => {
    const net = fakeNet({ config: { status: 404 }, answers: benign });
    await processPullRequest(prEvent(), await makeEnv(), net.fetchFn);
    const req = net.calls.find((c) => c.url.includes("/contents/"))!;
    expect(req.url).toBe("https://gh.test/repos/o/.github/contents/.github/judgement-gate.yml");
    expect(req.url).not.toContain("ref=");
  });

  it("CONFIG_REPO overrides the repo name", async () => {
    const net = fakeNet({ config: { status: 404 }, answers: benign });
    await processPullRequest(prEvent(), await makeEnv({ CONFIG_REPO: "policy" }), net.fetchFn);
    expect(net.calls.find((c) => c.url.includes("/contents/"))!.url).toContain("/repos/o/policy/contents/");
  });

  it("invalid YAML -> built-in runs with a Config error note", async () => {
    const net = fakeNet({ config: { status: 200, body: "judgements: [" }, answers: type1 });
    const v = await processPullRequest(prEvent(), await makeEnv(), net.fetchFn);
    expect(v.reason).toBe("type1_no_adr");
    const out = finalCheck(net.calls);
    expect(out.conclusion).toBe("failure");
    expect(out.output.summary).toContain("Config error");
  });

  it("caches config in the isolate for 60 seconds and refetches after expiry", async () => {
    const env = await makeEnv();
    const net = fakeNet({ config: { status: 200, body: CONFIG }, answers: benign });
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    await processPullRequest(prEvent(), env, net.fetchFn);
    now += 30_000;
    await processPullRequest(prEvent(), env, net.fetchFn);

    expect(net.calls.filter((c) => c.url.includes("/contents/"))).toHaveLength(1);

    now += 31_000;
    await processPullRequest(prEvent(), env, net.fetchFn);

    expect(net.calls.filter((c) => c.url.includes("/contents/"))).toHaveLength(2);
  });

  it("keys the isolate config cache by owner and config repo", async () => {
    const net = fakeNet({ config: { status: 404 }, answers: benign });
    await processPullRequest(prEvent(), await makeEnv(), net.fetchFn);
    await processPullRequest(prEvent(), await makeEnv({ CONFIG_REPO: "policy" }), net.fetchFn);

    const configUrls = net.calls.filter((c) => c.url.includes("/contents/")).map((c) => c.url);
    expect(configUrls).toEqual([
      "https://gh.test/repos/o/.github/contents/.github/judgement-gate.yml",
      "https://gh.test/repos/o/policy/contents/.github/judgement-gate.yml",
    ]);
  });
});

describe("multiple judgements", () => {
  it("judgement whose applies_to misses all files is not sent to Jev", async () => {
    const net = fakeNet({ config: { status: 200, body: CONFIG }, answers: benign });
    await processPullRequest(prEvent(), await makeEnv(), net.fetchFn);
    expect(Object.keys(jevBody(net.calls).questions).some((k) => k.startsWith("public-api-contract."))).toBe(false);
    expect(finalCheck(net.calls).conclusion).toBe("success");
  });

  it("no applicable judgements -> Jev is never called and the check passes", async () => {
    const net = fakeNet({ config: { status: 200, body: API_ONLY }, answers: {} });
    await processPullRequest(prEvent(), await makeEnv(), net.fetchFn);
    expect(net.calls.some((c) => c.url.includes("jev.test"))).toBe(false);
    const out = finalCheck(net.calls);
    expect(out.conclusion).toBe("success");
    expect(out.output.summary).toContain("No applicable judgements");
  });

  describe("safe paths", () => {
    const jevCalled = (calls: { url: string }[]) => calls.some((c) => c.url.includes("jev.test"));
    const run = async (files: { filename: string; status: string; previous_filename?: string }[], config: string | null = null, ev = prEvent()) => {
      clearConfigCache(); // the config is cached per owner, and a test may run several configs
      const net = fakeNet({ config: config === null ? { status: 404 } : { status: 200, body: config }, answers: type1, files });
      await processPullRequest(ev, await makeEnv(), net.fetchFn);
      return net;
    };

    it("a README-only PR passes without calling Jev", async () => {
      const net = await run([{ filename: "README.md", status: "modified" }]);
      expect(jevCalled(net.calls)).toBe(false);
      expect(finalCheck(net.calls).conclusion).toBe("success");
    });

    it("docs, images and a lockfile together pass without calling Jev", async () => {
      const net = await run([
        { filename: "docs/guide.md", status: "modified" },
        { filename: "assets/logo.png", status: "added" },
        { filename: "package-lock.json", status: "modified" },
      ]);
      expect(jevCalled(net.calls)).toBe(false);
      expect(finalCheck(net.calls).conclusion).toBe("success");
    });

    it("one code file next to a README is still judged", async () => {
      const net = await run([
        { filename: "README.md", status: "modified" },
        { filename: "src/a.ts", status: "modified" },
      ]);
      expect(jevCalled(net.calls)).toBe(true);
      expect(finalCheck(net.calls).conclusion).toBe("failure");
    });

    it("a file list that hit the GitHub limit may be cut off, so nothing is ignored", async () => {
      // The fake returns the same 100 files for every page, which fills all 10 pages (1,000 files).
      const readmes = Array.from({ length: 100 }, (_, i) => ({ filename: `docs/${i}.md`, status: "modified" }));
      expect(jevCalled((await run(readmes)).calls)).toBe(true);
      expect(jevCalled((await run(readmes.slice(0, 99))).calls)).toBe(false);
    });

    it("an ADR is not a safe path", async () => {
      const net = await run([{ filename: "docs/decisions/0001-x.md", status: "added" }]);
      expect(jevCalled(net.calls)).toBe(true);
    });

    it("a risky file renamed to a Markdown name is still judged", async () => {
      const net = await run([{ filename: "docs/notes.md", status: "renamed", previous_filename: "db/schema.sql" }]);
      expect(jevCalled(net.calls)).toBe(true);
    });

    it("use: one-way-door with ignore: [] judges a README-only PR", async () => {
      const net = await run([{ filename: "README.md", status: "modified" }], "judgements:\n  - use: one-way-door\n    ignore: []\n");
      expect(jevCalled(net.calls)).toBe(true);
    });

    it("a custom ignore replaces the safe set", async () => {
      const config = "judgements:\n  - use: one-way-door\n    ignore: ['vendor/**']\n";
      expect(jevCalled((await run([{ filename: "vendor/x.go", status: "modified" }], config)).calls)).toBe(false);
      expect(jevCalled((await run([{ filename: "README.md", status: "modified" }], config)).calls)).toBe(true);
    });

    it("a custom judgement ignores nothing unless it says so, and it is not skipped when only the built-in is", async () => {
      const readme = [{ filename: "README.md", status: "modified" }];
      const declarative = (ignore: string) =>
        `judgements:\n  - id: docs-rule\n    name: Docs rule\n    question: "Q?"\n    true: "t"\n    false: "f"\n    threshold: 0.5\n${ignore}    satisfied_by:\n      - pr_body_matches: "ok"\n    why: "w"\n    fix: "f"\n`;
      expect(jevCalled((await run(readme, declarative(""))).calls)).toBe(true);
      expect(jevCalled((await run(readme, declarative("    ignore: ['**/*.md']\n"))).calls)).toBe(false);
    });

    it("a bot author is evaluated like anyone else: a manifest bump is judged, a lockfile-only bump is not", async () => {
      const dependabot = {
        ...prEvent(),
        pull_request: { ...prEvent().pull_request, user: { login: "dependabot[bot]", type: "Bot" } },
      } as PullRequestEvent;
      expect(jevCalled((await run([{ filename: "package.json", status: "modified" }], null, dependabot)).calls)).toBe(true);
      expect(jevCalled((await run([{ filename: "package-lock.json", status: "modified" }], null, dependabot)).calls)).toBe(false);
    });
  });

  it("declarative judgement flagged and unsatisfied -> failure and a teaching comment", async () => {
    const net = fakeNet({ config: { status: 200, body: CONFIG }, answers: { ...benign, "public-api-contract.q": { noul: 0.9 } }, files: apiFiles });
    await processPullRequest(prEvent("nope"), await makeEnv(), net.fetchFn);
    expect(finalCheck(net.calls).conclusion).toBe("failure");
    const md = postedComment(net.calls)!;
    expect(md).toContain("Public API contract change");
    expect(md).toContain("**Why:** Consumers cannot roll back with us.");
  });

  it("declarative judgement satisfied by the PR body -> success", async () => {
    const net = fakeNet({ config: { status: 200, body: CONFIG }, answers: { ...benign, "public-api-contract.q": { noul: 0.9 } }, files: apiFiles });
    await processPullRequest(prEvent("Migration Plan: expand then contract"), await makeEnv(), net.fetchFn);
    expect(finalCheck(net.calls).conclusion).toBe("success");
    expect(postedComment(net.calls)).toBeUndefined();
  });

  it("two failing judgements -> one comment listing both", async () => {
    const net = fakeNet({ config: { status: 200, body: CONFIG }, answers: { ...type1, "public-api-contract.q": { noul: 0.9 } }, files: apiFiles });
    await processPullRequest(prEvent("nope"), await makeEnv(), net.fetchFn);
    expect(net.calls.filter((c) => c.method === "POST" && c.url.endsWith("/issues/7/comments"))).toHaveLength(1);
    expect(postedComment(net.calls)!).toContain("2 judgements need attention");
    expect(finalCheck(net.calls).output.summary).toContain("One-way door");
  });

  it("missing namespaced answer -> neutral [Audit Degraded]", async () => {
    const net = fakeNet({ config: { status: 200, body: CONFIG }, answers: benign, files: apiFiles });
    const v = await processPullRequest(prEvent(), await makeEnv(), net.fetchFn);
    expect(v.reason).toBe("degraded");
    expect(finalCheck(net.calls).conclusion).toBe("neutral");
  });

  it("config note survives a degraded audit", async () => {
    const net = fakeNet({ config: { status: 200, body: "judgements: [" }, answers: {} });
    await processPullRequest(prEvent(), await makeEnv(), net.fetchFn);
    expect(finalCheck(net.calls).conclusion).toBe("neutral");
    expect(finalCheck(net.calls).output.summary).toContain("Config error");
  });

  it("one-way-door comment links to the PR head branch name, not the head SHA", async () => {
    const net = fakeNet({ config: { status: 404 }, answers: type1 });
    const ev = prEvent();
    ev.pull_request.head = { sha: "deadbeef1234", ref: "feat/db-migration" };
    await processPullRequest(ev, await makeEnv(), net.fetchFn);
    const md = postedComment(net.calls)!;
    expect(md).toContain("https://github.com/o/r/new/feat/db-migration?filename=docs/decisions/0001-title.md");
    expect(md).not.toContain("deadbeef1234");
  });

  it("one-way-door comment links to the fork repo and branch for fork PRs, or falls back to plain text when fork repo is null", async () => {
    const netFork = fakeNet({ config: { status: 404 }, answers: type1 });
    const forkEv = prEvent();
    forkEv.pull_request.head = {
      sha: "deadbeef1234",
      ref: "patch-1",
      repo: { name: "r-fork", owner: { login: "contributor" }, fork: true },
    };
    await processPullRequest(forkEv, await makeEnv(), netFork.fetchFn);
    const forkMd = postedComment(netFork.calls)!;
    expect(forkMd).toContain("https://github.com/contributor/r-fork/new/patch-1?filename=docs/decisions/0001-title.md");
    expect(forkMd).not.toContain("deadbeef1234");

    const netDeletedFork = fakeNet({ config: { status: 404 }, answers: type1 });
    const deletedForkEv = prEvent();
    deletedForkEv.pull_request.head = { sha: "deadbeef1234", ref: "patch-1", repo: null };
    await processPullRequest(deletedForkEv, await makeEnv(), netDeletedFork.fetchFn);
    const fallbackMd = postedComment(netDeletedFork.calls)!;
    expect(fallbackMd).toContain("`docs/decisions/NNNN-short-title.md`");
    expect(fallbackMd).not.toContain("/new/");
    expect(fallbackMd).not.toContain("deadbeef1234");
  });
});

describe("repository scope and judgement modes", () => {
  it("skips a built-in scoped to another repo without calling Jev", async () => {
    const net = fakeNet({ config: { status: 200, body: 'judgements:\n  - use: one-way-door\n    repos: [other]\n' }, answers: type1 });
    await processPullRequest(prEvent(), await makeEnv(), net.fetchFn);
    expect(jevBody(net.calls)).toBeUndefined();
    expect(finalCheck(net.calls).conclusion).toBe("success");
    expect(finalCheck(net.calls).output.summary).toContain("No applicable judgements");
  });

  it("keeps a shadow failure visible while an enforced judgement passes", async () => {
    const config = CONFIG.replace('    name: Public API contract change', '    mode: shadow\n    name: Public API contract change');
    const net = fakeNet({ config: { status: 200, body: config }, files: apiFiles, answers: { ...benign, "public-api-contract.q": { noul: 0.9 } } });
    await processPullRequest(prEvent(), await makeEnv(), net.fetchFn);
    expect(finalCheck(net.calls).conclusion).toBe("success");
    expect(finalCheck(net.calls).output.summary).toContain("[shadow]");
    expect(postedComment(net.calls)).toContain("Public API contract change");
    expect(postedComment(net.calls)).toContain("does not block");
  });
});

describe("scope and mode integration", () => {
  it.each(["r", "?", "r*", "*"])("matches target repo glob %s even on a fork PR", async (pattern) => {
    const config = `judgements:\n  - use: one-way-door\n    repos: ['${pattern}']\n`;
    const ev = prEvent();
    ev.pull_request.head.repo = { name: "other-fork", owner: { login: "forker" }, fork: true };
    const net = fakeNet({ config: { status: 200, body: config }, answers: type1 });
    await processPullRequest(ev, await makeEnv(), net.fetchFn);
    expect(jevBody(net.calls).questions.is_one_way_boundary_mutation).toBeDefined();
    expect(finalCheck(net.calls).conclusion).toBe("failure");
  });

  it("requires the repository AND file filters to match", async () => {
    const config = API_ONLY.replace('    name:', '    repos: [r]\n    name:');
    const net = fakeNet({ config: { status: 200, body: config }, answers: {} });
    await processPullRequest(prEvent(), await makeEnv(), net.fetchFn);
    expect(jevBody(net.calls)).toBeUndefined();
  });

  it("removes only the out-of-scope judgement's questions from a shared Jev request", async () => {
    const config = CONFIG.replace('    name:', '    repos: [elsewhere]\n    name:');
    const net = fakeNet({ config: { status: 200, body: config }, answers: benign, files: apiFiles });
    await processPullRequest(prEvent(), await makeEnv(), net.fetchFn);
    const questions = jevBody(net.calls).questions;
    expect(questions.is_one_way_boundary_mutation).toBeDefined();
    expect(questions["public-api-contract.q"]).toBeUndefined();
    expect(finalCheck(net.calls).output.summary).not.toContain("Public API contract change");
  });

  it.each(["shadow", undefined])("explicit enforce overrides global %s", async (mode) => {
    const config = 'judgements:\n  - use: one-way-door\n    mode: enforce\n';
    const net = fakeNet({ config: { status: 200, body: config }, answers: type1 });
    await processPullRequest(prEvent(), await makeEnv({ MODE: mode }), net.fetchFn);
    expect(finalCheck(net.calls).conclusion).toBe("failure");
    expect(finalCheck(net.calls).output.title).not.toContain("[Shadow]");
    expect(finalCheck(net.calls).output.summary).toContain("[enforce]");
    expect(postedComment(net.calls)).toContain('"mode":"enforce"');
  });

  it("records effective modes and keeps review routing independently enforced", async () => {
    const points: { blobs?: string[] }[] = [];
    const config = CONFIG.replace('    name:', '    mode: shadow\n    name:') + '\nrouting:\n  include_defaults: false\n  human_when:\n    - judgement: public-api-contract\n';
    const net = fakeNet({ config: { status: 200, body: config }, files: apiFiles, answers: { ...benign, "public-api-contract.q": { noul: 0.9 } } });
    await processPullRequest(prEvent(), await makeEnv({ ANALYTICS: { writeDataPoint: p => void points.push(p) } }), net.fetchFn);
    expect(finalCheck(net.calls).conclusion).toBe("success");
    expect(points.filter(p => p.blobs?.[0] === "evaluation").map(p => p.blobs?.slice(2, 5))).toEqual([
      ["one-way-door", "enforce", "passed"], ["public-api-contract", "shadow", "flagged"],
    ]);
    expect(net.calls.some(c => c.url.endsWith('/labels') && c.method === 'POST')).toBe(true);
    const md = postedComment(net.calls)!;
    const block = JSON.parse(md.match(/<!-- judgement-gate:v1 (\{.*\}) -->/)![1]);
    expect(block.mode).toBe("enforce");
    expect(block.failing[0]).toMatchObject({ id: "public-api-contract", mode: "shadow" });
    expect(md).not.toContain("all applicable judgements passed");
  });

  it("records overridden modes on the request-wide outage path", async () => {
    const points: { blobs?: string[] }[] = [];
    const config = 'judgements:\n  - use: one-way-door\n    mode: enforce\n';
    const net = fakeNet({ config: { status: 200, body: config }, answers: {} });
    const fetchFn = ((input, init) => String(input).includes('jev.test') ? Promise.resolve(new Response('down', { status: 503 })) : net.fetchFn(input, init)) as typeof fetch;
    await processPullRequest(prEvent(), await makeEnv({ MODE: 'shadow', ANALYTICS: { writeDataPoint: p => void points.push(p) } }), fetchFn);
    expect(finalCheck(net.calls).conclusion).toBe('neutral');
    expect(points[0].blobs?.slice(2, 5)).toEqual(['one-way-door', 'enforce', 'degraded']);
  });
});

describe("mixed-mode failures and partial answers", () => {
  const config = CONFIG.replace('    name:', '    mode: shadow\n    name:');
  it("keeps both failures in the comment while only the enforced failure supplies the check reason", async () => {
    const net = fakeNet({ config: { status: 200, body: config }, files: apiFiles, answers: { ...type1, 'public-api-contract.q': { noul: 0.9 } } });
    const v = await processPullRequest(prEvent(), await makeEnv(), net.fetchFn);
    expect(v).toMatchObject({ conclusion: 'failure', reason: 'type1_no_adr' });
    expect(finalCheck(net.calls).conclusion).toBe('failure');
    const md = postedComment(net.calls)!;
    const block = JSON.parse(md.match(/<!-- judgement-gate:v1 (\{.*\}) -->/)![1]);
    expect(block.failing.map((f: { id: string; mode: string }) => [f.id, f.mode])).toEqual([
      ['one-way-door', 'enforce'], ['public-api-contract', 'shadow'],
    ]);
    expect(md).toContain('**Mode:** enforce');
    expect(md).toContain('**Mode:** shadow');
  });

  it("a missing shadow answer stays visible without neutralizing an enforced pass", async () => {
    const net = fakeNet({ config: { status: 200, body: config }, files: apiFiles, answers: benign });
    const v = await processPullRequest(prEvent(), await makeEnv(), net.fetchFn);
    expect(v.conclusion).toBe('success');
    expect(finalCheck(net.calls).conclusion).toBe('success');
    expect(finalCheck(net.calls).output.summary).toContain('Public API contract change (Missing or malformed answers: public-api-contract.q) [shadow]');
    expect(finalCheck(net.calls).output.title).not.toContain('judgements passed');
  });

  it("a missing enforced answer keeps the check neutral despite a shadow failure", async () => {
    const net = fakeNet({ config: { status: 200, body: config }, files: apiFiles, answers: { 'public-api-contract.q': { noul: 0.9 } } });
    await processPullRequest(prEvent(), await makeEnv(), net.fetchFn);
    expect(finalCheck(net.calls).conclusion).toBe('neutral');
    expect(postedComment(net.calls)).toContain('does not block the check');
    expect(postedComment(net.calls)).toContain('Audit degraded');
  });
});
