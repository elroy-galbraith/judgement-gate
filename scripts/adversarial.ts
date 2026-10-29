// Run the adversarial corpus (test/fixtures/adversarial/) against the live Jev API, through the gate's own request
// builder and decision code, and report which cases got past it. Not part of CI: it costs API calls and the model is
// not deterministic. Usage: npm run adversarial -- [--runs 3] [--case ow-ph-na,api-ph-tbd] [--attack injection]
//   [--concurrency 4] [--out adversarial-results/run.json]
// Reads JEV_API_KEY (or OPENROUTER_API_KEY), and optionally JEV_MODEL and JEV_API_URL, from the environment.
import fs from "node:fs";
import path from "node:path";
import { parseConfig } from "../src/config";
import type { JevConfig } from "../src/jev";
import { renderReport, runCase, type AdversarialCase, type CaseRun } from "../test/adversarial/harness";

const FIXTURES = path.join(import.meta.dirname, "..", "test", "fixtures", "adversarial");
const JEV_TIMEOUT_MS = 30_000;

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const apiKey = process.env.JEV_API_KEY ?? process.env.OPENROUTER_API_KEY;
if (!apiKey) throw new Error("set JEV_API_KEY (or OPENROUTER_API_KEY)");
const cfg: JevConfig = {
  apiKey,
  url: process.env.JEV_API_URL ?? "https://openrouter.ai/api/alpha/decisions",
  model: process.env.JEV_MODEL ?? "typesafe/jev-1.14",
  timeoutMs: JEV_TIMEOUT_MS,
};
const runsPerCase = Number(flag("runs") ?? 3);
const concurrency = Number(flag("concurrency") ?? 4);
if (!(runsPerCase >= 1) || !(concurrency >= 1)) throw new Error("--runs and --concurrency must be at least 1");

const judgements = parseConfig(fs.readFileSync(path.join(FIXTURES, "config.yml"), "utf8"), { confidenceThreshold: 0.75 });
const wantedIds = flag("case")?.split(",");
const wantedAttack = flag("attack");
const cases = fs
  .readdirSync(path.join(FIXTURES, "cases"))
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(fs.readFileSync(path.join(FIXTURES, "cases", f), "utf8")) as AdversarialCase)
  .filter((c) => (wantedIds ? wantedIds.includes(c.id) : true) && (wantedAttack ? c.attack === wantedAttack : true));
if (cases.length === 0) throw new Error("no cases match");

const jobs = cases.flatMap((c) => Array.from({ length: runsPerCase }, () => c));
const runs: CaseRun[] = [];
const errors: { caseId: string; message: string }[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const c = jobs[next++];
      try {
        runs.push(await runCase(c, judgements, cfg, fetch));
      } catch (e) {
        errors.push({ caseId: c.id, message: (e as Error).message });
      }
    }
  }),
);

console.log(renderReport(cases, runs, { model: cfg.model, runsPerCase }));
for (const e of errors) console.log(`error ${e.caseId}: ${e.message}`);
if (errors.length > 0) console.log(`${errors.length} of ${jobs.length} runs failed and are not counted above.`);

const out = flag("out");
if (out) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ model: cfg.model, runsPerCase, at: new Date().toISOString(), runs, errors }, null, 2));
  console.log(`wrote ${out}`);
}
