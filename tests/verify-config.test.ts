import { describe, it, expect } from "bun:test";
import { parseInlineVerifies, buildConfig, mergeConfigs } from "../src/verify-config";

describe("parseInlineVerifies", () => {
  it("parses --verify args into VerifyStep array", () => {
    const args = ["--verify", "bun run typecheck", "--verify", "bun run test", "--max-iterations", "10"];
    const verifies = parseInlineVerifies(args);
    expect(verifies).toHaveLength(2);
    expect(verifies[0].command).toBe("bun run typecheck");
    expect(verifies[0].runsOn).toBe("impl");
    expect(verifies[1].command).toBe("bun run test");
    expect(verifies[1].runsOn).toBe("impl");
  });

  it("detects ask_user verifier and sets runsOn to main", () => {
    const args = ["--verify", "ask_user"];
    const verifies = parseInlineVerifies(args);
    expect(verifies).toHaveLength(1);
    expect(verifies[0].command).toBe("ask_user");
    expect(verifies[0].runsOn).toBe("main");
  });

  it("returns empty array when no --verify flags", () => {
    expect(parseInlineVerifies([])).toEqual([]);
  });

  it("handles mixed impl and main verifiers", () => {
    const args = [
      "--verify", "bun run typecheck",
      "--verify", "ask_user",
      "--verify", "bun run test",
    ];
    const verifies = parseInlineVerifies(args);
    expect(verifies).toHaveLength(3);
    expect(verifies[0].runsOn).toBe("impl");
    expect(verifies[1].runsOn).toBe("main");
    expect(verifies[2].runsOn).toBe("impl");
  });
});

describe("buildConfig", () => {
  it("merges default config with overrides", () => {
    const config = buildConfig({
      verifySteps: [{ command: "bun test", runsOn: "impl" }],
      maxIterations: 5,
    });
    expect(config.maxIterations).toBe(5);
    expect(config.maxConsecutiveZeroProgress).toBe(3); // default
    expect(config.verifySteps).toHaveLength(1);
  });

  it("uses all defaults when no overrides given", () => {
    const config = buildConfig({});
    expect(config.maxIterations).toBe(20);
    expect(config.maxConsecutiveZeroProgress).toBe(3);
    expect(config.verifySteps).toEqual([]);
    expect(config.guardrails.gitAutoSnapshot).toBe(true);
  });
});

describe("mergeConfigs", () => {
  const base = buildConfig({
    verifySteps: [{ command: "bun run typecheck", runsOn: "impl" }],
    maxIterations: 20,
  });

  it("CLI overrides override YAML config", () => {
    const merged = mergeConfigs(base, { maxIterations: 5 });
    expect(merged.maxIterations).toBe(5);
    expect(merged.verifySteps).toHaveLength(1); // from base
  });

  it("CLI verify steps replace YAML verify steps entirely", () => {
    const merged = mergeConfigs(base, {
      verifySteps: [{ command: "bun test", runsOn: "impl" }],
    });
    expect(merged.verifySteps).toHaveLength(1);
    expect(merged.verifySteps[0].command).toBe("bun test");
  });

  it("empty CLI overrides preserve base values", () => {
    const merged = mergeConfigs(base, {});
    expect(merged.maxIterations).toBe(20);
    expect(merged.verifySteps[0].command).toBe("bun run typecheck");
  });
});
