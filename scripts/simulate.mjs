// Send a signed pull_request webhook to the Worker. Usage: npm run simulate -- <scenario 1-7> [action]
// Scenarios live in scripts/scenarios.mjs. Reads WEBHOOK_URL and GITHUB_WEBHOOK_SECRET from env.
import crypto from "node:crypto";
import { SCENARIOS } from "./scenarios.mjs";

const url = process.env.WEBHOOK_URL ?? "http://localhost:8787/webhook";
const secret = process.env.GITHUB_WEBHOOK_SECRET ?? "dev-secret";
const n = process.argv[2] ?? "1";
const action = process.argv[3] ?? "opened";
const s = SCENARIOS[n];
if (!s) throw new Error(`unknown scenario ${n}; choose ${Object.keys(SCENARIOS).join(", ")}`);

const payload = JSON.stringify({
  action,
  installation: { id: 1 },
  repository: { name: "demo", owner: { login: "acme" } },
  pull_request: {
    number: Number(n),
    title: s.title,
    body: s.body,
    draft: false,
    base: { ref: "main" },
    head: { ref: `scenario-${n}`, sha: crypto.randomBytes(20).toString("hex") },
  },
  ...(action === "edited" ? { changes: { body: { from: "" } } } : {}),
});
const sig = "sha256=" + crypto.createHmac("sha256", secret).update(payload).digest("hex");
const res = await fetch(url, {
  method: "POST",
  headers: { "X-GitHub-Event": "pull_request", "X-Hub-Signature-256": sig, "Content-Type": "application/json" },
  body: payload,
});
console.log(`scenario ${n} (${s.title}) -> ${res.status} ${await res.text()}`);
