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
