import { describe, it, expect } from "bun:test";
import { buildIterationPrompt } from "../src/session-prompt";
import type { DevLoopState, ErrorRecord, ReviewFinding } from "../src/state";

function makeState(overrides: Partial<DevLoopState> = {}): DevLoopState {
  return {
    active: true,
    mode: "goal",
    goal: "Implement user registration",
    currentStep: 2,
    maxSteps: Infinity,
    errorRegistry: [],
    reviewFindings: [],
    consecutiveZeroProgress: 0,
    stages: [],
    currentStage: 0,
    config: {
      maxIterations: 20,
      maxConsecutiveZeroProgress: 3,
      verifySteps: [],
      guardrails: { gitAutoSnapshot: true, rollbackOnRegression: true, maxFileChangesPerSubagent: 20 },
    },
    done: false,
    reasonDone: "",
    ...overrides,
  };
}

describe("buildIterationPrompt", () => {
  it("includes goal and iteration number", () => {
    const prompt = buildIterationPrompt(makeState());
    expect(prompt).toContain("Iteration 3");
    expect(prompt).toContain("Implement user registration");
  });

  it("shows total iterations for passes mode", () => {
    const state = makeState({ mode: "passes", maxSteps: 5 });
    const prompt = buildIterationPrompt(state);
    expect(prompt).toContain("Iteration 3/5");
  });

  it("displays error registry with status badges", () => {
    const errors: ErrorRecord[] = [{
      id: "e1", status: "new", category: "type", file: "a.ts", line: 10,
      message: "Type error here", firstSeenAt: 2, lastSeenAt: 2,
    }];
    const prompt = buildIterationPrompt(makeState({ errorRegistry: errors }));
    expect(prompt).toContain("\uD83D\uDD35");
    expect(prompt).toContain("a.ts:10");
    expect(prompt).toContain("Type error here");
  });

  it("shows 'No outstanding errors' when registry is empty", () => {
    const prompt = buildIterationPrompt(makeState());
    expect(prompt).toContain("No outstanding errors");
  });

  it("lists open review findings", () => {
    const findings: ReviewFinding[] = [{
      id: "f1", severity: "important", file: "src/user.ts",
      message: "Missing input validation", status: "open",
    }];
    const prompt = buildIterationPrompt(makeState({ reviewFindings: findings }));
    expect(prompt).toContain("Missing input validation");
    expect(prompt).toContain("src/user.ts");
  });

  it("includes the action instruction section", () => {
    const prompt = buildIterationPrompt(makeState());
    expect(prompt).toContain("Your job");
    expect(prompt).toContain("subagent()");
    expect(prompt).toContain("loop_control");
    expect(prompt).toContain("implSubagents");
  });
});
