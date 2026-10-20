import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import ciYml from "../.github/workflows/ci.yml?raw";
import deployYml from "../.github/workflows/deploy.yml?raw";

// Guards the properties that make deploy.yml safe to run with production credentials. It cannot prove the workflow
// works (only a real run does), but it stops a later edit from quietly widening what the token can reach.

const load = (file: "ci.yml" | "deploy.yml") => (file === "ci.yml" ? ciYml : deployYml);
const deploy = parse(load("deploy.yml")) as any;
const ci = parse(load("ci.yml")) as any;

const stepsOf = (job: any): any[] => job.steps ?? [];
const usesOf = (wf: any): string[] =>
  Object.values<any>(wf.jobs).flatMap((j) => stepsOf(j).map((s) => s.uses).filter(Boolean));
const runsOf = (job: any): string => stepsOf(job).map((s) => s.run ?? "").join("\n");

describe("deploy workflow", () => {
  // `on:` parses to the boolean-looking key `true` in YAML 1.1 but to "on" with the yaml package's default (1.2).
  const triggers = deploy.on;

  it("runs only on pushes to main that change the Worker, and on manual dispatch", () => {
    expect(Object.keys(triggers).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(triggers.push.branches).toEqual(["main"]);
    expect(triggers.push.paths).toEqual(["src/**", "wrangler.toml", "package.json", "package-lock.json"]);
  });

  it("never uses a trigger that runs untrusted code with secrets", () => {
    const text = load("deploy.yml");
    for (const t of ["pull_request", "pull_request_target", "workflow_run"]) expect(text).not.toMatch(new RegExp(`^\\s*${t}\\s*:`, "m"));
  });

  it("has a read-only token and no OIDC", () => {
    expect(deploy.permissions).toEqual({ contents: "read" });
    for (const job of Object.values<any>(deploy.jobs)) expect(job.permissions).toBeUndefined();
  });

  it("deploys only from main, after verify, in the production environment", () => {
    expect(Object.keys(deploy.jobs)).toEqual(["verify", "deploy"]);
    expect(deploy.jobs.verify.if).toBe("github.ref == 'refs/heads/main'");
    expect(deploy.jobs.deploy.if).toBe("github.ref == 'refs/heads/main'");
    expect(deploy.jobs.deploy.needs).toBe("verify");
    expect(deploy.jobs.deploy.environment).toBe("production");
    expect(deploy.jobs.verify.environment).toBeUndefined();
  });

  it("queues deploys instead of cancelling one midway", () => {
    expect(deploy.jobs.deploy.concurrency).toEqual({ group: "deploy-production", "cancel-in-progress": false });
  });

  it("bounds every job", () => {
    for (const job of Object.values<any>(deploy.jobs)) expect(job["timeout-minutes"]).toBeGreaterThan(0);
  });

  it("uses only action versions that ci.yml already pins", () => {
    const allowed = new Set(usesOf(ci));
    const used = usesOf(deploy);
    expect(used.length).toBeGreaterThan(0);
    for (const u of used) expect(allowed, u).toContain(u);
    expect(used.every((u) => /@v\d+$/.test(u))).toBe(true);
  });

  it("does not persist the checkout token", () => {
    for (const job of Object.values<any>(deploy.jobs)) {
      const checkout = stepsOf(job).filter((s) => String(s.uses).startsWith("actions/checkout@"));
      expect(checkout.length).toBe(1);
      expect(checkout[0].with["persist-credentials"]).toBe(false);
    }
  });

  it("gives the Cloudflare credentials to the deploy job only, never at job level", () => {
    const verifyText = JSON.stringify(deploy.jobs.verify);
    expect(verifyText).not.toMatch(/CLOUDFLARE|secrets\./);
    expect(deploy.jobs.deploy.env ?? {}).not.toHaveProperty("CLOUDFLARE_API_TOKEN");
    const withToken = stepsOf(deploy.jobs.deploy).filter((s) => s.env?.CLOUDFLARE_API_TOKEN);
    expect(withToken.length).toBeGreaterThan(0);
    for (const s of withToken) {
      expect(s.env.CLOUDFLARE_API_TOKEN).toBe("${{ secrets.CLOUDFLARE_API_TOKEN }}");
      expect(s.env.CLOUDFLARE_ACCOUNT_ID).toBe("${{ secrets.CLOUDFLARE_ACCOUNT_ID }}");
      expect(s.run, "install steps must not see the token").not.toMatch(/npm (ci|install)/);
    }
    // Nothing else in the workflow mentions a secret.
    const refs = load("deploy.yml").match(/secrets\.[A-Z_]+/g) ?? [];
    expect(new Set(refs)).toEqual(new Set(["secrets.CLOUDFLARE_API_TOKEN", "secrets.CLOUDFLARE_ACCOUNT_ID"]));
  });

  it("verifies with the same checks as CI, including the real-Worker e2e", () => {
    const run = runsOf(deploy.jobs.verify);
    for (const cmd of ["npm ci", "npm run typecheck", "npm test", "wrangler deploy --dry-run", "npm run e2e"]) expect(run).toContain(cmd);
  });

  it("deploys with the lockfile's wrangler, vars from wrangler.toml, and never touches secrets", () => {
    const run = runsOf(deploy.jobs.deploy);
    expect(run).toMatch(/npx wrangler deploy\b/);
    expect(run).not.toMatch(/--dry-run/);
    expect(run).not.toContain("--keep-vars");
    expect(run).not.toMatch(/--secrets-file|wrangler secret|--var\b/);
    expect(load("deploy.yml")).not.toMatch(/uses:\s*cloudflare\//);
  });

  it("smoke-tests the webhook for 401 invalid signature and prints the rollback command", () => {
    const text = load("deploy.yml");
    expect(text).toContain("https://judgement-gate.elroy-galbraith.workers.dev");
    expect(text).toContain("vars.WORKER_URL");
    expect(text).toContain("invalid signature");
    expect(text).toContain("npx wrangler rollback");
    expect(text).toContain("GITHUB_STEP_SUMMARY");
    expect(text).not.toMatch(/wrangler rollback[^\n]*\n[^\n]*--yes/); // guidance only; no automatic rollback
    expect(runsOf(deploy.jobs.deploy)).not.toMatch(/^\s*npx wrangler rollback/m);
  });

  it("does not interpolate github context into shell scripts", () => {
    for (const job of Object.values<any>(deploy.jobs)) for (const s of stepsOf(job)) expect(s.run ?? "", s.name).not.toContain("${{");
  });
});
