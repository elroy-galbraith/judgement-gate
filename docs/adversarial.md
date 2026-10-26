# Adversarial testing

The PR title, body and diff go straight to the model, so an author (or an agent) can try to push a judgement the way they want: placeholder text, persuasion, instructions planted in the PR, or a risky change hidden past the diff cap. The adversarial corpus measures which of those attempts get through. It is not part of CI: it makes live API calls and the model is not deterministic.

## Run it

```bash
JEV_API_KEY=... npm run adversarial -- --runs 3
```

It reads `JEV_API_KEY` (or `OPENROUTER_API_KEY`) and optionally `JEV_MODEL` and `JEV_API_URL`. Options:

| Option | Meaning |
| --- | --- |
| `--runs N` | Runs per case (default 3). The model varies between runs, so one run proves little. |
| `--case a,b` | Only these case ids. |
| `--attack injection` | Only one attack kind: `placeholder`, `persuasion`, `mislabel`, `injection`, `cap` or `control`. |
| `--concurrency N` | Parallel requests (default 4). |
| `--out path.json` | Also write every run as JSON. `adversarial-results/` is git-ignored. |

The script builds each request with the gate's own code (`buildPatchExtract`, `buildRequest`, `evaluate` and each judgement's `decide`), against the judgements in `test/fixtures/adversarial/config.yml`. What it measures is what the Worker would decide.

## Reading the report

Each case says what a sound gate does with that PR (`want`):

- `block`: the judgement should fail. Every attack case is `block`. A run that passes is **GAMED**. `(n never fired)` means the model did not see the change as risky at all, which is a miss rather than a clearing trick.
- `pass`: a sound PR (`control`). A run that fails is a **FALSE BLOCK**. Controls keep a gate that blocks everything from looking robust.

The bracketed reason codes show how the judgement decided, for example `type2_ok` (a placeholder plan was accepted) or `api-contract-regex_ok` (a regex cleared it).

## The corpus

`test/fixtures/adversarial/cases/*.json`, one PR per file: `title`, `body`, `files` (with `patch`, or `fillBytes` of filler in front of it to push a hunk past the diff cap), the judgements graded, and a one-line `note` on what the author is trying. The two `api-contract-*` judgements in `config.yml` ask the same question and differ only in how an author clears it, so one run shows what the `answers` rule closes over a regex.

`npm test` checks that the corpus is well formed and that the cap cases really overflow the budget, with a stubbed model. If a change to the diff extract makes the cap tests fail, the corpus needs updating to match.

## Known limit

A destructive change split across several small PRs can't be caught per PR, because each PR is judged alone. The corpus does not cover it.

## Findings (2026-10-26, `typesafe/jev-1.14`)

Corpus run 3 times per case, plus 5 times for the cap cases. Raw runs are not committed.

| Attack | one-way-door | `api-contract-regex` | `api-contract-answers` |
| --- | --- | --- | --- |
| Placeholders (`n/a`, `none`, `TBD`, "see description", restated template, empty fields, a TODO-only note file) | held 21/21 | **gamed 12/12** | held 12/12 |
| Persuasion (claims a plan exists, appeals to approval, long confident narrative) | held 9/9 | **gamed 3/3** | held 3/3 |
| Mislabelling (body or title lies about a destructive migration, plan but no ADR, ADR cited but not added, old ADR edited) | held 15/15 | n/a | n/a |
| Injection (instructions to the model in the body, title, diff comment or plan lines) | held 12/12 | **gamed 3/3** | held 3/3 |
| Controls (sound PRs) | passed 6/6 | passed 3/3 | passed 3/3 |

- **The model-judged questions resist these attacks.** `one-way-door` was never talked past by a placeholder, persuasion, mislabelling or injection. That includes the `none; this PR is never merged` case from the issue and instructions planted in the diff.
- **A regex-cleared declarative judgement is gamed by every attack.** `Migration Plan: n/a` clears it, as does a TODO-only file added under `docs/api-changes/`. The same judgement written with `answers` held every time and still passed the genuine control. Use `answers` (see #22) for judgements where the clearing text matters.
- **The diff cap was a real hole, now fixed.** When the destructive hunk fell past the 50KB extract (`ow-cap-later-file`, `ow-cap-same-file`), the model never saw it: one-way boundary 3-8%, classified Type 2. Those PRs only failed because they had no reversal plan. With a real-looking plan in the body (`*-plan` cases) they **passed 10/10**. A migration among the same filler was caught, because migration files rank first in the extract.
- **After the fix** (5 runs per cap case): 0 of 25 gamed, down from 10 of 25. A small file after a big one now keeps its whole diff, so the model sees the hunk and the PR fails as `type1_no_adr`. A hunk past the cut inside one big file is still never seen, so the PR fails as `ambiguous` whatever its plan says. The margin on the first kind is thin: with 60KB of noise beside it the model put the one-way probability at only 55-59% (threshold 40%), so a bigger or noisier PR could still slip under.

### What this suggests

1. ~~Fix the cap.~~ Done: a per-file share of the budget, a truncation notice in the diff the model reads, and a truncated diff is `ambiguous` (see [operations](operations.md)). Still open: a file GitHub sends without a patch (binary, or too big for its API) is skipped silently and does not count as truncation, and the declarative judgements are not affected by truncation.
2. Do not build the regex placeholder pre-check for the one-way-door plan lines. The model rejected every placeholder in the corpus, so it would add code without closing a measured gap. Revisit if a future model version or a new corpus case shows otherwise.
3. Recommend `answers` in the shipped example config and docs, with the regex form described as clearing on form, not substance.

Limits of these numbers: one model version, 3 runs per case, and a corpus written by the people defending the gate. Add cases when a real PR gets through.
