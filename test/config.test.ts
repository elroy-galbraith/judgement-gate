import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache, ConfigError, loadGateConfig, parseConfig, parseGateConfig } from "../src/config";
import exampleYaml from "../examples/judgement-gate.yml?raw";
import { DEFAULT_PROBES } from "../src/judgements/one-way-door";
import type { GitHubClient } from "../src/github";
import { DEFAULT_LABEL, DEFAULT_RULES } from "../src/routing";
import type { Env, JevAnswers, JudgementVerdict, PrContext } from "../src/types";

const defaults = { confidenceThreshold: 0.75 };
const verdict = (reason: string): JudgementVerdict => ({ conclusion: "failure", reason, summary: "s", fired: true });

const SPEC_EXAMPLE = `
judgements:
  - use: one-way-door
    confidence_threshold: 0.5

  - id: public-api-contract
    name: Public API contract change
    question: "Does this change break or remove a public API contract?"
    true: "removes/renames endpoints, fields or exported symbols"
    false: "additive or internal only"
    threshold: 0.6
    applies_to: ["services/api/**"]
    satisfied_by:
      - pr_body_matches: "(?i)^Migration Plan:"
      - file_added: "docs/api-changes/*.md"
    why: "Consumers cannot roll back with us. Breaking changes need a plan."
    fix: "Add a 'Migration Plan:' line to the PR description."
`;

const pr = (body = "", files: PrContext["files"] = []): PrContext => ({
  title: "t",
  body,
  baseBranch: "main",
  headSha: "abc",
  files,
  patchExtract: "",
});
const q = (noul: number): JevAnswers => ({ q: { noul } });

function api() {
  const list = parseConfig(SPEC_EXAMPLE, defaults);
  return list.find((j) => j.id === "public-api-contract")!;
}

describe("parseConfig: valid", () => {
  it("builds built-in and declarative judgements from the spec example", () => {
    const list = parseConfig(SPEC_EXAMPLE, defaults);
    expect(list.map((j) => j.id)).toEqual(["one-way-door", "public-api-contract"]);
    expect(api().name).toBe("Public API contract change");
    expect(api().appliesTo).toEqual(["services/api/**"]);
  });

  it("applies confidence_threshold override to the built-in", () => {
    const owd = parseConfig(SPEC_EXAMPLE, defaults)[0];
    const a: JevAnswers = {
      is_one_way_boundary_mutation: { noul: 0.02 },
      is_additive_or_isolated: { noul: 0.9 },
      has_concrete_reversal_plan: { noul: 0.9 },
      synthetic_classification: { choice: "TYPE_2_TWO_WAY_DOOR", confidence: 0.6 },
    };
    expect(owd.decide(a, pr()).reason).toBe("type2_ok"); // 0.6 >= overridden 0.5
  });

  it("applies applies_to override to the built-in", () => {
    const owd = parseConfig("judgements:\n  - use: one-way-door\n    applies_to: ['db/**']", defaults)[0];
    expect(owd.appliesTo).toEqual(["db/**"]);
  });

  it.each(["", "# comment only", "judgements: []"])("falls back to default built-in for %j", (text) => {
    const list = parseConfig(text, defaults);
    expect(list.map((j) => j.id)).toEqual(["one-way-door"]);
  });
});

