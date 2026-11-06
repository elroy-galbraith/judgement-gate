import { readFileSync } from "node:fs";
import { CONFIG_PATH, ConfigError, parseGateConfig } from "../src/config";

const args = process.argv.slice(2);
if (args.length > 1 || args[0]?.startsWith("-")) {
  console.error("Usage: npm run lint-config -- [path/to/judgement-gate.yml]");
  process.exitCode = 1;
} else {
  const path = args[0] ?? CONFIG_PATH;
  try {
    const config = parseGateConfig(readFileSync(path, "utf8"), { confidenceThreshold: 0.75 });
    // The Worker keeps valid judgements when routing is malformed. CI must reject that error too.
    if (config.routing.status === "config_error") throw new ConfigError(config.routing.message);
    console.log(`${path}: valid judgement-gate config`);
  } catch (error) {
    console.error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
