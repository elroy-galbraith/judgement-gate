# Operating the gate

## Rollout modes

`MODE` in `wrangler.toml`:
- `shadow` (default): the check always passes and the title reads `[Shadow] <verdict>`. Use it to calibrate.
- `enforce`: real success/failure. Making it block merges is done on the GitHub side with an organization ruleset that requires `judgement-gate`.

## Behaviour notes

- Webhook is acknowledged with 202 immediately; work runs in `ctx.waitUntil`, so GitHub's 10s timeout never applies.
- Handled actions: `opened`, `synchronize`, `reopened`, `ready_for_review`, and `edited` only when title or body changed. Drafts are ignored.
- Jev error, bad response, or timeout (`JEV_TIMEOUT_MS`, default 2500) gives conclusion `neutral` titled `[Audit Degraded]`. It fails open.
- Diff sent to Jev is capped at 50KB, with migrations, SQL, manifests, infra config and models first.
- Jev contract: `POST /api/alpha/decisions` on OpenRouter, model `typesafe/jev-1.14`. This is an alpha API and may change.

## End-to-end run

`npm run e2e` starts a scripted Jev (`scripts/jev-stub.mjs`), the mock GitHub and the real Worker via `wrangler dev`, sends signed webhooks for the demo scenarios in `scripts/scenarios.mjs`, and asserts on what the mock recorded (check conclusion and summary, comment, label, the hidden agent block). The stub's answers come from each scenario's `jev` field; failure modes (Jev down, unrecognised severity) are switched on the stub over HTTP. It needs no secrets, never reads your `.dev.vars`, and writes server logs to `e2e-logs/`. CI runs it as the `e2e` job, which uploads those logs when it fails. To cover a new behaviour, add a scenario (files and `jev` answers) and a case in `scripts/e2e.mjs`.

## Continuous deployment

`.github/workflows/deploy.yml` deploys the Worker with `wrangler deploy` after a reviewed change lands on `main`. Design and threat notes: [the design note](superpowers/specs/2026-10-20-continuous-deployment-design.md).

### What triggers a deploy

- A push to `main` that changes `src/**`, `wrangler.toml`, `package.json` or `package-lock.json`. Docs-only, test-only, script-only and workflow-only merges do not deploy.
- **Run workflow** on the Actions tab (`workflow_dispatch`), from `main`, to redeploy the current `main`. The jobs refuse to run from any other branch.
- Never a pull request, from a fork or not. Credentials are never available to code that has not been reviewed and merged.

Two jobs run in order. `verify` repeats typecheck, `npm test`, the `wrangler deploy --dry-run` build and `npm run e2e` on the merged commit, with no secrets. `deploy` then runs in the `production` environment, deploys with the lockfile's `wrangler`, and smoke-tests the live Worker: an unsigned `POST` to `<WORKER_URL>/webhook` must answer HTTP 401 with the body `invalid signature` (retried a few times, 6 s apart). `WORKER_URL` is an optional repository or environment variable; it defaults to `https://judgement-gate.elroy-galbraith.workers.dev`. The job summary lists the commit, the new version id, the previous version id and the rollback command. If merges land close together, the running deploy finishes, older queued runs are dropped and the newest commit deploys next.

### One-time setup (by hand, in this order)