describe("declarative decide", () => {
  it("flagged and unsatisfied fails", () => {
    const v = api().decide(q(0.7), pr("nope"));
    expect(v.conclusion).toBe("failure");
    expect(v.reason).toBe("public-api-contract_unsatisfied");
    expect(v.summary).toBe("Public API contract change: not satisfied");
  });
  it("flagged and satisfied by body passes, case-insensitively", () => {
    expect(api().decide(q(0.7), pr("Migration Plan: x")).reason).toBe("public-api-contract_ok");
    expect(api().decide(q(0.7), pr("migration plan: x")).conclusion).toBe("success");
  });
  it("body pattern matches at the start of any line", () => {
    expect(api().decide(q(0.7), pr("Intro\n\nMigration Plan: x")).conclusion).toBe("success");
  });
  it("below threshold passes, exactly at threshold is flagged", () => {
    expect(api().decide(q(0.59), pr("nope")).conclusion).toBe("success");
    expect(api().decide(q(0.6), pr("nope")).conclusion).toBe("failure");
  });
  it("file_added is satisfied by added files but not removed ones", () => {
    const added = [{ filename: "docs/api-changes/a.md", status: "added" }];
    const removed = [{ filename: "docs/api-changes/a.md", status: "removed" }];
    expect(api().decide(q(0.9), pr("nope", added)).conclusion).toBe("success");
    expect(api().decide(q(0.9), pr("nope", removed)).conclusion).toBe("failure");
  });
  it("file_added is not satisfied by a modified file (issue #24)", () => {
    const modified = [{ filename: "docs/api-changes/a.md", status: "modified" }];
    expect(api().decide(q(0.9), pr("nope", modified)).conclusion).toBe("failure");
  });
  it("file_added is satisfied by a file renamed into the glob, not within it", () => {
    const into = [{ filename: "docs/api-changes/a.md", status: "renamed", previous_filename: "notes/a.md" }];
    const within = [{ filename: "docs/api-changes/a.md", status: "renamed", previous_filename: "docs/api-changes/b.md" }];
    expect(api().decide(q(0.9), pr("nope", into)).conclusion).toBe("success");
    expect(api().decide(q(0.9), pr("nope", within)).conclusion).toBe("failure");
  });
  it("file_added is satisfied by a copied file", () => {
    const copied = [{ filename: "docs/api-changes/a.md", status: "copied" }];
    expect(api().decide(q(0.9), pr("nope", copied)).conclusion).toBe("success");
  });
  it("remedy returns the YAML why and fix", () => {
    const j = api();
    const r = j.remedy(j.decide(q(0.9), pr("nope")), { owner: "o", repo: "r", headRef: "abc" });
    expect(r.why).toBe("Consumers cannot roll back with us. Breaking changes need a plan.");
    expect(r.fix).toBe("Add a 'Migration Plan:' line to the PR description.");
  });
  it("signals show probability and threshold", () => {
    expect(api().decide(q(0.7), pr("nope")).signals).toContain("70%");
    expect(api().decide(q(0.7), pr("nope")).signals).toContain("60%");
  });
  it("asks one noul question with true/false criteria", () => {
    const question = api().questions.q;
    expect(question.type).toBe("noul");
    expect(question.criteria.true).toContain("removes/renames");
    expect(question.criteria.false).toBe("additive or internal only");
  });
});

const useProbes = (probes: string) => `judgements:\n  - use: one-way-door\n    ${probes}`;

const decl = (extra: Record<string, unknown> = {}, drop: string[] = []) => {
  const base: Record<string, unknown> = {
    id: "x",
    name: "X",
    question: "Q?",
    true: "t",
    false: "f",
    threshold: 0.5,
    satisfied_by: [{ pr_body_matches: "ok" }],
    why: "w",
    fix: "f",
    ...extra,
  };
  for (const k of drop) delete base[k];
  return JSON.stringify({ judgements: [base] });
};

