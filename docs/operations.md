# Operating the gate

## Rollout modes

`MODE` in `wrangler.toml`:
- `shadow` (default): the check always passes and the title reads `[Shadow] <verdict>`. Use it to calibrate.
- `enforce`: real success/failure. Making it block merges is done on the GitHub side with an organization ruleset that requires `judgement-gate`.

## Behaviour notes

- Webhook is acknowledged with 202 immediately; work runs in `ctx.waitUntil`, so GitHub's 10s timeout never applies.
- Handled actions: `opened`, `synchronize`, `reopened`, `ready_for_review`, and `edited` only when title or body changed. Drafts are ignored (see [below](#what-is-deliberately-not-evaluated)). `merge_group` `checks_requested` is answered without evaluating (see [Merge queue](#merge-queue)).
- Jev error, bad response, or timeout (`JEV_TIMEOUT_MS`, default 2500) gives conclusion `neutral` titled `[Audit Degraded]`. It fails open, as does any other error once the check run exists (see [Fail-open](#fail-open-behaviour)).
- When all applicable judgements pass, an existing gate comment is updated in place, clearing its remediation text and hidden failing instructions. The passing note never creates a new comment; human-review routing comments keep their existing behaviour. Shadow-mode failures still show remediation, and degraded evaluations leave existing comments unchanged. A comment API failure adds a diagnostic to the check summary without changing the verdict.
- Diff sent to Jev is capped at 50KB, with migrations, SQL, manifests, infra config and models first.
- Jev contract: `POST /api/alpha/decisions` on OpenRouter, model `typesafe/jev-1.14`. This is an alpha API and may change.

## Fail-open behaviour

The rule: once the `judgement-gate` check run exists, it is always completed, and the gate never blocks a merge because the gate itself broke. Only a real verdict (`failure`, in `enforce` mode) blocks.

| What goes wrong | What the check shows |
|---|---|
| Jev error, timeout, unusable answer | `neutral`, `[Audit Degraded]` |
| Any other error after the check run was created (listing files, reading config, building the verdict) | `neutral`, `[Audit Degraded]`, with the error in the summary |
| Completing the check run fails (GitHub 5xx, network) | Retried; if it still fails, a `neutral` completion is tried (also retried) |
| Installation token or check run creation fails | Retried, then see below |

Calls the check depends on (installation token, creating the check run, completing it) are tried up to 3 times, waiting 250ms then 750ms in between. That is under a second of waiting, so a short GitHub blip is absorbed without holding the Worker long. The comment, label and analytics calls are best-effort and are not retried; they never change the verdict.

### When the check cannot be completed

Two cases cannot fail open, because there is no way to tell GitHub anything:

- **No check run could be created.** The token or `POST /check-runs` failed three times. The error is logged (`judgement-gate failed` in the Worker logs) and nothing is reported. A required check then shows "Expected — Waiting for status" on that PR. This was a decision, not an oversight: the alternatives (a commit status, a comment) need extra permissions and would not satisfy a ruleset that names the check run. In practice the cause is a GitHub outage or revoked app permissions, which a failing Worker cannot fix.
- **The Worker is killed mid-run** (CPU or memory limit). No code runs after that, so a check run that already exists stays `in progress`. The guards against this are the config-load rejection of nested-quantifier patterns, the 10,000-character cap on regex input (which only bounds polynomial patterns; overlapping alternation such as `(a|a)*` is not caught, see [configuration.md](configuration.md#regex-caution)), and the small amount of work the Worker does.

To recover, either re-deliver the webhook (GitHub App settings, Advanced, Recent deliveries, Redeliver), or make a new event happen on the PR: push a commit, or edit the title or description. A new commit gets a fresh check run on its own head. A user in the ruleset's bypass list can merge in the meantime, which is why the bypass list is part of the rollout below.

### What is deliberately not evaluated

- **Draft PRs** get no check. GitHub does not let a draft PR be merged, so a required check on a draft blocks nothing that could merge. Marking it ready triggers `ready_for_review`, which runs the gate.
- **Edits that change neither title nor body** (for example retargeting the base branch) are ignored. The existing check run for the head commit stays as it was. To re-evaluate, edit the title or description or push a commit.
- **Other events** (closed, labelled, comments other than `/judgement-gate false-positive`) are ignored.

### Merge queue

The gate answers a `merge_group` `checks_requested` event by creating an already-completed `judgement-gate` check run with conclusion `success` on the group's head commit. It does not call Jev and does not read the PRs.

Why not evaluate the group: a PR can only be enqueued after its required checks passed on its own head, so every PR in the queue has already been judged on the text the authors wrote, and the group commit is a mechanical merge with no description of its own to judge. Re-evaluating would spend a Jev call per group, could not use any PR description, and would add a new way for the queue to stall. The cost of this choice is that two PRs which are each fine alone but not together are not caught by the gate; that is what the required CI checks on the merge group are for.

This works in `shadow` and `enforce` mode alike, and it needs the app subscribed to the **Merge group** event. It has not been exercised against a live merge queue yet: when you enable one, queue a test PR and confirm the check appears on the `gh-readonly-queue/...` commit.

## Rolling out the required check safely

1. **Calibrate in shadow.** Run in `shadow` for about two weeks first ([calibration.md](calibration.md)). Look at the share of `degraded` evaluations: it is the fraction of PRs the gate cannot judge, and it should be small before anyone depends on the gate.
2. **Install and subscribe.** The app must be installed on every repo in the ruleset, with the **Pull request** event, plus **Merge group** if a merge queue is used. A repo in the ruleset where the app is not installed can never merge, because the required check never appears.
3. **Make the check required while still in shadow.** In the organisation ruleset, target one willing repo, add the required status check `judgement-gate`, and choose this GitHub App as its source so no other app or status can supply a passing result. Shadow mode always reports `success`, so this step only proves that the check shows up on every PR (including a queued one). Open a PR, a draft that you mark ready, and a queued PR to see it.
4. **Set a bypass list before enforcing.** Give a small admin group, or a break-glass team, bypass on the ruleset ("always" or "for pull requests only"). It is the way out of the two cases in [When the check cannot be completed](#when-the-check-cannot-be-completed).
5. **Flip to enforce.** Set `MODE = "enforce"` and deploy. Judge it on that one repo for a while before widening the ruleset's targets repo by repo.
6. **Watch.** Look for PRs stuck at "Expected" and for `judgement-gate failed` lines in the Worker logs; either means a check run was never created.

**Backing out**, fastest first: set `MODE = "shadow"` and deploy (every new check passes); remove `judgement-gate` from the ruleset's required checks, or set the ruleset to disabled (merges are unblocked at once, whatever the Worker does).

## End-to-end run

`npm run e2e` starts a scripted Jev (`scripts/jev-stub.mjs`), the mock GitHub and the real Worker via `wrangler dev`, sends signed webhooks for the demo scenarios in `scripts/scenarios.mjs`, and asserts on what the mock recorded (check conclusion and summary, comment, label, the hidden agent block). The stub's answers come from each scenario's `jev` field; failure modes (Jev down, unrecognised severity) are switched on the stub over HTTP. It needs no secrets, never reads your `.dev.vars`, and writes server logs to `e2e-logs/`. CI runs it as the `e2e` job, which uploads those logs when it fails. To cover a new behaviour, add a scenario (files and `jev` answers) and a case in `scripts/e2e.mjs`.

The comment lifecycle cases reuse one PR across failure, a description edit adding a reversal plan, a repeated pass, and an edit removing the plan. They verify that the same comment ID is kept, stale remediation is cleared on success, and a later failure restores the remediation. Set `reusePr: true` on a case to evaluate the previous PR again without clearing its comment state.

## Things to know

- **Confidence threshold.** The 0.75 default applies to Jev's `confidence`, which measures how concentrated the distribution is (0.66/0.34 gives 0.32), not top probability. Clear-cut PRs score 0.9+, but borderline ones will often land on "Ambiguous". Tune `CONFIDENCE_THRESHOLD` during shadow mode.
- **Free tier.** The Worker uses well under the 10ms CPU limit, but the free plan allows 100k requests/day. Each PR event costs 1 Worker request plus 4-5 GitHub subrequests, within the 50 subrequest limit.
- **Metrics:** p95 latency, flag rate and false positives are recorded in Workers Analytics Engine when the `ANALYTICS` binding is present. See [calibration.md](calibration.md). Still not built: override tracking beyond the false-positive reply.
