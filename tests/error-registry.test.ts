import { describe, it, expect } from "bun:test";
import { fingerprint, mergeRegistry } from "../src/error-registry";

describe("fingerprint", () => {
  it("generates consistent fingerprints for same error", () => {
    const a = fingerprint("src/a.ts", 42, "Type 'X' not assignable to 'Y'");
    const b = fingerprint("src/a.ts", 42, "Type 'X' not assignable to 'Y'");
    expect(a).toBe(b);
  });

  it("normalizes line numbers in messages", () => {
    const a = fingerprint("src/a.ts", 42, "error at line 10: something");
    const b = fingerprint("src/a.ts", 42, "error at line 20: something");
    expect(a).toBe(b);
  });

  it("differentiates different files", () => {
    const a = fingerprint("src/a.ts", 1, "error");
    const b = fingerprint("src/b.ts", 1, "error");
    expect(a).not.toBe(b);
  });

  it("normalizes colon line references", () => {
    const a = fingerprint("src/a.ts", 5, "src/a.ts:10:1: error: something");
    const b = fingerprint("src/a.ts", 5, "src/a.ts:20:1: error: something");
    expect(a).toBe(b);
  });
});

describe("mergeRegistry", () => {
  it("marks new errors as 'new'", () => {
    const existing: any[] = [];
    const incoming = [{ id: "e1", category: "type" as const, file: "a.ts", message: "err" }];
    const result = mergeRegistry(existing, incoming, 1);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("new");
    expect(result[0].firstSeenAt).toBe(1);
  });

  it("promotes new to persistent when error survives iteration", () => {
    const existing: any[] = [{
      id: "e1", status: "new" as const, category: "type" as const,
      file: "a.ts", message: "err", firstSeenAt: 1, lastSeenAt: 1,
    }];
    const incoming = [{ id: "e1", category: "type" as const, file: "a.ts", message: "err" }];
    const result = mergeRegistry(existing, incoming, 2);
    expect(result[0].status).toBe("persistent");
  });

  it("detects regression when a fixed error reappears", () => {
    const existing: any[] = [{
      id: "e1", status: "fixed" as const, category: "type" as const,
      file: "a.ts", message: "err", firstSeenAt: 1, lastSeenAt: 1, fixedAt: 2,
    }];
    const incoming = [{ id: "e1", category: "type" as const, file: "a.ts", message: "err" }];
    const result = mergeRegistry(existing, incoming, 3);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("regressed");
    expect(result[0].regressedAt).toEqual([3]);
  });

  it("marks open errors as fixed when they disappear", () => {
    const existing: any[] = [{
      id: "e1", status: "persistent" as const, category: "type" as const,
      file: "a.ts", message: "err", firstSeenAt: 1, lastSeenAt: 2,
    }];
    const incoming: any[] = [];
    const result = mergeRegistry(existing, incoming, 3);
    expect(result[0].status).toBe("fixed");
    expect(result[0].fixedAt).toBe(3);
  });

  it("keeps persistent status across multiple iterations", () => {
    const existing: any[] = [{
      id: "e1", status: "persistent" as const, category: "type" as const,
      file: "a.ts", message: "err", firstSeenAt: 1, lastSeenAt: 2,
    }];
    const incoming = [{ id: "e1", category: "type" as const, file: "a.ts", message: "err" }];
    const result = mergeRegistry(existing, incoming, 3);
    expect(result[0].status).toBe("persistent");
    expect(result[0].lastSeenAt).toBe(3);
  });
});

import { parseOutput, getParserForCommand } from "../src/error-registry";

const mockParser = (name: string) => name as any;

