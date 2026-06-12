import yaml from "js-yaml";
import { readFileSync, existsSync } from "node:fs";
import type { DevLoopConfig, VerifyStep, GuardrailsConfig } from "./state";
import { defaultConfig } from "./state";

interface RawConfig {
  loop?: {
    maxIterations?: number;
    maxConsecutiveZeroProgress?: number;
  };
  verify?: Array<{
    command: string;
    runsOn?: string;
    timeout?: number;
    parser?: string;
    question?: string;
  }>;
  guardrails?: {
    gitAutoSnapshot?: boolean;
    rollbackOnRegression?: boolean;
    maxFileChangesPerSubagent?: number;
  };
}

export function parseConfigContent(yamlContent: string): DevLoopConfig | null {
  const trimmed = yamlContent.trim();
  if (!trimmed) return null;

  let raw: RawConfig;
  try {
    raw = yaml.load(trimmed) as RawConfig;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const defaults = defaultConfig();

  const verifySteps: VerifyStep[] = (raw.verify ?? []).map(v => ({
    command: v.command,
    runsOn: (() => {
      const normalized = v.runsOn?.trim().toLowerCase();
      if (normalized === "main") return "main" as const;
      return "impl" as const;
    })(),
    timeout: v.timeout,
    parser: v.parser,
    question: v.question,
  }));

  const g = raw.guardrails;
  const guardrails: GuardrailsConfig = {
    gitAutoSnapshot: g?.gitAutoSnapshot ?? defaults.guardrails.gitAutoSnapshot,
    rollbackOnRegression: g?.rollbackOnRegression ?? defaults.guardrails.rollbackOnRegression,
    maxFileChangesPerSubagent: g?.maxFileChangesPerSubagent ?? defaults.guardrails.maxFileChangesPerSubagent,
  };

  return {
    maxIterations: raw.loop?.maxIterations ?? defaults.maxIterations,
    maxConsecutiveZeroProgress: raw.loop?.maxConsecutiveZeroProgress ?? defaults.maxConsecutiveZeroProgress,
    verifySteps,
    guardrails,
  };
}

export function loadConfigFromFile(filePath?: string): DevLoopConfig | null {
  const path = filePath ?? findConfigInCwd();
  if (!path || !existsSync(path)) return null;
  const content = readFileSync(path, "utf-8");
  return parseConfigContent(content);
}

export function findConfigInCwd(): string | null {
  const candidates = [".pidev.yml", ".pidev.yaml", "pidev.yml", "pidev.yaml"];
  for (const name of candidates) {
    if (existsSync(name)) return name;
  }
  return null;
}
