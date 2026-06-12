import type { DevLoopConfig, VerifyStep } from "./state";

export function parseInlineVerifies(args: string[]): VerifyStep[] {
  const steps: VerifyStep[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--verify" && i + 1 < args.length) {
      const cmd = args[++i];
      if (cmd === "ask_user") {
        steps.push({ command: "ask_user", runsOn: "main" });
      } else {
        steps.push({ command: cmd, runsOn: "impl" });
      }
    }
  }
  return steps;
}

export function buildConfig(
  overrides: Partial<DevLoopConfig>,
): DevLoopConfig {
  return {
    maxIterations: overrides.maxIterations ?? 20,
    maxConsecutiveZeroProgress: overrides.maxConsecutiveZeroProgress ?? 3,
    verifySteps: overrides.verifySteps ?? [],
    guardrails: overrides.guardrails ?? {
      gitAutoSnapshot: true,
      rollbackOnRegression: true,
      maxFileChangesPerSubagent: 20,
    },
  };
}