describe("parseOutput", () => {
  describe("tsc parser", () => {
    it("returns empty array for empty output", () => {
      expect(parseOutput("", "tsc")).toEqual([]);
    });

    it("returns empty array for clean build output", () => {
      const output = "";
      expect(parseOutput(output, "tsc")).toEqual([]);
    });

    it("extracts a single tsc error", () => {
      const output = "src/user.ts:42:5 - error TS2322: Type 'string' is not assignable to type 'number'.";
      const errors = parseOutput(output, "tsc");
      expect(errors).toHaveLength(1);
      expect(errors[0].file).toBe("src/user.ts");
      expect(errors[0].line).toBe(42);
      expect(errors[0].category).toBe("type");
      expect(errors[0].message).toContain("not assignable");
      expect(errors[0].id).toBeTruthy();
    });

    it("extracts multiple errors from different files", () => {
      const output = [
        "src/user.ts:42:5 - error TS2322: Type 'string' is not assignable.",
        "src/auth.ts:12:3 - error TS6192: All imports are unused.",
      ].join("\n");
      const errors = parseOutput(output, "tsc");
      expect(errors).toHaveLength(2);
      expect(errors[0].file).toBe("src/user.ts");
      expect(errors[1].file).toBe("src/auth.ts");
    });

    it("extracts warnings too", () => {
      const output = "src/user.ts:50:10 - warning TS(6192): All imports are unused.";
      const errors = parseOutput(output, "tsc");
      expect(errors).toHaveLength(1);
      expect(errors[0].category).toBe("type");
    });
  });

  describe("eslint parser (stylish)", () => {
    it("extracts errors from stylish format", () => {
      const output = "/path/src/user.ts\n  42:5   error    no-unused-vars  'x' is assigned but never used";
      const errors = parseOutput(output, "eslint");
      expect(errors).toHaveLength(1);
      expect(errors[0].file).toContain("src/user.ts");
      expect(errors[0].line).toBe(42);
      expect(errors[0].category).toBe("lint");
    });

    it("returns empty for clean output", () => {
      expect(parseOutput("", "eslint")).toEqual([]);
    });

    it("handles multiple errors across files", () => {
      const output = [
        "/path/src/user.ts",
        "  42:5   error    no-unused-vars  'x' is unused",
        "  50:10  warning  prefer-const     'y' is never reassigned",
        "",
        "/path/src/auth.ts",
        "  12:3   error    @typescript-eslint/no-unused-vars  'z' is unused",
      ].join("\n");
      const errors = parseOutput(output, "eslint");
      expect(errors.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("vitest parser", () => {
    it("returns empty for all-pass output", () => {
      const output = "Test Files  3 passed (3)\nTests  15 passed (15)";
      expect(parseOutput(output, "vitest")).toEqual([]);
    });

    it("extracts failure info", () => {
      const output = [
        " ❯ src/__tests__/user.test.ts (3 tests) 232ms",
        "   ✓ should create user (12ms)",
        "   × should validate email (50ms)",
        "     → AssertionError: expected 'foo' to match /^.+@.+$/",
      ].join("\n");
      const errors = parseOutput(output, "vitest");
      expect(errors).toHaveLength(1);
      expect(errors[0].category).toBe("test");
      expect(errors[0].message).toContain("should validate email");
    });

    it("extracts file location from stack trace", () => {
      const output = [
        "   × should handle edge case",
        "     → TypeError: Cannot read properties of undefined",
        "   - src/user.ts:20:10",
        "   - src/user.ts:25:14",
      ].join("\n");
      const errors = parseOutput(output, "vitest");
      expect(errors).toHaveLength(1);
      expect(errors[0].file).toBe("src/user.ts");
      expect(errors[0].line).toBe(20);
    });
  });

  describe("custom parser", () => {
    it("extracts errors using named capture groups", () => {
      const output = "ERROR in src/app.ts:42: Missing semicolon";
      const errors = parseOutput(output, {
        pattern: "ERROR in (?<file>[^:]+):(?<line>\\d+): (?<message>.*)",
        category: "lint",
      });
      expect(errors).toHaveLength(1);
      expect(errors[0].file).toBe("src/app.ts");
      expect(errors[0].line).toBe(42);
      expect(errors[0].message).toBe("Missing semicolon");
      expect(errors[0].category).toBe("lint");
    });

    it("handles custom group names", () => {
      const output = "FAIL: src/main.js:15: Variable x is undefined";
      const errors = parseOutput(output, {
        pattern: "FAIL: (?<f>[^:]+):(?<ln>\\d+): (?<msg>.*)",
        category: "compile",
        fileGroup: "f",
        lineGroup: "ln",
        messageGroup: "msg",
      });
      expect(errors).toHaveLength(1);
      expect(errors[0].file).toBe("src/main.js");
      expect(errors[0].line).toBe(15);
      expect(errors[0].message).toBe("Variable x is undefined");
    });

    it("handles errors without line numbers", () => {
      const output = "ERROR: src/config.yaml is invalid, line 5";
      const errors = parseOutput(output, {
        pattern: "ERROR: (?<file>\\S+) is invalid, line (?<message>.*)",
        category: "compile",
      });
      expect(errors).toHaveLength(1);
      expect(errors[0].file).toBe("src/config.yaml");
      expect(errors[0].line).toBeUndefined();
    });
  });

  describe("getParserForCommand", () => {
    it("finds parser for matching command", () => {
      const steps = [
        { command: "bun run typecheck", runsOn: "impl" as const, parser: "tsc" as const },
        { command: "bun run lint", runsOn: "impl" as const, parser: "eslint" as const },
      ];
      expect(getParserForCommand("bun run typecheck", steps)).toBe("tsc");
      expect(getParserForCommand("bun run lint", steps)).toBe("eslint");
    });

    it("returns null for unknown command", () => {
      expect(getParserForCommand("echo hi", [])).toBeNull();
    });

    it("returns null when step has no parser", () => {
      const steps = [
        { command: "echo hi", runsOn: "impl" as const },
      ];
      expect(getParserForCommand("echo hi", steps)).toBeNull();
    });
  });
});
