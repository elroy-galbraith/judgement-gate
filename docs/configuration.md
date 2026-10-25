# Configuring judgements

A judgement is what the gate asks about a change. The Worker sends every applicable judgement to Jev in one request, then posts one check and one comment.

**No config needed.** Without a config file, the built-in `one-way-door` judgement runs. Failure comments show a "Why" and a "Fix", and the check summary lists each judgement.

**Add your own.** Create `.github/judgement-gate.yml` in your organisation's `.github` repo (repo name overridable with `CONFIG_REPO`). Protect it with CODEOWNERS and branch protection that requires Code Owner review on that repo's default branch: whoever approves changes to that file owns the org's judgement. It is always read from the **default branch**, so a PR cannot change the rules that gate it. See [examples/judgement-gate.yml](../examples/judgement-gate.yml).

| Key | Meaning |
|---|---|
| `use` | Enable a built-in (`one-way-door`). Only `confidence_threshold`, `applies_to` and `probes` may be overridden. |
| `id`, `name` | Unique id (kebab-case) and the name shown in the comment. |
| `question`, `true`, `false` | The yes/no question for Jev, and what each answer means. |
| `threshold` | 0 to 1. Flagged when the probability of "true" is at least this. |
| `applies_to` | Optional globs (`*`, `**`, `?`). Judged only if a changed file matches. Omit for always. |
| `satisfied_by` | Required. Any one entry clears the flag: `pr_body_matches` (regex, `(?i)` prefix for case-insensitive, max 200 chars) or `file_added` (glob on a file the PR adds; modifying an existing file does not count, and a file renamed in from outside the glob does). |
| `why`, `fix` | The remedy shown to the author: why it matters, and what to do. |
| `probes` | Optional. Short questions shown to the author as "Questions a reviewer will ask". On a declarative judgement: a list of questions. On `use: one-way-door`: a mapping with `type1` and/or `type2`, each a list of questions. At most 7 questions per list, each at most 300 characters. Static text; no model call. |

The built-in `one-way-door` ships default probes for type 1 and type 2 verdicts, and an `ambiguous` verdict shows the type 1 list. A Type 1 change cleared by an ADR (`type1_adr`) shows the type 1 list too, in the comment for a PR routed to a human, where the questions are for the human reviewer. Setting `probes.type1` or `probes.type2` replaces only that list. A declarative judgement with no `probes` shows none.

