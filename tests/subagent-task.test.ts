import { describe, it, expect } from "bun:test";
import { packImplTask, packReviewTask, expandCommand } from "../src/subagent-task";
import type { ErrorRecord, DevLoopConfig } from "../src/state";

const makeConfig = (): DevLoopConfig => ({
  maxIterations: 20,
  maxConsecutiveZeroProgress: 3,
  verifySteps: [
    { command: "bun run typecheck", runsOn: "impl" },
    { command: "bun run test", runsOn: "impl" },
  ],
  guardrails: {
    gitAutoSnapshot: true,
    rollbackOnRegression: true,
    maxFileChangesPerSubagent: 20,
  },
});

describe("packImplTask", () => {
  it("includes error details and verify commands", () => {
    const error: ErrorRecord = {
      id: "abc123", category: "type", file: "src/user.ts",
      line: 42, message: "Type 'X' not assignable to 'Y'",
      status: "new", firstSeenAt: 1, lastSeenAt: 1,
    };
    const task = packImplTask(error, makeConfig());
    expect(task).toContain("src/user.ts:42");
    expect(task).toContain("Type 'X' not assignable to 'Y'");
    expect(task).toContain("bun run typecheck");
    expect(task).toContain("MUST pass");
  });

  it("includes extra context when provided", () => {
    const error: ErrorRecord = {
      id: "e1", category: "lint", file: "src/a.ts",
      line: 5, message: "Unused variable",
      status: "new", firstSeenAt: 1, lastSeenAt: 1,
    };
    const task = packImplTask(error, makeConfig(), "Relevant interface: User { name: string }");
    expect(task).toContain("Relevant interface");
    expect(task).toContain("User { name: string }");
  });

  it("handles errors without line numbers", () => {
    const error: ErrorRecord = {
      id: "e1", category: "test", file: "src/a.test.ts",
      message: "Test failed: expected true, got false",
      status: "new", firstSeenAt: 1, lastSeenAt: 1,
    };
    const task = packImplTask(error, makeConfig());
    expect(task).toContain("src/a.test.ts");
    expect(task).not.toContain(":undefined");
  });

  it("returns a non-empty string", () => {
    const error: ErrorRecord = {
      id: "e1", category: "compile", file: "src/main.ts",
      line: 1, message: "Build error",
      status: "new", firstSeenAt: 1, lastSeenAt: 1,
    };
    const task = packImplTask(error, makeConfig());
    expect(task.length).toBeGreaterThan(50);
  });
});

describe("packReviewTask", () => {
  it("handles empty changed files list", () => {
    const task = packReviewTask([]);
    expect(task).toContain("No files changed to review");
  });

  it("only includes file list, no error context", () => {
    const files = ["src/user.ts", "src/user.test.ts"];
    const task = packReviewTask(files);
    expect(task).toContain("src/user.ts");
    expect(task).toContain("src/user.test.ts");
    expect(task).not.toContain("MUST pass");
    expect(task).not.toContain("Error");
  });

  it("handles single file", () => {
    const task = packReviewTask(["src/main.ts"]);
    expect(task).toContain("src/main.ts");
  });

  it("mentions review focus areas", () => {
    const task = packReviewTask(["src/a.ts"]);
    expect(task).toContain("Edge cases");
    expect(task).toContain("error handling");
    expect(task).toContain("severity");
  });

  it("includes structured output instructions with findings", () => {
    const task = packReviewTask(["src/main.ts"]);
    expect(task).toContain("findings");
    expect(task).toContain("severity");
    expect(task).toContain("```json");
  });
});

describe("expandCommand", () => {
  it("replaces {files} with space-joined file list", () => {
    const result = expandCommand("bun test -- --related={files}", ["src/a.ts", "src/b.ts"]);
    expect(result).toBe("bun test -- --related=src/a.ts src/b.ts");
  });

  it("handles single file", () => {
    const result = expandCommand("echo {files}", ["src/main.ts"]);
    expect(result).toBe("echo src/main.ts");
  });

  it("returns command unchanged when no {files} placeholder", () => {
    const result = expandCommand("bun run typecheck", ["src/a.ts"]);
    expect(result).toBe("bun run typecheck");
  });

  it("handles empty file list", () => {
    const result = expandCommand("echo {files}", []);
    expect(result).toBe("echo ");
  });

  it("handles multiple {files} placeholders", () => {
    const result = expandCommand("echo {files} && echo {files}", ["a.ts"]);
    expect(result).toBe("echo a.ts && echo a.ts");
  });
});

describe("packImplTask structured output", () => {
  it("includes structured output instructions at the end", () => {
    const error: ErrorRecord = {
      id: "abc123", category: "type", file: "src/user.ts",
      line: 42, message: "Type error",
      status: "new", firstSeenAt: 1, lastSeenAt: 1,
    };
    const task = packImplTask(error, makeConfig());
    expect(task).toContain("Structured Output Format");
    expect(task).toContain("errorsFixed");
    expect(task).toContain("errorsRemaining");
    expect(task).toContain("```json");
  });

  it("includes parser extraction instructions when config has parser", () => {
    const config: DevLoopConfig = {
      ...makeConfig(),
      verifySteps: [
        { command: "bun run typecheck", runsOn: "impl", parser: "tsc" },
      ],
    };
    const error: ErrorRecord = {
      id: "e1", category: "type", file: "src/main.ts",
      line: 1, message: "err", status: "new" as const, firstSeenAt: 1, lastSeenAt: 1,
    };
    const task = packImplTask(error, config);
    expect(task).toContain("Error Extraction");
    expect(task).toContain("tsc");
    expect(task).toContain("errorsRemaining");
  });

  it("expands {files} placeholder in verify commands when changedFiles provided", () => {
    const config: DevLoopConfig = {
      ...makeConfig(),
      verifySteps: [
        { command: "bun test -- --related={files}", runsOn: "impl" },
      ],
    };
    const error: ErrorRecord = {
      id: "e1", category: "type", file: "src/user.ts",
      line: 1, message: "err",
      status: "new", firstSeenAt: 1, lastSeenAt: 1,
    };
    const task = packImplTask(error, config, undefined, ["src/user.ts"]);
    expect(task).toContain("bun test -- --related=src/user.ts");
    expect(task).not.toContain("{files}");
  });
});