describe("parseConfig: invalid throws ConfigError", () => {
  const cases: [string, string][] = [
    ["yaml syntax error", "judgements: ["],
    ["judgements not a list", "judgements: {}"],
    ["unknown use", "judgements:\n  - use: nope"],
    ["disallowed override on use", "judgements:\n  - use: one-way-door\n    threshold: 0.5"],
    ["duplicate ids", JSON.stringify({ judgements: [JSON.parse(decl()).judgements[0], JSON.parse(decl()).judgements[0]] })],
    ["threshold above 1", decl({ threshold: 1.5 })],
    ["threshold below 0", decl({ threshold: -0.1 })],
    ["missing satisfied_by", decl({}, ["satisfied_by"])],
    ["empty satisfied_by", decl({ satisfied_by: [] })],
    ["unknown satisfied_by type", decl({ satisfied_by: [{ bogus: 1 }] })],
    ["regex does not compile", decl({ satisfied_by: [{ pr_body_matches: "(" }] })],
    ["regex too long", decl({ satisfied_by: [{ pr_body_matches: "a".repeat(201) }] })],
    ["missing question", decl({}, ["question"])],
    ["missing why", decl({}, ["why"])],
    ["non-string fix", decl({ fix: 5 })],
    ["id collides with built-in", decl({ id: "one-way-door" })],
    ["probes as a bare string", decl({ probes: "nope" })],
    ["empty probes", decl({ probes: [] })],
    ["too many probes", decl({ probes: Array.from({ length: 8 }, (_, i) => `Q${i}?`) })],
    ["empty probe", decl({ probes: ["ok?", ""] })],
    ["blank probe", decl({ probes: ["ok?", "   "] })],
    ["overlong probe", decl({ probes: ["a".repeat(301)] })],
    ["non-string probe", decl({ probes: [5] })],
    ["use with probes as a list", useProbes("probes: [x]")],
    ["use with unknown probes key", useProbes(`probes:\n      ambiguous: [x]`)],
    ["use with empty probes list", useProbes(`probes:\n      type1: []`)],
    ["use with empty probes mapping", useProbes("probes: {}")],
    ["use with null type1", useProbes(`probes:\n      type1: null`)],
    ["declarative with null probes", decl({ probes: null })],
  ];
  it.each(cases)("%s", (_name, text) => {
    expect(() => parseConfig(text, defaults)).toThrow(ConfigError);
  });

  it("names the offending judgement in the message", () => {
    expect(() => parseConfig(decl({ threshold: 2 }), defaults)).toThrow(/x.*threshold/);
  });

  it("names the offending judgement and key for bad probes", () => {
    expect(() => parseConfig(decl({ probes: "nope" }), defaults)).toThrow(/x.*probes/);
  });

  it.each([
    ["an HTML comment opener", "see <!-- here"],
    ["an HTML comment closer", "ends --> here"],
    ["a newline", "line one\nline two"],
    ["a carriage return", "line one\rline two"],
  ])("rejects a probe containing %s", (_name, probe) => {
    expect(() => parseConfig(decl({ probes: [probe] }), defaults)).toThrow(/probes/);
    expect(() => parseConfig(JSON.stringify({ judgements: [{ use: "one-way-door", probes: { type1: [probe] } }] }), defaults)).toThrow(/probes/);
  });

  it("hints differ: built-in labels keep the defaults when omitted, declarative asks none", () => {
    expect(() => parseConfig(useProbes(`probes:\n      type1: []`), defaults)).toThrow(/omit it to keep the built-in questions/);
    expect(() => parseConfig(decl({ probes: [] }), defaults)).toThrow(/omit it to ask none/);
  });
});

describe("probes", () => {
  it("declarative probes are returned verbatim, trimmed", () => {
    const [j] = parseConfig(decl({ probes: ["Who else calls this?", "  How would we know?  "] }), defaults);
    expect(j.probes!(verdict("x_unsatisfied"))).toEqual(["Who else calls this?", "How would we know?"]);
  });
  it("declarative without probes gives an empty list", () => {
    const [j] = parseConfig(decl(), defaults);
    expect(j.probes!(verdict("x_unsatisfied"))).toEqual([]);
  });
  it("use: one-way-door overrides one list and keeps the default for the other", () => {
    const [j] = parseConfig(useProbes(`probes:\n      type1: ["Custom type 1?"]`), defaults);
    expect(j.probes!(verdict("type1_no_adr"))).toEqual(["Custom type 1?"]);
    expect(j.probes!(verdict("ambiguous"))).toEqual(["Custom type 1?"]);
    expect(j.probes!(verdict("type2_no_plan"))).toEqual(DEFAULT_PROBES.type2);
  });
  it("use: one-way-door type2 override keeps the default type1", () => {
    const [j] = parseConfig(useProbes(`probes:\n      type2: ["Custom type 2?"]`), defaults);
    expect(j.probes!(verdict("type2_no_plan"))).toEqual(["Custom type 2?"]);
    expect(j.probes!(verdict("type1_no_adr"))).toEqual(DEFAULT_PROBES.type1);
  });
  it("returned arrays are copies: mutating one does not change the next call", () => {
    const [d] = parseConfig(decl({ probes: ["Q one?"] }), defaults);
    d.probes!(verdict("x_unsatisfied")).push("injected");
    expect(d.probes!(verdict("x_unsatisfied"))).toEqual(["Q one?"]);
    const [o] = parseConfig(useProbes(`probes:\n      type1: ["T1?"]`), defaults);
    o.probes!(verdict("type1_no_adr")).push("injected");
    expect(o.probes!(verdict("type1_no_adr"))).toEqual(["T1?"]);
    const w = parseConfig(useProbes("probes:\n      type2: [\"T2?\"]"), defaults)[0];
    w.probes!(verdict("type1_no_adr")).push("injected");
    expect(DEFAULT_PROBES.type1).not.toContain("injected");
    expect(w.probes!(verdict("type1_no_adr"))).toEqual(DEFAULT_PROBES.type1);
  });
});

