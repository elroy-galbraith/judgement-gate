import type { Judgement } from "../types";
import { oneWayDoor, type OneWayDoorProbes } from "./one-way-door";

export interface BuiltinOverrides {
  confidence_threshold?: number;
  applies_to?: string[];
  ignore?: string[];
  probes?: OneWayDoorProbes;
}

export interface BuiltinDefaults {
  confidenceThreshold: number;
}

export const BUILTIN_IDS = ["one-way-door"] as const;

export function builtinById(id: string, overrides: BuiltinOverrides, defaults: BuiltinDefaults): Judgement | undefined {
  switch (id) {
    case "one-way-door":
      return oneWayDoor({
        confidenceThreshold: overrides.confidence_threshold ?? defaults.confidenceThreshold,
        appliesTo: overrides.applies_to,
        ignore: overrides.ignore,
        probes: overrides.probes,
      });
    default:
      return undefined;
  }
}