Severity is a different kind of entry, with `classify:` instead of `question`/`true`/`false`; see [Severity](#severity).

**A non-empty list replaces the default.** If you list only your own judgement, `one-way-door` stops running org-wide. Add `- use: one-way-door` to keep it.

## Severity

Severity labels each PR with a level your org defines, such as P0 to P3. `one-way-door` measures reversibility (can we undo this?); severity measures impact (how bad is it if this is wrong?). They are independent: a reversible change to checkout can be P0, an irreversible change to an internal admin table can be P3.

It is a **classifier**, not a yes/no judgement. It sends one `choice` question to Jev in the same request as the other judgements and records the answer. It **never fails the check**, never flags, and never needs clearing: a judgement the author can never satisfy would be a gate that cannot be passed. The gate ships no built-in severity rubric, because a generic P0 to P3 would be invented. What P0 means is yours to write.

```yaml
judgements:
  - use: one-way-door
  - id: severity
    name: Severity
    classify:
      question: "If this change is wrong, how bad is the impact?"
      levels:                          # ordered, most severe first
        - id: P0
          means: "customer-facing outage, data loss, or security exposure"
        - id: P1
          means: "major feature broken for many users, no workaround"
        - id: P2
          means: "degraded or partial; a workaround exists"
        - id: P3
          means: "internal or cosmetic; no customer impact"
    applies_to: ["services/**"]        # optional; omit to classify every PR
```

| Key | Meaning |
|---|---|
| `id`, `name` | Unique id (kebab-case, not `one-way-door`) and the name shown in the summary. |
| `classify.question` | The question for Jev. |
| `classify.levels` | A list of at least 2 levels, most severe first. Each has `id` and `means` and nothing else. |
| `levels[].id` | 1 to 32 letters, digits, `.`, `_` or `-`; not digits only (`P1` or `Sev1`, not `1`). Unique, ignoring case. Free-form: nothing assumes a `P` prefix. |
| `levels[].means` | What the level means, written as a rubric the model can apply. |
| `applies_to` | Optional globs, as for any judgement. |

The levels are a list so their order is explicit. `threshold`, `satisfied_by`, `why`, `fix` and `probes` do not apply to a classifier (it never fails, so there is nothing to teach) and are rejected as unknown keys.

**Where it shows up.**

- The check summary has a line per judgement: `- pass: Severity (P1)`, or `- pass: Severity (no level reported)`. With severity as the only judgement the check title is `Severity: P1`.
- The remediation comment gets a `**Severity:** P1 (confidence 0.82)` line, **only when a comment is already posted for a failing judgement**. Severity alone never causes a comment (a comment for a PR routed to a human, described under Review routing, shows it too).
- The hidden agent block gets an additive `classification` field ([docs/agents.md](agents.md#classification)).
- Analytics: an `evaluation` row for the id with outcome `passed`, the reason `<id>_classified` or `<id>_unreported`, the confidence in `double4`, and the level in `blob8` ([calibration.md](calibration.md)).

**Confidence.** The level is reported with the model's confidence. A low confidence does not escalate or change anything in this version, and the confidence is not a calibrated probability. Look at the distribution in analytics before relying on it.

**When the model gives no usable answer.** If Jev's answer for severity is missing, malformed, or names something that is not one of your levels, the gate reports `no level reported` (reason `<id>_unreported`). The other judgements are not affected and the audit is not degraded. A real Jev outage still degrades the audit as it always did.

**Routing.** Severity does not feed review routing and nothing acts on the level yet. A classifier never "fires", so a `judgement: severity` entry in `routing.human_when` with no `reason` could never match and is a routing config error (see below). `judgement: severity` with `reason: severity_unreported` is allowed and means "send to a human when severity could not be determined". `reason: severity_classified` is accepted but matches every time severity ran, so it adds nothing.

## Review routing

Routing is the gate's recommendation of who should review a PR: a `human` or an `agent`. It is computed from the answers the gate already has, so it costs no extra Jev call. It is configured in an optional `routing:` key in the same file, read from the same default branch.

```yaml
routing:
  include_defaults: true           # optional, default true
  label: needs-human-review        # optional, default shown
  human_when:                      # optional; any matching entry routes to a human
    - judgement: public-api-contract
    - judgement: one-way-door
      reason: ambiguous
    - files: ["migrations/**", "infra/**"]
```

| Key | Meaning |
|---|---|
| `include_defaults` | Boolean, default `true`. Keep the built-in rules below in addition to yours. Set `false` to use only your own `human_when` entries. |
| `label` | The PR label added for a `human` result. Non-empty, at most 50 characters. Default `needs-human-review`. |
| `human_when` | A list. Entries are OR'd: any match routes to a human. Each entry has exactly one of the forms below. |

Where the result shows: the check summary always has a `Review routing:` line. A remediation comment (posted only when a judgement fails) also has a `**Review routing:**` line under the heading, naming the rules that matched in code spans; in shadow routing mode it says no label is added. The hidden agent block carries the same result as `routing`. A PR that passes every judgement but routes to a human gets the label (enforce mode), the summary line **and a short comment** in the same place as the remediation comment (same marker, edited in place, so it replaces a failing comment from an earlier push). The comment has a heading saying the PR passed and is routed to a human reviewer, the `**Review routing:**` line, any severity line, and, for each judgement that fired and was cleared, its `why` and its `probes` as questions for the human reviewer. In shadow routing mode it is still posted and says the human review is recommended and no label is added. When all applicable judgements pass with an `agent` or `unavailable` routing result, an existing gate comment is updated to a short passing note, including current severity and routing information and an empty `failing` list in the hidden block. No new comment is created for that passing note. A degraded audit leaves an existing comment unchanged. A failure to post the comment adds a note to the check summary and never changes the check.

`human_when` entry forms:

- `judgement: <id>`: that judgement ran and **fired**. Fired means it flagged the change, whether or not the author cleared it, so a Type 1 change with an ADR still counts.
- `judgement: <id>` with `reason: <code>`: that judgement ran and returned this reason code, fired or not. This is how to target `ambiguous`. Codes: `type1_adr`, `type1_no_adr`, `ambiguous`, `type2_ok`, `type2_no_plan` for `one-way-door`; `<id>_unsatisfied` and `<id>_ok` for a declarative judgement.
- `files: [<glob>, ...]`: any changed file matches any glob (`*`, `**`, `?`), whatever its status, so a deleted migration counts. This does not depend on the model and works even when no judgement applied.

A classifier such as severity never fires, so `judgement: <id>` without `reason` on one is a config error. Codes for a classifier: `<id>_classified` and `<id>_unreported`.

A judgement that did not run (its `applies_to` matched no changed file) matches nothing. A `judgement:` id must be in the judgements list actually in force, and a `reason:` must be a code that judgement can produce. Otherwise it is a config error, so a typo cannot quietly send PRs to an agent.

**Built-in defaults.** Unless you set `include_defaults: false`, these two entries always apply, with or without a `routing:` block: `judgement: one-way-door` (a Type 1 result) and `judgement: one-way-door` with `reason: ambiguous`. Your entries are added to them. If `one-way-door` is not in your judgements list, the defaults match nothing.

### If the routing config is wrong

A bad `routing:` block (an unknown key, a bad entry, an unknown judgement id or reason code, a bad label) is checked separately from `judgements:`. It never changes your judgements or the check result. Routing becomes `human` with the reason `config error: ...`, the summary says why, and the default label is added in enforce mode, so the owner notices. A YAML or schema error elsewhere in the file has the same routing result, and judgements fall back to the built-in as described below.

When routing cannot be fully decided:

- **The config could not be read** (GitHub 5xx, network, missing Contents permission): judgements fall back to the built-in, the summary reports routing as unavailable, and nothing is labelled. Without your rules there is nothing model-independent to apply, and a short outage should not leave a label on every PR opened in that window.
- **The audit is degraded** (Jev timeout, 5xx, malformed answer): the check stays `neutral`, as always. Judgement-based entries are skipped, but `files:` entries and config errors still route to a human and still label. If none of those apply, the summary says routing is unavailable and nothing is labelled.

If adding the label fails (permissions, API error), the check is unchanged and the summary notes that the label could not be added.

### The label

- It is added in enforce routing mode only. In shadow routing mode the gate does not touch the PR: the summary reads "would have routed to a human" and the result is recorded in analytics.
- It is sticky. The gate adds it and never removes it, so a later push cannot shed the requirement. A person removes it.
- Adding it needs the Issues read & write permission the app already has.
- GitHub creates a missing label with a default colour, so if you want a specific colour, create the label in the repo first.

### Enforcing the review

The gate recommends. Your repo enforces. Two options:

1. **CODEOWNERS, by path.** List the paths that always need a person (for example `migrations/` and `infra/`) in CODEOWNERS and require Code Owner review in branch protection or a ruleset. It does not depend on the model or on this gate.
2. **A small workflow in your repo** that fails until a human has approved whenever the `needs-human-review` label is present, triggered on `pull_request` (`labeled`, `unlabeled`, `synchronize`) and on `pull_request_review`, with that workflow required by a ruleset. As far as we know, rulesets and CODEOWNERS cannot require approval conditionally on a label, hence the workflow. This repo does not ship one.

Before enforcing either, watch the human rate in shadow mode (see [calibration.md](calibration.md#review-routing)).

## If the config is wrong

A missing file, an empty file, or `judgements: []` runs the built-in default. An unknown key (at the top level or inside a judgement, for example a typo like `judgement:` or `applies-to:`) is a config error rather than being ignored. A YAML or schema error, or a config that cannot be read (for example a missing Contents permission), also falls back to the built-in, and the check summary says so. A bad config never blocks a PR.

**Config not picked up?** GitHub answers 404 for a repo the app cannot see, which looks the same as "no config file". If your judgements never run, check that the org's `.github` repo is part of the app installation (not just "selected repositories" without it).

## Cost

At most one extra GitHub request per isolate per 60 seconds. The Worker caches the config in memory within the isolate for 60 seconds (including on `*.workers.dev` domains) and also uses the Cloudflare Cache API as a best-effort second layer on custom domains. A new or changed config can take up to 60 seconds to apply.

## Regex caution

`pr_body_matches` patterns run against PR bodies written by anyone, so two guards apply:

- Only the first 10,000 characters of the PR body are matched. Put the section a pattern looks for near the top of the description. This bounds patterns that are slow in a polynomial way; it does not bound exponential ones, which never finish on 10,000 characters.
- A pattern that repeats a group which itself contains a repeat, such as `(\s*\S+)+$` or `(a|b+)*`, is rejected when the config loads. The gate then falls back to the built-in judgement and says so in the check summary ("Config error: ..."). The test is a heuristic: it rejects some safe patterns (`(\d+\.)+`) and misses overlapping alternation such as `(a|a)*`, which is exponential and is not helped by the 10,000-character cap. The protection against those is the rejection above plus keeping patterns simple, for example `(?i)^Migration Plan:`.

Without the guards, a crafted body could make the regex run past the Worker's CPU limit. The Worker is then killed without being able to finish the check, which stays "in progress" and blocks a required check (see [operations.md](operations.md#when-the-check-cannot-be-completed)).
