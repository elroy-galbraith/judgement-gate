// End-to-end scenarios against the real Worker. Usage: npm run e2e
//
// Starts, on free loopback ports and with no secrets: a scripted Jev (scripts/jev-stub.mjs), the mock GitHub
// (scripts/mock-github.mjs) and the Worker via `wrangler dev`. Then sends signed webhooks for the demo scenarios
// and asserts on what the mock GitHub recorded. Server logs go to e2e-logs/. Exit code 0 only if every case passed.
// Env: E2E_TIMEOUT_MS (whole run, default 120000).
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIOS } from "./scenarios.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOG_DIR = path.join(ROOT, "e2e-logs");
const TOTAL_TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 120_000);
const CASE_TIMEOUT_MS = 20_000;
const WEBHOOK_SECRET = "dev-secret";
const JEV_KEY = "dev-test-key";
const LABEL = "needs-human-review";

// ---------------------------------------------------------------- process management

const children = []; // {name, child}
let tmpDir;
let tornDown = false;

function killTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-child.pid, "SIGKILL"); // detached: the child leads its own process group
  } catch {
    // already gone
  }
}

/** Synchronous and idempotent, so it is safe from 'exit', signal handlers and the timeout. */
function teardown() {
  if (tornDown) return;
  tornDown = true;
  for (const { child } of children) killTree(child);
  if (tmpDir) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // a file handle may linger on Windows; the dir only holds a throwaway key
    }
  }
}

process.on("exit", teardown);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    console.error(`\ne2e: ${sig}, shutting down`);
    teardown();
    process.exit(130);
  });
}
const deadline = setTimeout(() => {
  console.error(`\ne2e: overall timeout after ${TOTAL_TIMEOUT_MS}ms`);
  teardown();
  process.exit(2);
}, TOTAL_TIMEOUT_MS);

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Strip anything credential-shaped so a developer's real keys never reach the servers (or their logs). */
function childEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY/i.test(k)) env[k] = v;
  return { ...env, WRANGLER_SEND_METRICS: "false", ...extra };
}

function start(name, args, env) {
  const log = path.join(LOG_DIR, `${name}.log`);
  const fd = fs.openSync(log, "w");
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: childEnv(env),
    stdio: ["ignore", fd, fd],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  fs.closeSync(fd);
  child.on("error", (e) => console.error(`e2e: could not start ${name}: ${e.message}`));
  children.push({ name, child, log });
  return { child, log };
}

const tail = (file, n = 25) => {
  try {
    return fs.readFileSync(file, "utf8").trimEnd().split("\n").slice(-n).join("\n");
  } catch {
    return "(no log)";
  }
};

