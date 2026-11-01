import YAML from "yaml";
import { compileClassifier, type ClassifierLevel, type ClassifierSpec } from "./judgements/classifier";
import { compileDeclarative, type DeclarativeSpec, type SatisfiedBy } from "./judgements/declarative";
import type { OneWayDoorProbes } from "./judgements/one-way-door";
import { BUILTIN_IDS, builtinById, type BuiltinDefaults } from "./judgements/registry";
import type { GitHubClient } from "./github";
import { DEFAULT_LABEL, DEFAULT_RULES, type RoutingRule, type RoutingSetup } from "./routing";
import type { Env, Judgement, JudgementMode } from "./types";

export class ConfigError extends Error {}

const MAX_REGEX = 200;
const MAX_PROBES = 7;
const MAX_PROBE_LENGTH = 300;
const USE_KEYS = new Set(["use", "confidence_threshold", "applies_to", "ignore", "probes", "repos", "mode"]);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function str(o: Obj, key: string, where: string): string {
  const v = o[key];
  if (typeof v !== "string" || v.trim() === "") throw new ConfigError(`${where}: "${key}" must be a non-empty string`);
  return v;
}

function globs(v: unknown, where: string, key = "applies_to"): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length === 0 || v.some((g) => typeof g !== "string" || g.trim() === "")) {
    throw new ConfigError(`${where}: "${key}" must be a non-empty list of glob strings (omit it to always apply)`);
  }
  return v as string[];
}

function judgementMode(v: unknown, where: string): JudgementMode | undefined {
  if (v === undefined) return undefined;
  if (v !== "shadow" && v !== "enforce") throw new ConfigError(`${where}: "mode" must be "shadow" or "enforce"`);
  return v;
}

/** `ignore` may be empty: on `use: one-way-door` that opts out of the default safe set. */
function ignoreGlobs(v: unknown, where: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((g) => typeof g !== "string" || g === "")) {
    throw new ConfigError(`${where}: "ignore" must be a list of glob strings`);
  }
  return v as string[];
}

function probeList(v: unknown, where: string, label: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_PROBES) {
    const omit = label.startsWith("probes.") ? "keep the built-in questions" : "ask none";
    throw new ConfigError(`${where}: "${label}" must be a list of 1 to ${MAX_PROBES} questions (omit it to ${omit})`);
  }
  return v.map((p) => {
    if (typeof p !== "string" || p.trim() === "") throw new ConfigError(`${where}: each "${label}" entry must be a non-empty string`);
    const t = p.trim();
    if (t.length > MAX_PROBE_LENGTH) throw new ConfigError(`${where}: each "${label}" entry must be at most ${MAX_PROBE_LENGTH} characters`);
    if (t.includes("<!--") || t.includes("-->")) throw new ConfigError(`${where}: each "${label}" entry must not contain an HTML comment marker`);
    if (/[\r\n]/.test(t)) throw new ConfigError(`${where}: each "${label}" entry must be a single line`);
    return t;
  });
}

function builtinProbes(v: unknown, where: string): OneWayDoorProbes | undefined {
  if (v === undefined) return undefined;
  if (!isObj(v) || Object.keys(v).length === 0) throw new ConfigError(`${where}: "probes" must be a mapping with "type1" and/or "type2"`);
  const bad = Object.keys(v).filter((k) => k !== "type1" && k !== "type2");
  if (bad.length > 0) throw new ConfigError(`${where}: "probes" has unknown key ${bad.map((k) => `"${k}"`).join(", ")} (expected "type1" or "type2")`);
  return { type1: probeList(v.type1, where, "probes.type1"), type2: probeList(v.type2, where, "probes.type2") };
}

/**
 * Heuristic for catastrophic backtracking: a group that already contains a repeat (`*`, `+`, `{n,}`, `{n,m}`) and is
 * itself repeated, such as `(\s*\S+)+` or `((a+)b)*`. It does not catch every slow pattern (overlapping alternation
 * like `(a|a)*` passes, and it can still take exponential time). The body cap only bounds polynomial patterns.
 */