describe("shipped example", () => {
  it("examples/judgement-gate.yml parses", () => {
    const list = parseConfig(exampleYaml, defaults);
    expect(list.map((j) => j.id)).toEqual(["one-way-door", "public-api-contract", "severity"]);
    expect(list.find((j) => j.id === "severity")!.kind).toBe("classifier");
  });
  it("public-api-contract ships with probes", () => {
    const api = parseConfig(exampleYaml, defaults).find((j) => j.id === "public-api-contract")!;
    expect(api.probes!(verdict("public-api-contract_unsatisfied")).length).toBeGreaterThanOrEqual(2);
  });

  it("examples/judgement-gate.yml has a routing block that parses to ok", () => {
    const { routing } = parseGateConfig(exampleYaml, defaults);
    expect(routing.status).toBe("ok");
    if (routing.status !== "ok") return;
    expect(routing.label).toBe("needs-human-review");
    expect(routing.rules).toEqual([
      ...DEFAULT_RULES,
      { judgement: "public-api-contract" },
      { judgement: "one-way-door", reason: "ambiguous" },
      { files: ["migrations/**", "infra/**"] },
    ]);
  });
});

describe("review fixes", () => {
  it("`judgements:` with no value is the default, not an error", () => {
    expect(parseConfig("judgements:\n", defaults).map((j) => j.id)).toEqual(["one-way-door"]);
    expect(parseConfig("judgements:\n  # - use: one-way-door\n", defaults).map((j) => j.id)).toEqual(["one-way-door"]);
  });
  it("rejects unknown keys on a declarative judgement (a typo must not silently widen scope)", () => {
    expect(() => parseConfig(decl({ "applies-to": ["services/**"] }), defaults)).toThrow(/applies-to/);
  });
  it("rejects an empty applies_to list", () => {
    expect(() => parseConfig(decl({ applies_to: [] }), defaults)).toThrow(ConfigError);
  });
  it("requires a kebab-case id", () => {
    expect(() => parseConfig(decl({ id: "Bad Id" }), defaults)).toThrow(/id/);
    expect(() => parseConfig(decl({ id: "good-id-2" }), defaults)).not.toThrow();
  });
});

describe("unknown root keys", () => {
  it.each(["other: 1", "judgement:\n  - use: one-way-door", "Judgements:\n  - use: one-way-door"])(
    "%j is a ConfigError (a typo must not silently drop custom judgements)",
    (text) => {
      expect(() => parseConfig(text, defaults)).toThrow(/unknown (top-level )?key/);
    },
  );
});

