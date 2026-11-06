import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_PATH, ConfigError, parseGateConfig } from "../src/config";

const cli = fileURLToPath(new URL("../scripts/lint-config.ts", import.meta.url));
const loader = createRequire(import.meta.url).resolve("tsx/esm");
const example = readFileSync(new URL("../examples/judgement-gate.yml", import.meta.url), "utf8");
const defaults = { confidenceThreshold: 0.75 };
let cwd: string;

function run(...args: string[]) {
  return spawnSync(process.execPath, ["--import", loader, cli, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
  });
}

// The Worker turns routing errors into a result; other schema errors are thrown.
function workerMessage(text: string): string {
  try {
    const config = parseGateConfig(text, defaults);
    if (config.routing.status === "config_error") return config.routing.message;
  } catch (error) {
    if (error instanceof ConfigError) return error.message;
    throw error;
  }
  throw new Error("Expected the fixture to be invalid");
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "judgement-gate-lint-"));
  mkdirSync(join(cwd, ".github"));
});

afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("config lint CLI", () => {
  it.each([
    ["built-in", "judgements:\n  - use: one-way-door\n"],
    ["custom judgements, classifiers and routing", example],
    ["empty config", ""],
    ["comment-only config", "# use defaults\n"],
    ["empty judgement list", "judgements: []\n"],
  ])("accepts %s using the default config path", (_name, text) => {
    writeFileSync(join(cwd, CONFIG_PATH), text);
    const result = run();
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${CONFIG_PATH}: valid judgement-gate config\n`);
    expect(result.stderr).toBe("");
  });

  it("accepts an explicit absolute path containing spaces", () => {
    const path = join(cwd, "custom config.yml");
    writeFileSync(path, example);
    const result = run(path);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`${path}: valid judgement-gate config`);
  });

  it.each([
    ["malformed YAML", "judgements: ["],
    ["built-in applies-to typo", "judgements:\n  - use: one-way-door\n    applies-to: ['src/**']\n"],
    ["custom applies-to typo", example.replace("applies_to:", "applies-to:")],
    ["unknown built-in", "judgements:\n  - use: does-not-exist\n"],
    ["duplicate judgement IDs", "judgements:\n  - use: one-way-door\n  - use: one-way-door\n"],
    ["unknown top-level key", "judgement: []\n"],
    ["invalid threshold", "judgements:\n  - use: one-way-door\n    confidence_threshold: 2\n"],
    ["unknown routing key", "routing:\n  human-when: []\n"],
    ["unknown routing judgement", "routing:\n  human_when:\n    - judgement: does-not-exist\n"],
    ["invalid routing alongside valid judgements", "judgements:\n  - use: one-way-door\nrouting:\n  label: ''\n"],
  ])("rejects %s with the Worker's exact message", (_name, text) => {
    writeFileSync(join(cwd, CONFIG_PATH), text);
    const result = run();
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`${CONFIG_PATH}: ${workerMessage(text)}\n`);
  });

  it("fails when the config is missing instead of silently using defaults", () => {
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${CONFIG_PATH}: ENOENT:`);
  });

  it("fails when the config path cannot be read as a file", () => {
    const result = run(".github");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(".github: EISDIR:");
  });

  it.each([["one.yml", "two.yml"], ["--unknown"]])("rejects invalid arguments %j", (...args) => {
    const result = run(...args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage: npm run lint-config");
  });
});