export function hasNestedQuantifier(pattern: string): boolean {
  const repeat = (at: number) => /^(?:[*+]|\{\d+,\d*\})/.test(pattern.slice(at));
  const stack: boolean[] = []; // per open group: does it contain a repeat?
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") i++;
    else if (c === "[") {
      for (i++; i < pattern.length && pattern[i] !== "]"; i++) if (pattern[i] === "\\") i++;
    } else if (c === "(") stack.push(false);
    else if (c === ")") {
      const inner = stack.pop() ?? false;
      if (inner && repeat(i + 1)) return true;
      if (stack.length > 0 && (inner || repeat(i + 1))) stack[stack.length - 1] = true;
    } else if (repeat(i) && stack.length > 0) stack[stack.length - 1] = true;
  }
  return false;
}

function bodyRegex(pattern: unknown, where: string): RegExp {
  if (typeof pattern !== "string" || pattern === "") throw new ConfigError(`${where}: pr_body_matches must be a non-empty string`);
  if (pattern.length > MAX_REGEX) throw new ConfigError(`${where}: pr_body_matches is longer than ${MAX_REGEX} characters`);
  if (hasNestedQuantifier(pattern)) {
    throw new ConfigError(`${where}: pr_body_matches repeats a group that itself contains a repeat, which can take exponential time on a crafted PR body (simplify the pattern)`);
  }
  const ci = pattern.startsWith("(?i)");
  try {
    return new RegExp(ci ? pattern.slice(4) : pattern, ci ? "mi" : "m");
  } catch (e) {
    throw new ConfigError(`${where}: pr_body_matches is not a valid regex (${(e as Error).message})`);
  }
}

/** An `answers` question goes to the model verbatim, so it gets the same limits as a probe. */
function evidenceQuestion(v: unknown, where: string): string {
  if (typeof v !== "string" || v.trim() === "") throw new ConfigError(`${where}: answers must be a non-empty string`);
  const t = v.trim();
  if (t.length > MAX_PROBE_LENGTH) throw new ConfigError(`${where}: answers must be at most ${MAX_PROBE_LENGTH} characters`);
  if (t.includes("<!--") || t.includes("-->")) throw new ConfigError(`${where}: answers must not contain an HTML comment marker`);
  if (/[\r\n]/.test(t)) throw new ConfigError(`${where}: answers must be a single line`);
  return t;
}

function satisfiedBy(v: unknown, where: string): SatisfiedBy[] {
  if (!Array.isArray(v) || v.length === 0) throw new ConfigError(`${where}: "satisfied_by" must be a non-empty list`);
  return v.map((entry) => {
    if (isObj(entry) && Object.keys(entry).length === 1) {
      if ("pr_body_matches" in entry) return { pr_body_matches: bodyRegex(entry.pr_body_matches, where) };
      if ("file_added" in entry && typeof entry.file_added === "string" && entry.file_added !== "") return { file_added: entry.file_added };
      if ("answers" in entry) return { answers: evidenceQuestion(entry.answers, where) };
    }
    throw new ConfigError(`${where}: each satisfied_by entry must be exactly one of pr_body_matches, file_added or answers`);
  });
}

