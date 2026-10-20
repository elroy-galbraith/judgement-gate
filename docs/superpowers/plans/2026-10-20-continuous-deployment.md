# Continuous deployment Implementation Plan

> Spec: `docs/superpowers/specs/2026-10-20-continuous-deployment-design.md`. Read it first; this plan only orders the work.

**Goal:** a merge to `main` that changes the Worker deploys it through `.github/workflows/deploy.yml`, with a verify gate, an environment-scoped token, a smoke test and a summary that carries the rollback command.

**Constraints:** no `src/` change; no real deploy, no Cloudflare authentication, no secrets; 310 vitest tests and typecheck stay green; actions pinned to the versions in `ci.yml`.

## Tasks

1. **Guard test first** (`test/deploy-workflow.test.ts`). Parse `deploy.yml` with `yaml` and assert the invariants: triggers, no forbidden triggers, `permissions`, `needs`, `environment`, `concurrency`, `timeout-minutes`, action versions equal to `ci.yml`, `persist-credentials: false`, the Cloudflare secrets used only in `deploy`, no `--keep-vars`, no `--secrets-file`. Verify: fails because the file does not exist.
2. **Workflow** (`.github/workflows/deploy.yml`). `verify` and `deploy` jobs; smoke test and summary as shell steps. Verify: the test passes; hand-check YAML and expressions (no actionlint available offline); run the smoke-test shell logic against a local server for pass and fail.
3. **Docs** (`docs/operations.md` "Continuous deployment", `README.md` pointer under "Deploy for real").
4. **Verify and PR.** `npm run typecheck`, `npm test`, `npx wrangler deploy --dry-run`; open the PR with a Reversal Trigger / Rollback Path / Owner section, wait for CI, hand-over note in the shared notes folder.

## Review focus

- Cloudflare credentials appear only in `deploy`, only in step `env`, never in `npm ci`.
- `if: github.ref == 'refs/heads/main'` on both jobs.
- No `${{ }}` of untrusted input inside `run:` scripts.
- Smoke test fails on anything other than 401 + `invalid signature`.
