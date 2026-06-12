import { describe, it, expect } from "bun:test";
import type { ErrorRecord } from "../src/state";
import { createState, detectProgress, defaultConfig } from "../src/state";

describe("createState", () => {
  it("creates a goal-mode state with correct defaults", () => {
    const config = defaultConfig();
    const state = createState("goal", "Test module", config);
    expect(state.active).toBe(true);
    expect(state.mode).toBe("goal");
    expect(state.goal).toBe("Test module");
    expect(state.currentStep).toBe(0);
    expect(state.maxSteps).toBe(Infinity);
    expect(state.errorRegistry).toEqual([]);
    expect(state.consecutiveZeroProgress).toBe(0);
  });

  it("creates a passes-mode state with finite maxSteps", () => {
    const config = defaultConfig();
    const state = createState("passes", "Refactor", config, 5);
    expect(state.mode).toBe("passes");
    expect(state.maxSteps).toBe(5);
  });

  it("creates a pipeline-mode state", () => {
    const config = defaultConfig();
    const state = createState("pipeline", "Stage pipeline", config);
    expect(state.mode).toBe("pipeline");
    expect(state.maxSteps).toBe(0);
    expect(state.active).toBe(true);
  });
});

describe("detectProgress", () => {
  const makeRecord = (id: string, status: ErrorRecord["status"]): ErrorRecord => ({
    id, status, category: "type", file: "a.ts", message: "err",
    firstSeenAt: 0, lastSeenAt: 0,
  });

  it("returns regression when any error is regressed", () => {
    const old = [makeRecord("e1", "persistent")];
    const anew = [makeRecord("e1", "regressed")];
    expect(detectProgress(old, anew, 0, defaultConfig())).toBe("regression");
  });

  it("returns progress when error count decreases", () => {
    const old = [makeRecord("e1", "persistent"), makeRecord("e2", "persistent")];
    const anew = [makeRecord("e1", "persistent")];
    expect(detectProgress(old, anew, 0, defaultConfig())).toBe("progress");
  });

  it("returns progress when error count same but errors changed", () => {
    const old = [makeRecord("e1", "persistent"), makeRecord("e2", "persistent")];
    const anew = [makeRecord("e1", "persistent"), makeRecord("e3", "new")];
    expect(detectProgress(old, anew, 0, defaultConfig())).toBe("progress");
  });

  it("returns progress when all errors are fixed", () => {
    const old = [makeRecord("e1", "persistent")];
    const anew: ErrorRecord[] = [];
    expect(detectProgress(old, anew, 0, defaultConfig())).toBe("progress");
  });

  it("returns zero-progress when same errors remain", () => {
    const old = [makeRecord("e1", "persistent")];
    const anew = [makeRecord("e1", "persistent")];
    expect(detectProgress(old, anew, 0, defaultConfig())).toBe("zero-progress");
  });
});