const DECLARATIVE_KEYS = new Set(["id", "name", "question", "true", "false", "threshold", "applies_to", "ignore", "satisfied_by", "why", "fix", "probes", "repos", "mode"]);
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function declarative(o: Obj, where: string): DeclarativeSpec {
  const unknown = Object.keys(o).filter((k) => !DECLARATIVE_KEYS.has(k));
  if (unknown.length > 0) throw new ConfigError(`${where}: unknown key ${unknown.map((k) => `"${k}"`).join(", ")}`);
  const id = str(o, "id", where);
  if (!KEBAB.test(id)) throw new ConfigError(`${where}: "id" must be kebab-case (lowercase letters, digits, hyphens)`);
  const threshold = o.threshold;
  if (typeof threshold !== "number" || !(threshold >= 0 && threshold <= 1)) {
    throw new ConfigError(`${where}: "threshold" must be a number between 0 and 1`);
  }
  return {
    id,
    name: str(o, "name", where),
    question: str(o, "question", where),
    whenTrue: str(o, "true", where),
    whenFalse: str(o, "false", where),
    threshold,
    appliesTo: globs(o.applies_to, where),
    ignore: ignoreGlobs(o.ignore, where),
    satisfiedBy: satisfiedBy(o.satisfied_by, where),
    why: str(o, "why", where),
    fix: str(o, "fix", where),
    probes: probeList(o.probes, where, "probes"),
  };
}

const CLASSIFIER_KEYS = new Set(["id", "name", "classify", "applies_to", "ignore", "repos", "mode"]);
const CLASSIFY_KEYS = new Set(["question", "levels"]);
const LEVEL_KEYS = new Set(["id", "means"]);
const LEVEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_LEVEL_ID = 32;
const MIN_LEVELS = 2;

function unknownKeys(o: Obj, allowed: Set<string>, where: string): void {
  const unknown = Object.keys(o).filter((k) => !allowed.has(k));
  if (unknown.length > 0) throw new ConfigError(`${where}: unknown key ${unknown.map((k) => `"${k}"`).join(", ")}`);
}

function classifierLevels(v: unknown, where: string): ClassifierLevel[] {
  if (!Array.isArray(v) || v.length < MIN_LEVELS) {
    throw new ConfigError(`${where}: "levels" must be a list of at least ${MIN_LEVELS} levels, most severe first`);
  }
  const seen = new Set<string>();
  return v.map((entry, i) => {
    const at = `${where}: levels[${i}]`;
    if (!isObj(entry)) throw new ConfigError(`${at} must be a mapping with "id" and "means"`);
    unknownKeys(entry, LEVEL_KEYS, at);
    const id = entry.id;
    if (typeof id !== "string" || id.length === 0 || id.length > MAX_LEVEL_ID || !LEVEL_ID.test(id)) {
      throw new ConfigError(`${at}: "id" must be a string of 1-${MAX_LEVEL_ID} letters, digits, ".", "_" or "-", such as "P1" or "Sev1"`);
    }
    // The levels go to Jev as an object, and JS orders digit-only keys numerically, which would silently reorder them.
    if (/^[0-9]+$/.test(id)) throw new ConfigError(`${at}: "id" must not be only digits (use "P${id}" or "Sev${id}")`);
    if (seen.has(id.toLowerCase())) throw new ConfigError(`${at}: duplicate level id "${id}" (ids are compared ignoring case)`);
    seen.add(id.toLowerCase());
    return { id, means: str(entry, "means", at) };
  });
}

/** A `classify:` entry: one choice question and the org's ordered levels. Informs only, so it has no threshold or remedy. */
function classifier(o: Obj, where: string): ClassifierSpec {
  unknownKeys(o, CLASSIFIER_KEYS, where);
  const id = str(o, "id", where);
  if (!KEBAB.test(id)) throw new ConfigError(`${where}: "id" must be kebab-case (lowercase letters, digits, hyphens)`);
  if (!isObj(o.classify)) throw new ConfigError(`${where}: "classify" must be a mapping with "question" and "levels"`);
  unknownKeys(o.classify, CLASSIFY_KEYS, `${where}: classify`);
  return {
    id,
    name: str(o, "name", where),
    question: str(o.classify, "question", `${where}: classify`),
    levels: classifierLevels(o.classify.levels, `${where}: classify`),
    appliesTo: globs(o.applies_to, where),
    ignore: ignoreGlobs(o.ignore, where),
  };
}

