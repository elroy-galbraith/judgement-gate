# Continuous deployment: design

## Intent

Deployment is `npx wrangler deploy` from a developer machine. The maintainer wants a merge to `main` to deploy the Worker, without giving a CI job more power than it needs. `main` requires one approving review, so every change reaches `main` through a reviewed PR; the workflow adds no new trust in PR authors, it only removes the manual step.

The workflow (`.github/workflows/deploy.yml`) deploys. It does not create secrets, environments or tokens, and it changes no repository setting. Those are one-time steps for the maintainer (see `docs/operations.md#continuous-deployment`).

## Triggers

- `push` to `main`, filtered with `paths:` to `src/**`, `wrangler.toml`, `package.json`, `package-lock.json`. Docs-only, test-only and script-only merges do not deploy. `deploy.yml` itself is not in the filter: a change to the pipeline is not a change to the Worker, and the next Worker change or a manual dispatch uses it.
- `workflow_dispatch`: deploy the current `main` by hand (for example after a reverted setting, or to redeploy after a Cloudflare incident).
- Never `pull_request`, `pull_request_target` or `workflow_run`. Both jobs carry `if: github.ref == 'refs/heads/main'`, because `workflow_dispatch` can be started on any branch and must not be able to deploy a feature branch.

## Jobs

1. `verify`: checkout, Node 24 with npm cache, `npm ci`, typecheck, vitest, `wrangler deploy --dry-run`, `npm run e2e`. No secrets, read-only token. It repeats what the `ci` and `e2e` jobs prove for the merged commit, because a deploy should not rely on a check that someone might have skipped or that ran on a different merge base. The e2e logs are uploaded on failure.
2. `deploy`: `needs: verify`, `environment: production`. Only this job can see `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, and only as environment secrets, passed with step-level `env:` to the three steps that call wrangler (never to `npm ci`). Required reviewers on the `production` environment give a manual approval gate with no change to the workflow.

Permissions are `contents: read` for the whole workflow, `persist-credentials: false` on checkout, no `id-token`. Deploy runs the lockfile's `wrangler` through `npx`, with no third-party deploy action, so the token never reaches marketplace code. Action versions are the ones `ci.yml` uses, so dependabot's grouped `github-actions` update bumps both files together.

## Concurrency

`group: deploy-production`, `cancel-in-progress: false`, set on the `deploy` job so verification of a later merge can run while an earlier deploy is in flight. A running deploy is never cancelled. GitHub keeps at most one pending run per group and replaces an older pending run with the newer one, so when merges A, B, C land close together A deploys, B is dropped, C deploys after A. The last deploy is always the newest commit; nothing newer is ever overwritten by something older.

## Vars: no `--keep-vars`

`wrangler.toml` is the source of truth for non-secret vars, so a change such as `MODE = "enforce"` is a reviewed PR. Without `--keep-vars`, wrangler deletes vars that exist only in the dashboard and sets those in `wrangler.toml`. That is the intended property here: a dashboard edit cannot silently diverge from what was reviewed, and the next deploy reverts it. The cost is that a hot fix made in the dashboard is lost on the next deploy, and that a var added in the dashboard for an experiment must also go in `wrangler.toml`. Today the live vars equal `wrangler.toml`, so the first deploy changes nothing. Secrets are never deleted by deploys and the workflow never writes them (`--secrets-file` is not used).

## Version id and previous version

Before deploying, the deploy job reads the current deployment (`wrangler deployments list --json`) and records the live version id as the rollback target. A failure to read it does not block the deploy; the summary then points at `wrangler versions list`. The new version id comes from wrangler's own machine-readable output (`WRANGLER_OUTPUT_FILE_PATH`, the `deploy` entry's `version_id`), not from scraping the console text.

## Smoke test and rollback

After the deploy, `POST` an unsigned body to `$WORKER_URL/webhook` (repository or environment variable `WORKER_URL`, default `https://judgement-gate.elroy-galbraith.workers.dev`). The handler verifies the signature before it reads the event, so the only passing answer is HTTP 401 with body `invalid signature`. That proves the new version boots, routes `/webhook`, has `GITHUB_WEBHOOK_SECRET` bound and runs the signature check, with no GitHub or Jev call and nothing written. It retries a few times with a short pause because the new version may take a moment to be served everywhere.

The job summary always gets the commit SHA, the new version id, the previous version id and the rollback command. If the smoke test fails the job fails and the summary and log print `npx wrangler rollback <previous version id>`.

**No automatic rollback.** The gate fails open (Jev errors give `neutral`), so a bad version rarely blocks merges, and the 401 check can also fail for reasons a rollback does not fix (a missing secret, a wrong `WORKER_URL`, a Cloudflare incident). Rolling back automatically would need the previous version id to be right, and it would change production a second time without a human looking. The summary gives the exact command so the human decision takes seconds. Revisit if a bad deploy ever matters.

## Threat notes

- **Fork PR cannot reach the credentials.** The workflow has no `pull_request*` trigger, so it never runs for a PR. A push to `main` only happens after a reviewed merge. Fork PRs do not get environment secrets anyway.
- **A PR cannot change the workflow that deploys it before review.** A push run uses the workflow file at the pushed commit on `main`, which only exists after the reviewed merge. A branch edit of `deploy.yml` is not run by any trigger of this workflow.
- **`workflow_dispatch` on a branch.** The `if: github.ref == 'refs/heads/main'` guard stops it; the maintainer can also restrict the `production` environment to the `main` branch.
- **Verify passes, smoke test fails.** The new version is live (wrangler already switched traffic). The job fails and is red on `main`, the summary prints the rollback command, and the maintainer decides. The next push or dispatch queues behind it.

## Out of scope

No `src/` change, no Worker secrets, no org config (the `.github` repo), no mode flips, no change to branch protection. A PR that flips `MODE` in `wrangler.toml` deploys like any other and is the audited way to change mode.