async function waitReady(name, { child, log }, url, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`${name} exited with code ${child.exitCode} before it was ready\n${tail(log)}`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await sleep(150);
  }
  throw new Error(`${name} not ready at ${url} after ${timeoutMs}ms\n${tail(log)}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- harness

const sign = (payload) => "sha256=" + crypto.createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex");

function webhook(scenario, pr, sha, previousBody) {
  return JSON.stringify({
    action: previousBody === undefined ? "opened" : "edited",
    ...(previousBody !== undefined && { changes: { body: { from: previousBody } } }),
    installation: { id: 1 },
    repository: { name: "demo", owner: { login: "acme" } },
    pull_request: { number: pr, title: scenario.title, body: scenario.body, draft: false, base: { ref: "main" }, head: { sha } },
  });
}

const BLOCK = /<!-- judgement-gate:v(\d+) (\{.*\}) -->/;
const parseBlock = (comment) => {
  const m = comment && BLOCK.exec(comment);
  return m ? JSON.parse(m[2]) : null;
};

/** Collects expectations for one case; each mismatch keeps expected and actual for the report. */
class Expect {
  constructor() {
    this.failures = [];
  }
  eq(what, actual, expected) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) this.failures.push({ what, expected: JSON.stringify(expected), actual: JSON.stringify(actual) });
  }
  has(what, text, needle) {
    if (!String(text ?? "").includes(needle)) this.failures.push({ what, expected: `contains ${JSON.stringify(needle)}`, actual: JSON.stringify(text) });
  }
  lacks(what, text, needle) {
    if (String(text ?? "").includes(needle)) this.failures.push({ what, expected: `does not contain ${JSON.stringify(needle)}`, actual: JSON.stringify(text) });
  }
}

/** Bullets in the "Questions a reviewer will ask" list: the "- " lines right after that heading, up to the first other line. */
const bullets = (comment) => {
  const lines = comment.split("\n");
  const at = lines.findIndex((l) => l.includes("Questions a reviewer will ask"));
  if (at < 0) return 0;
  let n = 0;
  for (const l of lines.slice(at + 1)) {
    if (l.startsWith("- ")) n++;
    else if (l !== "" || n > 0) break;
  }
  return n;
};

// Expectations per case. `r` is {check, labels, comments, block}. Assert on conclusions, labels, key lines and parsed
// block fields only, never on whole-comment text, so prose edits do not break the run.
const human = (e, r) => {
  e.has("summary", r.check.summary, "Review routing: human");
  e.eq("labels", r.labels, [LABEL]);
};
const agent = (e, r) => {
  e.has("summary", r.check.summary, "Review routing: agent");
  e.eq("labels", r.labels, []);
};
const noComment = (e, r) => e.eq("comment count", r.comments.length, 0);
const oneComment = (e, r) => e.eq("comment count", r.comments.length, 1);
// A passing PR routed to a human gets one comment saying why: the routing line, the cleared judgement's why, and a block with nothing failing.
const routingComment = (e, r, why) => {
  oneComment(e, r);
  const c = r.comments[0] ?? "";
  e.has("comment heading", c, "passed the checks, routed to a human reviewer");
  e.has("comment routing line", c.split("\n").find((l) => l.startsWith("**Review routing:**")), "human review recommended");
  e.has("comment why", c, why);
  e.lacks("comment", c, "**Fix:**");
  e.eq("block present", r.block !== null, true);
  e.eq("block failing", r.block?.failing, []);
  e.eq("block routing.route", r.block?.routing?.route, "human");
};

const CASES = [
  {
    name: "1 Type 1, no ADR",
    scenario: 1,
    check(e, r) {
      e.eq("conclusion", r.check.conclusion, "failure");
      oneComment(e, r);
      e.has("comment", r.comments[0], "Questions a reviewer will ask");
      e.eq("comment bullets", bullets(r.comments[0] ?? ""), 5);
      human(e, r);
      e.eq("block present", r.block !== null, true);
      e.eq("block failing[0].probes.length", r.block?.failing?.[0]?.probes?.length, 5);
      e.eq("block routing.route", r.block?.routing?.route, "human");
    },
  },
  {
    name: "2 Type 1, with ADR",
    scenario: 2,
    check(e, r) {
      e.eq("conclusion", r.check.conclusion, "success");
      human(e, r);
      routingComment(e, r, "The ADR records the reasoning");
      e.eq("comment bullets", bullets(r.comments[0] ?? ""), 5);
    },
  },
  {
    name: "3 Type 2, with plan",
    scenario: 3,
    check(e, r) {
      e.eq("conclusion", r.check.conclusion, "success");
      agent(e, r);
      noComment(e, r);
    },
  },
  {
    name: "4 Type 2, no plan",
    scenario: 4,
    check(e, r) {
      e.eq("conclusion", r.check.conclusion, "failure");
      oneComment(e, r);
      agent(e, r);
      e.eq("block failing[0].probes.length", r.block?.failing?.[0]?.probes?.length, 3);
      e.eq("block routing.route", r.block?.routing?.route, "agent");
    },
  },
  {
    name: "R1 same PR passes after adding a reversal plan",
    scenario: 3,
    reusePr: true,
    check(e, r, previous) {
      e.eq("conclusion", r.check.conclusion, "success");
      agent(e, r);
      oneComment(e, r);
      e.eq("comment ids", r.commentIds, previous.commentIds);
      e.has("comment", r.comments[0], "all applicable judgements passed");
      e.lacks("comment", r.comments[0], "**Fix:**");
      e.lacks("comment", r.comments[0], "type2_no_plan");
      e.eq("block failing", r.block?.failing, []);
      e.eq("block routing.route", r.block?.routing?.route, "agent");
    },
  },
  {
    name: "R2 repeated pass keeps the same passing comment",
    scenario: 3,
    reusePr: true,
    check(e, r, previous) {
      e.eq("conclusion", r.check.conclusion, "success");
      oneComment(e, r);
      e.eq("comment ids", r.commentIds, previous.commentIds);
      e.eq("comments", r.comments, previous.comments);
    },
  },
  {
    name: "R3 same PR fails again after removing the reversal plan",
    scenario: 4,
    reusePr: true,
    check(e, r, previous) {
      e.eq("conclusion", r.check.conclusion, "failure");
      oneComment(e, r);
      e.eq("comment ids", r.commentIds, previous.commentIds);
      e.has("comment", r.comments[0], "**Fix:**");
      e.eq("block failing[0].reason", r.block?.failing?.[0]?.reason, "type2_no_plan");
    },
  },
  {
    name: "R4 same PR gets an incomplete note when its required answer is malformed",
    scenario: 3,
    reusePr: true,
    answers: { is_one_way_boundary_mutation: { noul: "broken" } },
    check(e, r, previous) {
      e.eq("conclusion", r.check.conclusion, "neutral");
      oneComment(e, r);
      e.eq("comment ids", r.commentIds, previous.commentIds);
      e.has("comment", r.comments[0], "audit incomplete");
      e.lacks("comment", r.comments[0], "all applicable judgements passed");
      e.lacks("comment", r.comments[0], "**Fix:**");
      e.eq("block failing", r.block?.failing, []);
      e.eq("block routing.route", r.block?.routing?.route, "unavailable");
    },
  },
  {
    name: "5 public API break, no migration plan",
    scenario: 5,
    check(e, r) {
      e.eq("conclusion", r.check.conclusion, "failure");
      oneComment(e, r);
      e.has("comment", r.comments[0], "**Severity:** P2");
      e.eq("labels", r.labels, [LABEL]);
      e.eq("block failing[0].id", r.block?.failing?.[0]?.id, "public-api-contract");
      e.eq("block failing[0].probes.length", r.block?.failing?.[0]?.probes?.length, 2);
      e.eq("block classification[0].id", r.block?.classification?.[0]?.id, "severity");
      e.eq("block classification[0].level", r.block?.classification?.[0]?.level, "P2");
    },
  },
  {
    name: "6 public API break, with Migration Plan",
    scenario: 6,
    check(e, r) {
      e.eq("conclusion", r.check.conclusion, "success");
      e.has("summary", r.check.summary, "Severity (P2)");
      human(e, r); // the judgement fired, so routing is human even though the author cleared it
      routingComment(e, r, "Consumers cannot roll back with us");
      e.has("comment", r.comments[0], "**Severity:** P2");
      e.eq("block classification[0].level", r.block?.classification?.[0]?.level, "P2");
    },
  },
  {
    name: "7 reversible checkout change",
    scenario: 7,
    check(e, r) {
      e.eq("conclusion", r.check.conclusion, "success");
      e.has("summary", r.check.summary, "Severity (P1)");
      agent(e, r);
      noComment(e, r);
    },
  },
  {
    name: "F1 Jev down on 1: degraded, still labelled by the files rule",
    scenario: 1,
    mode: "down",
    check(e, r) {
      e.eq("conclusion", r.check.conclusion, "neutral");
      e.eq("title", r.check.title, "[Audit Degraded]");
      e.has("summary", r.check.summary, "judgement rules skipped");
      e.eq("labels", r.labels, [LABEL]);
      noComment(e, r);
    },
  },
  {
    name: "F2 Jev down on 4: degraded, routing unavailable, no label",
    scenario: 4,
    mode: "down",
    check(e, r) {
      e.eq("conclusion", r.check.conclusion, "neutral");
      e.eq("title", r.check.title, "[Audit Degraded]");
      e.has("summary", r.check.summary, "Review routing: unavailable");
      e.eq("labels", r.labels, []);
      noComment(e, r);
    },
  },
  {
    name: "F3 unrecognised severity on 7: no level, rest unchanged",
    scenario: 7,
    mode: "badsev",
    check(e, r) {
      e.eq("conclusion", r.check.conclusion, "success");
      e.has("summary", r.check.summary, "Severity (no level reported)");
      agent(e, r);
      noComment(e, r);
    },
  },
  {
    name: "F4 unrecognised severity on 5: no level, rest unchanged",
    scenario: 5,
    mode: "badsev",
    check(e, r) {
      e.eq("conclusion", r.check.conclusion, "failure");
      e.has("summary", r.check.summary, "Severity (no level reported)");
      e.eq("labels", r.labels, [LABEL]);
      oneComment(e, r);
      e.lacks("comment", r.comments[0], "**Severity:**");
      e.eq("block failing[0].id", r.block?.failing?.[0]?.id, "public-api-contract");
      e.eq("block classification", r.block?.classification, undefined);
    },
  },
  {
    name: "F5 malformed one-way-door preserves a healthy API failure",
    scenario: 5,
    answers: { is_one_way_boundary_mutation: { noul: "broken" } },
    check(e, r) {
      e.eq("conclusion", r.check.conclusion, "failure");
      e.has("summary", r.check.summary, "- degraded: One-way door");
      e.has("summary", r.check.summary, "- FAIL: Public API contract change");
      human(e, r);
      oneComment(e, r);
      e.has("comment", r.comments[0], "Audit degraded");
      e.eq("block failing ids", r.block?.failing?.map(f => f.id), ["public-api-contract"]);
    },
  },
  {
    name: "F6 same PR clears API failure while one-way-door stays degraded",
    scenario: 6,
    reusePr: true,
    answers: { is_one_way_boundary_mutation: { noul: "broken" } },
    check(e, r, previous) {
      e.eq("conclusion", r.check.conclusion, "neutral");
      e.has("summary", r.check.summary, "- pass: Public API contract change");
      e.has("summary", r.check.summary, "Review routing: human");
      e.eq("label writes", r.labels, [...previous.labels, LABEL]);
      oneComment(e, r);
      e.eq("comment ids", r.commentIds, previous.commentIds);
      e.has("comment", r.comments[0], "audit incomplete");
      e.lacks("comment", r.comments[0], "passed the checks");
      e.lacks("comment", r.comments[0], "**Fix:**");
      e.eq("block failing", r.block?.failing, []);
    },
  },
  {
    name: "F7 missing API answer preserves a healthy one-way-door pass",
    scenario: 6,
    answers: { "public-api-contract.q": null },
    check(e, r) {
      e.eq("conclusion", r.check.conclusion, "neutral");
      e.has("summary", r.check.summary, "- pass: One-way door");
      e.has("summary", r.check.summary, "- degraded: Public API contract change");
      e.has("summary", r.check.summary, "Review routing: unavailable");
      e.eq("labels", r.labels, []);
      noComment(e, r);
    },
  },

];

async function main() {
  fs.rmSync(LOG_DIR, { recursive: true, force: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jg-e2e-"));

  const [jevPort, ghPort, workerPort, inspectorPort] = [await freePort(), await freePort(), await freePort(), await freePort()];
  const jev = `http://127.0.0.1:${jevPort}`;
  const gh = `http://127.0.0.1:${ghPort}`;
  const worker = `http://127.0.0.1:${workerPort}`;

  // Throwaway key and vars for the Worker. Passed with --env-file so the developer's own .dev.vars is never read or written.
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim();
  const envFile = path.join(tmpDir, "e2e.env");
  fs.writeFileSync(
    envFile,
    [
      `GITHUB_WEBHOOK_SECRET=${WEBHOOK_SECRET}`,
      "GITHUB_APP_ID=1",
      `GITHUB_APP_PRIVATE_KEY="${pem}"`,
      `JEV_API_KEY=${JEV_KEY}`,
      `GITHUB_API_URL=${gh}`,
      `JEV_API_URL=${jev}/`,
      "MODE=enforce",
      "",
    ].join("\n"),
  );

  const stub = start("jev", ["scripts/jev-stub.mjs"], { PORT: String(jevPort), JEV_API_KEY: JEV_KEY });
  const mock = start("github", ["scripts/mock-github.mjs"], { PORT: String(ghPort) });
  const wrangler = start(
    "worker",
    [
      path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js"),
      "dev",
      "--ip", "127.0.0.1",
      "--port", String(workerPort),
      "--inspector-port", String(inspectorPort),
      "--env-file", envFile,
      "--persist-to", path.join(tmpDir, "state"),
      "--show-interactive-dev-session=false",
    ],
    {},
  );
  console.log(`e2e: jev ${jev}, github ${gh}, worker ${worker}; logs in e2e-logs/`);

  await Promise.all([
    waitReady("jev stub", stub, `${jev}/__control`),
    waitReady("mock github", mock, `${gh}/__recorded`),
    waitReady("worker", wrangler, `${worker}/health`),
  ]);
  console.log("e2e: all three servers ready\n");

  const post = (url, body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const recorded = async () => (await fetch(`${gh}/__recorded`)).json();
  await post(`${gh}/__reset`, {});

  const results = [];
  const record = (name, failures, extra) => {
    results.push({ name, failures });
    console.log(`${failures.length === 0 ? "PASS" : "FAIL"}  ${name}`);
    for (const f of failures) console.log(`        ${f.what}\n          expected: ${f.expected}\n          actual:   ${f.actual}`);
    if (failures.length > 0 && extra) console.log(extra);
  };

  // The real signature check: a bad signature is rejected and nothing is written.
  {
    const e = new Expect();
    const payload = webhook(SCENARIOS[1], 99, crypto.randomBytes(20).toString("hex"));
    const res = await fetch(`${worker}/webhook`, {
      method: "POST",
      headers: { "X-GitHub-Event": "pull_request", "X-Hub-Signature-256": "sha256=" + "0".repeat(64), "Content-Type": "application/json" },
      body: payload,
    });
    e.eq("status for a bad signature", res.status, 401);
    await sleep(300);
    e.eq("checks recorded", (await recorded()).checks.length, 0);
    record("0 bad signature is rejected", e.failures);
  }

  let pr = 100;
  let previous;
  let previousScenario;
  for (const c of CASES) {
    const e = new Expect();
    const scenario = SCENARIOS[c.scenario];
    const sha = crypto.randomBytes(20).toString("hex");
    if (!c.reusePr) pr += 1;
    await post(`${gh}/__register`, { pr, files: scenario.files });
    await post(`${jev}/__control`, { mode: c.mode ?? "ok", answers: { ...scenario.jev, ...c.answers } });

    const payload = webhook(scenario, pr, sha, c.reusePr ? previousScenario.body : undefined);
    const res = await fetch(`${worker}/webhook`, {
      method: "POST",
      headers: { "X-GitHub-Event": "pull_request", "X-Hub-Signature-256": sign(payload), "Content-Type": "application/json" },
      body: payload,
    });
    e.eq("webhook status", res.status, 202);

    // The Worker acks first and works in waitUntil. Completing the check run is its last write, so wait for that.
    let rec;
    let check;
    for (const until = Date.now() + CASE_TIMEOUT_MS; Date.now() < until; await sleep(100)) {
      rec = await recorded();
      check = rec.checks.find((x) => x.head_sha === sha);
      if (check?.status === "completed") break;
    }
    if (check?.status !== "completed") {
      e.failures.push({ what: "check run completed", expected: `completed within ${CASE_TIMEOUT_MS}ms`, actual: JSON.stringify(check ?? "no check run created") });
      record(c.name, e.failures);
      continue;
    }
    const comments = rec.comments[pr] ?? [];
    const storedComments = await (await fetch(`${gh}/repos/acme/demo/issues/${pr}/comments`)).json();
    const r = { check, labels: rec.labels[pr] ?? [], comments, commentIds: storedComments.map((c) => c.id), block: parseBlock(comments[0]) };
    c.check(e, r, previous);
    previous = r;
    previousScenario = scenario;
    record(c.name, e.failures, `        check: ${check.conclusion} | ${check.title}\n${check.summary.split("\n").map((l) => "          | " + l).join("\n")}`);
  }

  const failed = results.filter((r) => r.failures.length > 0);
  console.log(`\ne2e: ${results.length - failed.length}/${results.length} passed`);
  return failed.length === 0 ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.error(`\ne2e: ${e.stack ?? e}`);
  for (const { name, log } of children) console.error(`\n--- ${name} log tail (${path.relative(ROOT, log)}) ---\n${tail(log, 15)}`);
} finally {
  clearTimeout(deadline);
  teardown();
}
process.exit(code);