const ROUTING_KEYS = ["include_defaults", "label", "human_when"];
const MAX_LABEL = 50;

function routingRule(entry: unknown, i: number, judgements: Judgement[]): RoutingRule {
  const where = `routing.human_when[${i}]`;
  const keys = isObj(entry) ? Object.keys(entry) : [];
  const isFiles = keys.length === 1 && keys[0] === "files";
  const isJudgement = keys.includes("judgement") && keys.every((k) => k === "judgement" || k === "reason");
  if (!isObj(entry) || !(isFiles || isJudgement)) {
    throw new ConfigError(`${where}: each entry must be exactly one of {judgement}, {judgement, reason} or {files}`);
  }
  if (isFiles) {
    const g = entry.files;
    if (!Array.isArray(g) || g.length === 0 || g.some((x) => typeof x !== "string" || x === "")) {
      throw new ConfigError(`${where}: "files" must be a non-empty list of glob strings`);
    }
    return { files: g as string[] };
  }
  const id = entry.judgement;
  const judgement = judgements.find((j) => j.id === id);
  if (typeof id !== "string" || !judgement) {
    throw new ConfigError(`${where}: unknown judgement ${JSON.stringify(id)} (known: ${judgements.map((j) => j.id).join(", ")})`);
  }
  if (!("reason" in entry)) {
    if (judgement.kind === "classifier") {
      throw new ConfigError(
        `${where}: "${id}" is a classifier and never fires, so this entry could never match (use reason: ${judgement.reasons[judgement.reasons.length - 1]}, or a files rule)`,
      );
    }
    return { judgement: id };
  }
  const reason = entry.reason;
  if (typeof reason !== "string" || !judgement.reasons.includes(reason)) {
    throw new ConfigError(`${where}: unknown reason ${JSON.stringify(reason)} for "${id}" (known: ${judgement.reasons.join(", ")})`);
  }
  return { judgement: id, reason };
}

/** The owner's label from a raw `routing:` block if it is usable, else the default; used when the block is otherwise invalid. */
function labelOrDefault(raw: unknown): string {
  if (!isObj(raw) || typeof raw.label !== "string") return DEFAULT_LABEL;
  const label = raw.label.trim();
  return label !== "" && label.length <= MAX_LABEL ? label : DEFAULT_LABEL;
}

/**
 * Validate the `routing:` block against the judgements actually in force. Absent or empty means the defaults.
 * Anything malformed throws ConfigError.
 */
export function parseRouting(raw: unknown, judgements: Judgement[]): { rules: RoutingRule[]; label: string } {
  if (raw === undefined || raw === null) return { rules: [...DEFAULT_RULES], label: DEFAULT_LABEL };
  if (!isObj(raw)) throw new ConfigError('"routing" must be a mapping');
  const unknown = Object.keys(raw).filter((k) => !ROUTING_KEYS.includes(k));
  if (unknown.length > 0) {
    throw new ConfigError(`routing: unknown key ${unknown.map((k) => `"${k}"`).join(", ")} (expected ${ROUTING_KEYS.join(", ")})`);
  }

  const includeDefaults = raw.include_defaults ?? true;
  if (typeof includeDefaults !== "boolean") throw new ConfigError('routing: "include_defaults" must be a boolean');

  let label = DEFAULT_LABEL;
  if (raw.label !== undefined) {
    if (typeof raw.label !== "string" || raw.label.trim() === "") throw new ConfigError('routing: "label" must be a non-empty string');
    label = raw.label.trim();
    if (label.length > MAX_LABEL) throw new ConfigError(`routing: "label" must be at most ${MAX_LABEL} characters`);
  }

  const humanWhen = raw.human_when ?? [];
  if (!Array.isArray(humanWhen)) throw new ConfigError('routing: "human_when" must be a list');
  const own = humanWhen.map((entry, i) => routingRule(entry, i, judgements));
  return { rules: [...(includeDefaults ? DEFAULT_RULES : []), ...own], label };
}

