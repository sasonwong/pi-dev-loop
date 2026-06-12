// tests/auto-detect.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("detectVerifySteps", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "auto-detect-"));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function detectFresh() {
    // Clear require cache so each test gets a fresh read
    const modPath = join(originalCwd, "src/auto-detect.ts");
    delete require.cache[require.resolve(modPath)];
    const mod = await import(modPath);
    return mod.detectVerifySteps();
  }

  it("returns empty array for empty project", async () => {
    const steps = await detectFresh();
    expect(steps).toEqual([]);
  });

  it("detects typecheck script from package.json", async () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
      scripts: { typecheck: "tsc --noEmit" },
    }));
    const steps = await detectFresh();
    expect(steps.some((s: { command: string }) => s.command === "bun run typecheck")).toBe(true);
  });

  it("detects test when tests/ directory exists", async () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ scripts: {} }));
    mkdirSync(join(tmpDir, "tests"));
    writeFileSync(join(tmpDir, "tests/dummy.test.ts"), "test");
    const steps = await detectFresh();
    expect(steps.some((s: { command: string }) => s.command === "bun run test")).toBe(true);
  });

  it("detects tsconfig.json when no typecheck script", async () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ scripts: {} }));
    writeFileSync(join(tmpDir, "tsconfig.json"), "{}");
    const steps = await detectFresh();
    expect(steps.some((s: { command: string }) => s.command === "bun run typecheck")).toBe(true);
  });

  it("prioritizes package.json scripts over config file detection", async () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
      scripts: { typecheck: "tsc --noEmit" },
    }));
    writeFileSync(join(tmpDir, "tsconfig.json"), "{}");
    mkdirSync(join(tmpDir, "tests"));
    writeFileSync(join(tmpDir, "tests/dummy.test.ts"), "test");
    const steps = await detectFresh();
    expect(steps.length).toBeGreaterThanOrEqual(2);
    const commands = steps.map((s: { command: string }) => s.command);
    expect(new Set(commands).size).toBe(commands.length);
  });
});
