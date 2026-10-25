# For AI coding agents

Every remediation comment ends with a hidden block that tells an agent exactly how to clear each failing judgement, so it does not have to parse the prose. The human-readable Why/Fix text is unchanged.

```
<!-- judgement-gate:v1 {"schema":1,"mode":"enforce","failing":[ ... ]} -->
```

One line, an HTML comment (invisible when rendered). Find it with `/<!-- judgement-gate:v(\d+) (\{.*\}) -->/` on the comment that contains `<!-- judgement-gate -->`, then `JSON.parse` group 2. `<` and `>` inside the JSON are escaped as `\u003c`/`\u003e`, so JSON parsing round-trips and nothing can close the comment early. U+2028 and U+2029 are escaped too (`\u2028`/`\u2029`), so the block stays on one line for the regex above. The block carries ids, reason codes, numbers, templates and authored probe questions only: never PR text, diffs or secrets.

| Field | Meaning |
|---|---|
| `schema` | Integer, equals the `v` in the marker. Unknown higher versions: fall back to the prose. |
| `mode` | `shadow` (check always passes, but fix it anyway) or `enforce`. |
| `failing[].id`, `.name` | Judgement id and display name. |
| `failing[].reason` | Reason code, e.g. `type1_no_adr`, `type2_no_plan`, `ambiguous`, `<id>_unsatisfied`. |
| `failing[].probability`, `.threshold` | Model probability and flag threshold, or `null`. |
| `failing[].satisfied_by` | Ways to clear it; **any one** is enough (see below). |
| `failing[].suggested_template` | `{target: "pr_body"\|"file", path?, content}` to paste, or `null`. |
| `failing[].probes` | Questions the author should answer in the ADR or PR description; authored text, never PR content; may be empty. |
| `classification` | Levels reported by classifier judgements such as `severity`. Optional: absent when none reported a level. See [Classification](#classification). |
| `routing` | Who the gate recommends reviews this PR. Optional: absent from older comments. See below. |
| `routing.route` | `human`, `agent` or `unavailable` (routing could not be decided). |
| `routing.reasons` | Array of short strings, for example `one-way-door flagged`, `one-way-door: ambiguous`, `files: migrations/**`. Built from config ids, globs, reason codes and config-error text, and never contains PR content. Empty for `agent`. |
| `routing.label` | The label the gate adds to a PR routed to a human, default `needs-human-review`. |

`satisfied_by` entries, by `type`:

- `pr_body_matches`: `regex` (and optional `flags`). The PR body must match it.
- `pr_body_fields`: `fields` that must appear as `Name:` lines in the PR body; `template` shows the format.
- `file_added`: add a new file matching `glob` (`example_path` is a concrete choice). Editing an existing file does not satisfy it; a file renamed in from outside the glob does.

Built-in `one-way-door`: `type1_no_adr` → `file_added` `docs/decisions/*.md`; `type2_no_plan` → `pr_body_fields` `Reversal Trigger` and `Rollback Path` (plus `Owner`); `ambiguous` → either of the two.

## Routing

`routing` is added to every comment the gate posts. That is the remediation comment (at least one judgement failed) and the routing comment for a PR that passed every judgement but is routed to a human. A PR routed to an agent with nothing failing gets no new comment. An existing gate comment is updated to a passing note, with `failing: []` and the current routing in its block; the routing is also in the check summary. The schema number stays at 1 because the field is additive.

In the routing comment `failing` is `[]` (nothing to fix), `routing.route` is `human`, and `classification` is present as usual. `failing` being empty with `routing.route` `human` is how you tell it apart from a remediation comment. The visible text names the cleared judgements and lists questions for the human reviewer; the block does not repeat them. It replaces any earlier failing comment on the same PR, so after a push that fixes everything you may see this block where the failing one was. Nothing for you to fix then: a person reviews.

`routing.route` is a recommendation and does not change the check. It reports the result whether or not the label is applied: in shadow routing mode the gate does not label, but the block still shows what it would have done.

If `route` is `human`, clearing a failure does not remove the need for a human. Fixing the judgement turns the check green; a person still reviews the PR. Leave the label alone: the gate never removes it, and only a person should. Say in the PR description what the human should look at.

## Classification

`classification` is added when a judgement that labels the PR (for example `severity`) reported a level. Like `routing`, it appears in any comment the gate posts, including an existing comment updated to a passing note. A PR with nothing failing that routes to an agent gets no new comment. Schema stays at 1: the field is additive and absent when no classifier reported a level.

```json
"classification": [{ "id": "severity", "level": "P1", "confidence": 0.82 }]
```

| Field | Meaning |
|---|---|
| `classification[].id` | The classifier's judgement id. |
| `classification[].level` | One of the level ids the org configured, such as `P1`. Never free text from the model or the PR. |
| `classification[].confidence` | The model's confidence, or `null`. Not a calibrated probability. |

It is information only. A classifier never appears in `failing`, has nothing to satisfy, and does not change what you must do. If you want to know what the level means, ask a human or read the org's `.github/judgement-gate.yml`. A classifier that could not decide is simply absent from the array.

## How an agent should react

1. Read the gate's comment on your PR and parse the block. If `failing` is empty, nothing is left to fix. When `routing.route` is `human`, a person will review the PR; put what that person should look at in the PR description.
2. For each failing judgement, pick one `satisfied_by` entry. If `suggested_template` fits, fill in the `<placeholders>` with real content (do not leave them in) and either update the PR body or commit the file at `path`. If `probes` is not empty, address each question in the ADR or plan you write, with real content that is true of the change.
3. Push or edit; the gate re-runs and edits the same comment in place.
4. If the judgement is wrong for this change, do not game it. Ask a human to reply `/judgement-gate false-positive <id>`.
5. Never satisfy a regex with content that is not true of the change.