/**
 * Parse the org's config YAML into judgements and routing. Empty, missing or empty-list judgements yield the
 * default built-in list. A malformed judgements section throws ConfigError so the caller can fall back and say so;
 * a malformed routing block never throws, it comes back as a `config_error` setup next to the valid judgements.
 */
export function parseGateConfig(text: string, defaults: BuiltinDefaults): { judgements: Judgement[]; routing: RoutingSetup } {
  let doc: unknown;
  try {
    doc = YAML.parse(text);
  } catch (e) {
    throw new ConfigError(`YAML syntax error: ${(e as Error).message.split("\n")[0]}`);
  }
  const fallback = () => [builtinById("one-way-door", {}, defaults)!];
  const withRouting = (judgements: Judgement[], rawRouting: unknown): { judgements: Judgement[]; routing: RoutingSetup } => {
    try {
      return { judgements, routing: { status: "ok", ...parseRouting(rawRouting, judgements) } };
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      return { judgements, routing: { status: "config_error", message: e.message, label: labelOrDefault(rawRouting) } };
    }
  };
  if (doc === null || doc === undefined) return withRouting(fallback(), undefined);
  if (!isObj(doc)) throw new ConfigError("config root must be a mapping");
  const unknownRoot = Object.keys(doc).filter((k) => k !== "judgements" && k !== "routing");
  if (unknownRoot.length > 0) {
    throw new ConfigError(`unknown top-level key ${unknownRoot.map((k) => `"${k}"`).join(", ")} (expected "judgements" or "routing")`);
  }
  if (doc.judgements === undefined || doc.judgements === null) return withRouting(fallback(), doc.routing);
  if (!Array.isArray(doc.judgements)) throw new ConfigError('"judgements" must be a list');
  if (doc.judgements.length === 0) return withRouting(fallback(), doc.routing);

  const seen = new Set<string>();
  const out: Judgement[] = [];
  doc.judgements.forEach((entry, i) => {
    if (!isObj(entry)) throw new ConfigError(`judgements[${i}] must be a mapping`);
    let j: Judgement;
    if ("use" in entry) {
      const where = `judgements[${i}] (use: ${String(entry.use)})`;
      const bad = Object.keys(entry).filter((k) => !USE_KEYS.has(k));
      if (bad.length > 0) throw new ConfigError(`${where}: cannot override ${bad.join(", ")}`);
      const ct = entry.confidence_threshold;
      if (ct !== undefined && (typeof ct !== "number" || !(ct >= 0 && ct <= 1))) {
        throw new ConfigError(`${where}: "confidence_threshold" must be a number between 0 and 1`);
      }
      const built = builtinById(
        String(entry.use),
        { confidence_threshold: ct as number | undefined, applies_to: globs(entry.applies_to, where), ignore: ignoreGlobs(entry.ignore, where), probes: builtinProbes(entry.probes, where) },
        defaults,
      );
      if (!built) throw new ConfigError(`${where}: unknown built-in (known: ${BUILTIN_IDS.join(", ")})`);
      j = built;
    } else if ("classify" in entry) {
      const where = `judgements[${i}] (${typeof entry.id === "string" ? entry.id : "no id"})`;
      const spec = classifier(entry, where);
      if ((BUILTIN_IDS as readonly string[]).includes(spec.id)) throw new ConfigError(`${where}: id collides with a built-in`);
      j = compileClassifier(spec);
    } else {
      const where = `judgements[${i}] (${typeof entry.id === "string" ? entry.id : "no id"})`;
      const spec = declarative(entry, where);
      if ((BUILTIN_IDS as readonly string[]).includes(spec.id)) throw new ConfigError(`${where}: id collides with a built-in`);
      j = compileDeclarative(spec);
    }
    // Shared metadata belongs to every entry kind, including built-ins and classifiers.
    j.repos = globs(entry.repos, `judgements[${i}]`, "repos");
    j.mode = judgementMode(entry.mode, `judgements[${i}]`);
    if (seen.has(j.id)) throw new ConfigError(`duplicate judgement id "${j.id}"`);
    seen.add(j.id);
    out.push(j);
  });
  return withRouting(out, doc.routing);
}

