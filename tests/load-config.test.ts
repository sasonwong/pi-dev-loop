// tests/load-config.test.ts
import { describe, it, expect } from "bun:test";
import { parseConfigContent } from "../src/load-config";
import type { DevLoopConfig } from "../src/state";

const minimalYaml = `
loop:
  maxIterations: 10
  maxConsecutiveZeroProgress: 5
verify:
  - command: "bun run typecheck"
    runsOn: impl
guardrails:
  gitAutoSnapshot: false
  rollbackOnRegression: false
  maxFileChangesPerSubagent: 10
`;

describe("parseConfigContent", () => {
  it("parses a complete YAML config", () => {
    const config = parseConfigContent(minimalYaml);
    expect(config).not.toBeNull();
    expect(config!.maxIterations).toBe(10);
    expect(config!.maxConsecutiveZeroProgress).toBe(5);
    expect(config!.verifySteps).toHaveLength(1);
    expect(config!.verifySteps[0].command).toBe("bun run typecheck");
    expect(config!.verifySteps[0].runsOn).toBe("impl");
    expect(config!.guardrails.gitAutoSnapshot).toBe(false);
    expect(config!.guardrails.rollbackOnRegression).toBe(false);
    expect(config!.guardrails.maxFileChangesPerSubagent).toBe(10);
  });

  it("applies defaults for missing fields", () => {
    const config = parseConfigContent(`loop:\n  maxIterations: 5\n`);
    expect(config).not.toBeNull();
    expect(config!.maxIterations).toBe(5);
    expect(config!.maxConsecutiveZeroProgress).toBe(3); // default
    expect(config!.verifySteps).toEqual([]);
    expect(config!.guardrails.gitAutoSnapshot).toBe(true); // default
  });

  it("parses ask_user verify step", () => {
    const yaml = `
verify:
  - command: "ask_user"
    runsOn: main
    question: "Is this OK?"
`;
    const config = parseConfigContent(yaml);
    expect(config).not.toBeNull();
    expect(config!.verifySteps[0].command).toBe("ask_user");
    expect(config!.verifySteps[0].runsOn).toBe("main");
  });

  it("parses verify step with timeout and parser", () => {
    const yaml = `
verify:
  - command: "bun test"
    runsOn: impl
    timeout: 120000
    parser: "vitest"
`;
    const config = parseConfigContent(yaml);
    expect(config).not.toBeNull();
    expect(config!.verifySteps[0].timeout).toBe(120000);
    expect(config!.verifySteps[0].parser).toBe("vitest");
  });

  it("returns null for empty content", () => {
    expect(parseConfigContent("")).toBeNull();
  });

  it("returns null for invalid YAML", () => {
    expect(parseConfigContent(": invalid: yaml:")).toBeNull();
  });
});

describe("parseConfigContent with parser configs", () => {
  it("parses builtin parser name", () => {
    const yaml = `
verify:
  - command: "bun run typecheck"
    runsOn: impl
    parser: "tsc"
`;
    const config = parseConfigContent(yaml);
    expect(config).not.toBeNull();
    expect(config!.verifySteps[0].parser).toBe("tsc");
  });

  it("parses custom parser config object", () => {
    const yaml = `
verify:
  - command: "./check.sh"
    runsOn: impl
    parser:
      pattern: "ERROR in (?<file>[^:]+):(?<line>\\\\.)*"
      category: "lint"
`;
    const config = parseConfigContent(yaml);
    expect(config).not.toBeNull();
    const parser = config!.verifySteps[0].parser as any;
    expect(parser).toBeTruthy();
    expect(parser.category).toBe("lint");
  });

  it("parses custom parser with optional group names", () => {
    const yaml = `
verify:
  - command: "./my-linter"
    runsOn: impl
    parser:
      pattern: "FAIL: (?<f>[^:]+):(?<ln>\\\\.)*"
      category: "compile"
      fileGroup: "f"
      lineGroup: "ln"
      messageGroup: "msg"
`;
    const config = parseConfigContent(yaml);
    expect(config).not.toBeNull();
    const parser = config!.verifySteps[0].parser as any;
    expect(parser.fileGroup).toBe("f");
    expect(parser.lineGroup).toBe("ln");
    expect(parser.messageGroup).toBe("msg");
  });
});
