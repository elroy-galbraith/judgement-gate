// Tiny fake GitHub API so the demo works without a GitHub App. Run: npm run mock-github
// Point the Worker at it with GITHUB_API_URL=http://localhost:8788 (see .dev.vars.example).
// Scenarios are chosen by PR number (see SCENARIOS) and recorded results are printed to the console.
// For tests (scripts/e2e.mjs): GET /__recorded returns what the Worker wrote, POST /__reset clears it, and
// POST /__register {pr, files} gives a PR number its own changed files. None of these change the demo.
import fs from "node:fs";
import http from "node:http";

const PORT = Number(process.env.PORT ?? 8788);
// The org judgement config the fake `.github` repo serves. Point MOCK_CONFIG elsewhere to try your own.
const CONFIG_FILE = process.env.MOCK_CONFIG ?? "examples/judgement-gate.yml";

import { SCENARIOS } from "./scenarios.mjs";

const comments = new Map(); // pr -> [{id, body}]
const checks = new Map(); // check run id -> {id, head_sha, name, status, conclusion, title, summary}
const labels = new Map(); // pr -> [label, ...] in the order they were added
const registered = new Map(); // pr -> files, set through /__register
let nextId = 1000;

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
  const url = new URL(req.url, "http://x");
  const send = (obj, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

  let m;
  if (req.method === "GET" && url.pathname === "/__recorded") {
    const comment_bodies = Object.fromEntries([...comments].map(([pr, list]) => [pr, list.map((c) => c.body)]));
    return send({ checks: [...checks.values()], comments: comment_bodies, labels: Object.fromEntries(labels) });
  }
  if (req.method === "POST" && url.pathname === "/__reset") {
    for (const map of [comments, checks, labels, registered]) map.clear();
    return send({});
  }
  if (req.method === "POST" && url.pathname === "/__register") {
    registered.set(String(body.pr), body.files);
    return send({});
  }
  if (req.method === "POST" && /\/access_tokens$/.test(url.pathname)) return send({ token: "mock-token" }, 201);
  if (req.method === "GET" && (m = url.pathname.match(/\/commits\/([^/]+)\/check-runs$/))) {
    const name = url.searchParams.get("check_name");
    const runs = [...checks.values()].filter((c) => c.head_sha === m[1] && (!name || c.name === name));
    return send({ total_count: runs.length, check_runs: runs.map((c) => ({ ...c, app: { id: Number(process.env.GITHUB_APP_ID ?? 1) } })) });
  }
  if (req.method === "POST" && /\/check-runs$/.test(url.pathname)) {
    log(`CHECK  in_progress  ${body.name} @ ${body.head_sha.slice(0, 7)}`);
    const id = nextId++;
    checks.set(id, { id, head_sha: body.head_sha, name: body.name, status: "in_progress" });
    return send({ id }, 201);
  }
  if (req.method === "PATCH" && /\/check-runs\/\d+$/.test(url.pathname)) {
    const check = checks.get(Number(url.pathname.split("/").pop()));
    if (body.status === "in_progress") {
      // A reopened run: the gate is evaluating this commit again.
      if (check) Object.assign(check, { status: "in_progress", conclusion: undefined });
      log(`CHECK  in_progress  (reopened)`);
      return send({});
    }
    if (check) Object.assign(check, { status: "completed", conclusion: body.conclusion, title: body.output.title, summary: body.output.summary ?? "" });
    log(`CHECK  ${body.conclusion.toUpperCase().padEnd(8)} ${body.output.title}`);
    for (const line of (body.output.summary ?? "").split("\n").filter(Boolean)) console.log("         | " + line);
    return send({});
  }
  if ((m = url.pathname.match(/\/pulls\/(\d+)\/files$/))) {
    return send(url.searchParams.get("page") === "1" ? (registered.get(m[1]) ?? SCENARIOS[m[1]]?.files ?? []) : []);
  }
  if (req.method === "POST" && (m = url.pathname.match(/\/issues\/(\d+)\/labels$/))) {
    labels.set(m[1], [...(labels.get(m[1]) ?? []), ...(body?.labels ?? [])]);
    log(`LABEL added on #${m[1]}: ${(body?.labels ?? []).join(", ")}`);
    return send([]);
  }
  if ((m = url.pathname.match(/\/issues\/(\d+)\/comments$/))) {
    const list = comments.get(m[1]) ?? [];
    if (req.method === "GET") return send(list);
    list.push({ id: nextId++, body: body.body });
    comments.set(m[1], list);
    log(`COMMENT created on #${m[1]}:\n${body.body.split("\n").map((l) => "         | " + l).join("\n")}`);
    return send({ id: nextId }, 201);
  }
  if ((m = url.pathname.match(/\/issues\/comments\/(\d+)$/)) && req.method === "PATCH") {
    for (const list of comments.values()) for (const c of list) if (String(c.id) === m[1]) c.body = body.body;
    log(`COMMENT edited #${m[1]}`);
    return send({});
  }
  if (req.method === "GET" && /\/repos\/[^/]+\/\.github\/contents\/\.github\/judgement-gate\.yml$/.test(url.pathname)) {
    if (!fs.existsSync(CONFIG_FILE)) return send({ message: "Not Found" }, 404);
    res.writeHead(200, { "Content-Type": "text/plain" });
    log(`CONFIG served ${CONFIG_FILE}`);
    return res.end(fs.readFileSync(CONFIG_FILE, "utf8"));
  }
  send({ error: "not found" }, 404);
});

server.listen(PORT, () => console.log(`mock GitHub on http://localhost:${PORT}`));