describe("routing block", () => {
  const spec = (routing: string) => `${SPEC_EXAMPLE}\nrouting:\n${routing}\n`;
  const VALID_IDS = ["one-way-door", "public-api-contract"];

  it("parseConfig accepts the routing top-level key", () => {
    expect(() => parseConfig(SPEC_EXAMPLE + "\nrouting:\n  label: x\n", defaults)).not.toThrow();
  });

  it.each(["", "# comment only", SPEC_EXAMPLE, SPEC_EXAMPLE + "\nrouting:\n"])("no routing config yields the defaults for %j", (text) => {
    const { routing } = parseGateConfig(text, defaults);
    expect(routing).toEqual({ status: "ok", rules: DEFAULT_RULES, label: DEFAULT_LABEL });
  });

  it("appends human_when entries after the default rules", () => {
    const { routing } = parseGateConfig(spec('  human_when:\n    - files: ["infra/**"]'), defaults);
    expect(routing).toEqual({ status: "ok", rules: [...DEFAULT_RULES, { files: ["infra/**"] }], label: DEFAULT_LABEL });
  });

  it("accepts judgement and judgement+reason entries, including reasons of custom judgements", () => {
    const { routing } = parseGateConfig(
      spec(
        [
          "  human_when:",
          "    - judgement: public-api-contract",
          "    - judgement: public-api-contract",
          "      reason: public-api-contract_unsatisfied",
          "    - judgement: one-way-door",
          "      reason: type1_adr",
        ].join("\n"),
      ),
      defaults,
    );
    expect(routing).toEqual({
      status: "ok",
      rules: [
        ...DEFAULT_RULES,
        { judgement: "public-api-contract" },
        { judgement: "public-api-contract", reason: "public-api-contract_unsatisfied" },
        { judgement: "one-way-door", reason: "type1_adr" },
      ],
      label: DEFAULT_LABEL,
    });
  });

  it("include_defaults: false keeps only the owner's entries", () => {
    const { routing } = parseGateConfig(spec('  include_defaults: false\n  human_when:\n    - files: ["infra/**"]'), defaults);
    expect(routing).toEqual({ status: "ok", rules: [{ files: ["infra/**"] }], label: DEFAULT_LABEL });
  });

  it("include_defaults: false with no entries means no rules", () => {
    const { routing } = parseGateConfig(spec("  include_defaults: false"), defaults);
    expect(routing).toEqual({ status: "ok", rules: [], label: DEFAULT_LABEL });
  });

  it("include_defaults: true is the same as omitting it", () => {
    const { routing } = parseGateConfig(spec("  include_defaults: true"), defaults);
    expect(routing).toEqual({ status: "ok", rules: DEFAULT_RULES, label: DEFAULT_LABEL });
  });

  it("uses a configured label", () => {
    const { routing } = parseGateConfig(spec("  label: ready-for-people"), defaults);
    expect(routing).toMatchObject({ status: "ok", label: "ready-for-people" });
  });

  it("accepts a 50 character label", () => {
    const { routing } = parseGateConfig(spec(`  label: ${"a".repeat(50)}`), defaults);
    expect(routing).toMatchObject({ status: "ok", label: "a".repeat(50) });
  });

  it("validates against the judgements in force (an unconfigured judgement is unknown)", () => {
    const text = "judgements:\n  - use: one-way-door\nrouting:\n  human_when:\n    - judgement: public-api-contract";
    expect(parseGateConfig(text, defaults).routing).toMatchObject({
      status: "config_error",
      message: expect.stringMatching(/unknown judgement "public-api-contract"/),
    });
  });

  const invalid: [string, string, RegExp][] = [
    ["unknown key", "  human-when:\n    - files: ['a/**']", /human-when/],
    ["entry with two keys", "  human_when:\n    - judgement: one-way-door\n      files: ['a/**']", /exactly one/],
    ["entry with an unknown key", "  human_when:\n    - bogus: 1", /exactly one/],
    ["entry that is not a mapping", "  human_when:\n    - nope", /exactly one/],
    ["reason without judgement", "  human_when:\n    - reason: ambiguous", /exactly one/],
    ["unknown judgement", "  human_when:\n    - judgement: nope", /unknown judgement "nope"/],
    ["unknown reason", "  human_when:\n    - judgement: one-way-door\n      reason: ambigous", /unknown reason "ambigous"/],
    ["empty files list", "  human_when:\n    - files: []", /non-empty/],
    ["non-string glob", "  human_when:\n    - files: ['a', 3]", /files/],
    ["empty glob", "  human_when:\n    - files: ['']", /files/],
    ["include_defaults not a boolean", '  include_defaults: "no"', /boolean/],
    ["empty label", '  label: ""', /label/],
    ["blank label", '  label: "   "', /label/],
    ["non-string label", "  label: 5", /label/],
    ["label over 50 characters", `  label: ${"a".repeat(51)}`, /50/],
    ["human_when not a list", "  human_when: files", /list/],
    ["routing not a mapping", "  - a", /mapping/],
  ];
  it.each(invalid)("%s is a routing config_error that keeps the valid judgements", (_name, routing, message) => {
    const out = parseGateConfig(spec(routing), defaults);
    expect(out.routing.status).toBe("config_error");
    expect((out.routing as { message: string }).message).toMatch(message);
    expect(out.routing.label).toBe(DEFAULT_LABEL);
    expect(out.judgements.map((j) => j.id)).toEqual(VALID_IDS);
  });

  it("a routing config_error keeps a valid configured label", () => {
    const text = "routing:\n  label: ready-for-people\n  human_when:\n    - judgement: nope";
    expect(parseGateConfig(text, defaults).routing).toMatchObject({ status: "config_error", label: "ready-for-people" });
  });

  it("a routing config_error with an over-long label uses the default label", () => {
    const text = `routing:\n  label: ${"a".repeat(51)}\n  human_when:\n    - judgement: nope`;
    expect(parseGateConfig(text, defaults).routing).toMatchObject({ status: "config_error", label: DEFAULT_LABEL });
  });

  it("trims the label", () => {
    const { routing } = parseGateConfig(spec('  label: " ready "'), defaults);
    expect(routing).toMatchObject({ status: "ok", label: "ready" });
  });

  it("a scalar routing value is a config_error", () => {
    expect(parseGateConfig(`${SPEC_EXAMPLE}\nrouting: 5\n`, defaults).routing.status).toBe("config_error");
  });

  it("invalid judgements still throw, routing or not", () => {
    expect(() => parseGateConfig("judgements: {}\nrouting:\n  label: x", defaults)).toThrow(ConfigError);
  });

  it("broken YAML throws ConfigError", () => {
    expect(() => parseGateConfig("judgements: [", defaults)).toThrow(ConfigError);
  });
});