/** Parse the org's judgement YAML; see parseGateConfig. A `routing` block is accepted but not returned here. */
export function parseConfig(text: string, defaults: BuiltinDefaults): Judgement[] {
  return parseGateConfig(text, defaults).judgements;
}

export const CONFIG_PATH = ".github/judgement-gate.yml";
const CACHE_SECONDS = 60;
const CACHE_TTL_MS = CACHE_SECONDS * 1000;

interface CachedConfig {
  text: string | null;
  expiresAt: number;
}

const configCache = new Map<string, CachedConfig>();

export function clearConfigCache(): void {
  configCache.clear();
}

async function readConfigText(gh: GitHubClient, owner: string, repo: string, now = Date.now()): Promise<string | null> {
  const cacheKey = `${owner}/${repo}`;
  const memo = configCache.get(cacheKey);
  if (memo && memo.expiresAt > now) {
    return memo.text;
  }

  const cache = typeof caches !== "undefined" ? ((caches as unknown as { default?: Cache }).default ?? null) : null;
  const key = new Request(`https://judgement-gate.invalid/config/${owner}/${repo}`);
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) {
        const cachedText = (await hit.text()) || null;
        configCache.set(cacheKey, { text: cachedText, expiresAt: now + CACHE_TTL_MS });
        return cachedText;
      }
    } catch {
      // cache is best-effort
    }
  }
  const text = await gh.getFileContents(owner, repo, CONFIG_PATH);
  configCache.set(cacheKey, { text, expiresAt: now + CACHE_TTL_MS });
  if (cache) {
    try {
      await cache.put(key, new Response(text ?? "", { headers: { "Cache-Control": `max-age=${CACHE_SECONDS}` } }));
    } catch {
      // cache is best-effort
    }
  }
  return text;
}

/**
 * Load the org's judgements and routing from the default branch of <owner>/<CONFIG_REPO>. Never throws: a missing
 * file means the default built-ins and default routing; an unreadable or invalid file means the built-ins plus a
 * note, with routing `unavailable` (unreadable) or `config_error` (invalid). A routing-only error keeps the
 * owner's judgements and adds no note.
 */
export async function loadGateConfig(
  gh: GitHubClient,
  owner: string,
  env: Env,
  now = Date.now(),
): Promise<{ judgements: Judgement[]; routing: RoutingSetup; note?: string }> {
  const defaults = { confidenceThreshold: Number(env.CONFIDENCE_THRESHOLD ?? 0.75) };
  const repo = env.CONFIG_REPO ?? ".github";
  const fallback = () => parseConfig("", defaults);
  let text: string | null;
  try {
    text = await readConfigText(gh, owner, repo, now);
  } catch (e) {
    return {
      judgements: fallback(),
      routing: { status: "unavailable", message: "config could not be read", label: DEFAULT_LABEL },
      note: `Could not read judgement config (${(e as Error).message}); fell back to built-in judgements.`,
    };
  }
  if (text === null) return parseGateConfig("", defaults);
  try {
    return parseGateConfig(text, defaults);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    // A bad judgements section or root key leaves the YAML readable, so keep the owner's routing label if it has one.
    let rawRouting: unknown;
    try {
      const doc = YAML.parse(text);
      rawRouting = isObj(doc) ? doc.routing : undefined;
    } catch {
      // unparseable YAML: nothing can be read, so the default label stays
    }
    return {
      judgements: fallback(),
      routing: { status: "config_error", message: e.message, label: labelOrDefault(rawRouting) },
      note: `Config error: ${e.message}; fell back to built-in judgements.`,
    };
  }
}