1. **Create a Cloudflare API token with one permission.** Cloudflare dashboard, **My Profile**, **API Tokens**, **Create Token**, **Create Custom Token**. Under **Permissions** choose **Account**, then **Workers Scripts**, then **Edit** (type "Workers Scripts" in the search box; Cloudflare renames things now and then, so look for the entry that grants edit access to Worker scripts). Under **Account Resources** choose **Include**, **Specific account**, and pick the account that holds the Worker. Add no zone permissions. Do not use the "Edit Cloudflare Workers" template: it also grants KV, R2, D1, routes and zone access this workflow never needs, and the token is a secret that CI jobs can read. Optionally set an expiry and calendar the renewal. If the first run fails with a permission error, Cloudflare's message names the missing permission; add only that one.
2. **Create the `production` environment and its secrets.** GitHub repository, **Settings**, **Environments**, **New environment**, name it `production` exactly. In that environment add two **environment secrets** (not repository secrets, so other workflows cannot read them): `CLOUDFLARE_API_TOKEN` (the token from step 1) and `CLOUDFLARE_ACCOUNT_ID` (Cloudflare dashboard, **Workers & Pages**, **Overview**, **Account ID** on the right). Recommended on the same page: under **Deployment branches and tags** choose **Selected branches and tags** and add `main`. Optional: tick **Required reviewers** and add yourself or another maintainer. Every deploy then pauses for an approval click before the job gets the secrets. (Required reviewers on a private repository need a paid GitHub plan.)
3. **Optional: make CI required.** **Settings**, **Rules** (or **Branches**, if the repository uses classic branch protection), edit the rule for `main`, enable **Require status checks to pass** and add `ci` and `e2e`. `verify` repeats them on the merged commit, so this only stops a red PR from merging.

The workflow never creates any of this, and it cannot run its deploy job until step 2 is done (the job would fail at `wrangler deploy` for want of credentials).

### Rolling back

Each deploy summary prints the exact command. From a checkout with `npm ci` done and a Cloudflare login (`npx wrangler login`) or a token with the same permission:

```bash
npx wrangler deployments list           # the live version
npx wrangler versions list              # recent version ids
npx wrangler rollback <version id>      # make that version live again
```

The same is available in the Cloudflare dashboard under **Workers & Pages**, **judgement-gate**, **Deployments**. The workflow does not roll back by itself: the gate fails open, and the smoke test can fail for reasons a rollback does not fix (a missing secret, a wrong `WORKER_URL`, a Cloudflare incident), so a person decides. A rollback changes the running Worker but not `main`; the next deploy from `main` replaces it, so also revert the bad commit through a PR. If `wrangler` refuses a rollback (for example because bindings or secrets changed since that version), revert the commit on `main` through a reviewed PR; if the revert touches `src/**` or the other deploy paths it deploys through the pipeline, otherwise use **Run workflow**.

### What it deliberately does not do

- **Worker secrets.** `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET` and `JEV_API_KEY` are still set by hand with `wrangler secret put`. The workflow never reads, writes or deletes them, and a deploy never removes a secret.
- **Non-secret vars come from `wrangler.toml`.** `wrangler deploy` runs without `--keep-vars`, so a var that exists only in the Cloudflare dashboard is deleted by the next deploy, and every var in `wrangler.toml` is set. Change vars by PR. Today the live vars equal `wrangler.toml`, so the first deploy changes nothing.
- **Mode flips.** Moving from `shadow` to `enforce` is a reviewed edit of `MODE` in `wrangler.toml`; it deploys like any other change, with the PR as the audit trail.
- **Org config.** The `.github` repository (`judgement-gate.yml`, org judgements) is a different repository, read by the Worker at run time from its default branch. This workflow neither deploys nor changes it.
- **Repository settings.** Branch protection, environments, secrets and required checks stay under the maintainer's control.

## Things to know

- **Confidence threshold.** The 0.75 default applies to Jev's `confidence`, which measures how concentrated the distribution is (0.66/0.34 gives 0.32), not top probability. Clear-cut PRs score 0.9+, but borderline ones will often land on "Ambiguous". Tune `CONFIDENCE_THRESHOLD` during shadow mode.
- **Free tier.** The Worker uses well under the 10ms CPU limit, but the free plan allows 100k requests/day. Each PR event costs 1 Worker request plus 4-5 GitHub subrequests, within the 50 subrequest limit.
- **Metrics:** p95 latency, flag rate and false positives are recorded in Workers Analytics Engine when the `ANALYTICS` binding is present. See [calibration.md](calibration.md). Still not built: override tracking beyond the false-positive reply.