describe("loadGateConfig", () => {
  const env = { CONFIDENCE_THRESHOLD: "0.75" } as Env;
  const ghWith = (getFileContents: () => Promise<string | null>) => ({ getFileContents }) as unknown as GitHubClient;

  beforeEach(() => clearConfigCache());

  it("a missing file yields the default routing and no note", async () => {
    const out = await loadGateConfig(ghWith(async () => null), "o", env);
    expect(out.routing).toEqual({ status: "ok", rules: DEFAULT_RULES, label: DEFAULT_LABEL });
    expect(out.judgements.map((j) => j.id)).toEqual(["one-way-door"]);
    expect(out.note).toBeUndefined();
  });

  it("loads judgements and routing from the same file", async () => {
    const out = await loadGateConfig(ghWith(async () => SPEC_EXAMPLE + "\nrouting:\n  label: x\n"), "o", env);
    expect(out.judgements.map((j) => j.id)).toEqual(["one-way-door", "public-api-contract"]);
    expect(out.routing).toMatchObject({ status: "ok", label: "x" });
    expect(out.note).toBeUndefined();
  });

  it("an invalid routing block keeps the owner's judgements and adds no note", async () => {
    const out = await loadGateConfig(ghWith(async () => SPEC_EXAMPLE + "\nrouting:\n  bogus: 1\n"), "o", env);
    expect(out.judgements.map((j) => j.id)).toEqual(["one-way-door", "public-api-contract"]);
    expect(out.routing.status).toBe("config_error");
    expect(out.note).toBeUndefined();
  });

  it("a read failure falls back and marks routing unavailable", async () => {
    const getFileContents = vi.fn().mockRejectedValue(new Error("boom"));
    const out = await loadGateConfig(ghWith(getFileContents), "o", env);
    expect(out.judgements.map((j) => j.id)).toEqual(["one-way-door"]);
    expect(out.note).toContain("fell back");
    expect(out.routing.status).toBe("unavailable");
    expect((out.routing as { message: string }).message).not.toBe("");
    expect(out.routing.label).toBe(DEFAULT_LABEL);
  });

  it("invalid YAML falls back with a note and a routing config_error", async () => {
    const out = await loadGateConfig(ghWith(async () => "judgements: ["), "o", env);
    expect(out.judgements.map((j) => j.id)).toEqual(["one-way-door"]);
    expect(out.note).toContain("fell back");
    expect(out.routing.status).toBe("config_error");
    expect(out.routing.label).toBe(DEFAULT_LABEL);
  });

  it("invalid judgements fall back with a note and a routing config_error", async () => {
    const out = await loadGateConfig(ghWith(async () => "judgements:\n  - use: nope"), "o", env);
    expect(out.judgements.map((j) => j.id)).toEqual(["one-way-door"]);
    expect(out.note).toContain("fell back");
    expect(out.routing.status).toBe("config_error");
  });

  it("invalid judgements keep a valid routing label", async () => {
    const out = await loadGateConfig(ghWith(async () => "judgements:\n  - use: nope\nrouting:\n  label: ready-for-people"), "o", env);
    expect(out.routing).toMatchObject({ status: "config_error", label: "ready-for-people" });
  });
});

