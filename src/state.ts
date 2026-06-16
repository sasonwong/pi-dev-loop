export interface ErrorRecord {
  id: string;
  category: "type" | "lint" | "test" | "compile" | "runtime" | "review";
  file: string;
  line?: number;
  message: string;
  status: "new" | "fixed" | "regressed" | "persistent";
  firstSeenAt: number;
  lastSeenAt: number;
  fixedAt?: number;
  regressedAt?: number[];
}

export interface ReviewFinding {
  id: string;
  severity: "critical" | "important" | "minor";
  file: string;
  message: string;
  suggestion?: string;
  status: "open" | "addressed";
}

export interface VerifyStep {
  command: string;
  runsOn: "impl" | "main";
  timeout?: number;
  parser?: string | ParserConfig;
  question?: string;
}

export interface GuardrailsConfig {
  gitAutoSnapshot: boolean;
  rollbackOnRegression: boolean;
  maxFileChangesPerSubagent: number;
}

export interface DevLoopConfig {
  maxIterations: number;
  maxConsecutiveZeroProgress: number;
  verifySteps: VerifyStep[];
  guardrails: GuardrailsConfig;
}

export interface DevLoopState {
  active: boolean;
  mode: "goal" | "passes" | "pipeline";
  goal: string;
  currentStep: number;
  maxSteps: number;
  errorRegistry: ErrorRecord[];
  reviewFindings: ReviewFinding[];
  consecutiveZeroProgress: number;
  pauseReason?: "regression" | "zero-progress" | "max-iterations";
  stages: string[];
  currentStage: number;
  config: DevLoopConfig;
  lastCleanSnapshot?: string;
  latestSnapshot?: string;
  done: boolean;
  reasonDone: string;
}

export type BuiltinParserName = "tsc" | "eslint" | "vitest";

export interface CustomParserConfig {
  pattern: string;
  category: ErrorRecord["category"];
  fileGroup?: string;
  lineGroup?: string;
  messageGroup?: string;
}

export type ParserConfig = BuiltinParserName | CustomParserConfig;

export function createState(
  mode: DevLoopState["mode"],
  goal: string,
  config: DevLoopConfig,
  maxSteps?: number,
): DevLoopState {
  const steps: Record<string, number> = {
    goal: Infinity,
    passes: maxSteps ?? 1,
    pipeline: 0,
  };
  return {
    active: true,
    mode,
    goal,
    currentStep: 0,
    maxSteps: steps[mode],
    errorRegistry: [],
    reviewFindings: [],
    consecutiveZeroProgress: 0,
    stages: [],
    currentStage: 0,
    config,
    done: false,
    reasonDone: "",
  };
}

export function detectProgress(
  oldErrors: ErrorRecord[],
  newErrors: ErrorRecord[],
  _consecutiveZeroProgress: number,
  _config: DevLoopConfig,
): "progress" | "zero-progress" | "regression" {
  void _consecutiveZeroProgress; // reserved: used by callers to detect stalled loops
  void _config;                   // reserved: maxConsecutiveZeroProgress for auto-pause
  const oldOpen = oldErrors.filter(e => e.status !== "fixed").length;
  const newOpen = newErrors.filter(e => e.status !== "fixed").length;
  const hasRegression = newErrors.some(e => e.status === "regressed");

  if (hasRegression) return "regression";
  if (newOpen < oldOpen) return "progress";

  const oldIds = new Set(oldErrors.filter(e => e.status !== "fixed").map(e => e.id));
  const newIds = new Set(newErrors.filter(e => e.status !== "fixed").map(e => e.id));
  const hasDifferent =
    [...oldIds].some(id => !newIds.has(id)) ||
    [...newIds].some(id => !oldIds.has(id));
  if (newOpen === oldOpen && hasDifferent) return "progress";

  return "zero-progress";
}

export const DEFAULT_MAX_ITERATIONS = 20;
export const DEFAULT_MAX_CONSECUTIVE_ZERO_PROGRESS = 3;
export const DEFAULT_GUARDRAILS: GuardrailsConfig = {
  gitAutoSnapshot: true,
  rollbackOnRegression: true,
  maxFileChangesPerSubagent: 20,
};

export function defaultConfig(): DevLoopConfig {
  return {
    maxIterations: DEFAULT_MAX_ITERATIONS,
    maxConsecutiveZeroProgress: DEFAULT_MAX_CONSECUTIVE_ZERO_PROGRESS,
    verifySteps: [],
    guardrails: { ...DEFAULT_GUARDRAILS },
  };
}