describe("pr_body_matches safety (issue #23)", () => {
  const withPattern = (pattern: string) => decl({ satisfied_by: [{ pr_body_matches: pattern }] });

  it.each([
    "(?i)^Migration Plan:(\\s*\\S+)+$",
    "(a+)+$",
    "(a*)*b",
    "((a+)b)*",
    "(?:\\w+\\s?)+$",
    "(x{2,})+",
    "(a|b+)*c",
  ])("rejects nested quantifier %s at load", (pattern) => {
    expect(() => parseConfig(withPattern(pattern), defaults)).toThrow(ConfigError);
    expect(() => parseConfig(withPattern(pattern), defaults)).toThrow(/exponential/);
  });

  it.each([
    "(?i)^Migration Plan:",
    "^Plan: .+$",
    "(?i)^(Reversal Trigger|Rollback Path):\\s*\\S+",
    "(foo)?bar+",
    "(ab){2}c+",
    "([(a+]+)x",
    "\\(a+\\)+",
    "(a?)b",
  ])("accepts %s", (pattern) => {
    expect(() => parseConfig(withPattern(pattern), defaults)).not.toThrow();
  });

  it("a rejected pattern plus a 50,000-character near-matching body never reaches the regex", async () => {
    const pattern = "(?i)^Migration Plan:(\\s*\\S+)+$";
    expect(() => parseConfig(withPattern(pattern), defaults)).toThrow(ConfigError);
    // loadGateConfig falls back to the built-in with a note, so evaluation never compiles the pattern.
    const gh = { getFileContents: async () => withPattern(pattern) } as unknown as GitHubClient;
    clearConfigCache();
    const out = await loadGateConfig(gh, "o", { CONFIDENCE_THRESHOLD: "0.75" } as Env);
    expect(out.judgements.map((j) => j.id)).toEqual(["one-way-door"]);
    expect(out.note).toMatch(/Config error: .*exponential.*fell back to built-in judgements/);
  });

  it("only the first 10,000 characters of the body are matched", () => {
    const j = parseConfig(decl({ threshold: 0.5, satisfied_by: [{ pr_body_matches: "^Plan:" }] }), defaults)[0];
    const flagged = (body: string) => j.decide(q(0.9), pr(body)).conclusion;
    expect(flagged(`Plan: x`)).toBe("success");
    expect(flagged(`${"x".repeat(9_990)}\nPlan: x`)).toBe("success");
    expect(flagged(`${"x".repeat(10_000)}\nPlan: x`)).toBe("failure");
  });

  it("a long body that matches a safe pattern completes quickly", () => {
    const j = parseConfig(decl({ satisfied_by: [{ pr_body_matches: "(?i)^Plan:\\s*\\S+$" }] }), defaults)[0];
    const start = Date.now();
    j.decide(q(0.9), pr(`Plan: ${"a ".repeat(25_000)}!`));
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe("satisfied_by answers (issue #22)", () => {
  const withAnswers = (entry: unknown) => decl({ satisfied_by: [entry] });

  it("parses an answers entry into a judgement with an evidence question", () => {
    const j = parseConfig(withAnswers({ answers: "What is the request impact?" }), defaults)[0];
    expect(Object.keys(j.questions)).toEqual(["q", "evidence0"]);
    expect(j.questions.evidence0.instructions).toContain("What is the request impact?");
  });

  it("trims the question", () => {
    const j = parseConfig(withAnswers({ answers: "  Impact?  " }), defaults)[0];
    expect(j.questions.evidence0.instructions).toContain('"Impact?"');
  });

  it("a placeholder fails and a concrete answer clears, per the model's evidence answer", () => {
    const j = parseConfig(withAnswers({ answers: "What is the request impact?" }), defaults)[0];
    const flagged = (evidence: number) => j.decide({ q: { noul: 0.9 }, evidence0: { noul: evidence } }, pr("Request impact: n/a")).conclusion;
    expect(flagged(0.04)).toBe("failure");
    expect(flagged(0.9)).toBe("success");
  });

  const bad: [string, unknown][] = [
    ["empty", { answers: "" }],
    ["blank", { answers: "   " }],
    ["not a string", { answers: 5 }],
    ["a list", { answers: ["a?", "b?"] }],
    ["too long", { answers: "a".repeat(301) }],
    ["multi-line", { answers: "a?\nb?" }],
    ["an HTML comment marker", { answers: "a? -->" }],
    ["combined with another key", { answers: "a?", pr_body_matches: "x" }],
  ];
  it.each(bad)("rejects answers that is %s", (_name, entry) => {
    expect(() => parseConfig(withAnswers(entry), defaults)).toThrow(ConfigError);
  });

  it("the error names answers among the allowed kinds", () => {
    expect(() => parseConfig(withAnswers({ bogus: 1 }), defaults)).toThrow(/pr_body_matches, file_added or answers/);
  });
});
