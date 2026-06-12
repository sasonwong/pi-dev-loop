import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { takeSnapshot, hasUncommittedChanges, rollbackToSnapshot, pruneSnapshots } from "../src/git";

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "git-test-"));
  execSync("git init", { cwd: tmpDir });
  execSync('git config user.email "test@test.com"', { cwd: tmpDir });
  execSync('git config user.name "Test"', { cwd: tmpDir });
  writeFileSync(join(tmpDir, "README.md"), "# test");
  execSync("git add -A && git commit -m 'init'", { cwd: tmpDir });
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("hasUncommittedChanges", () => {
  it("returns false for a clean working tree", () => {
    expect(hasUncommittedChanges(tmpDir)).toBe(false);
  });

  it("returns true when files are modified", () => {
    writeFileSync(join(tmpDir, "test.txt"), "hello");
    expect(hasUncommittedChanges(tmpDir)).toBe(true);
    execSync("git checkout -- .", { cwd: tmpDir });
  });
});

describe("takeSnapshot", () => {
  it("creates a snapshot commit and returns hash", () => {
    writeFileSync(join(tmpDir, "snap.txt"), "content");
    const snap = takeSnapshot("test-snapshot", tmpDir);
    expect(snap.hash).toBeTruthy();
    expect(snap.hash.length).toBeGreaterThanOrEqual(7);
    expect(snap.branch).toBeTruthy();
    expect(snap.timestamp).toBeGreaterThan(0);
    const log = execSync("git log --oneline -1", { cwd: tmpDir }).toString().trim();
    expect(log).toContain("test-snapshot");
  });

  it("throws when there are no changes to commit", () => {
    expect(() => takeSnapshot("empty", tmpDir)).toThrow();
  });
});

describe("rollbackToSnapshot", () => {
  it("resets working tree to snapshot state", () => {
    writeFileSync(join(tmpDir, "rollback.txt"), "v1");
    execSync("git add -A && git commit -m 'v1'", { cwd: tmpDir });
    // Make a new change and snapshot it
    writeFileSync(join(tmpDir, "rollback.txt"), "v2-snapshot");
    const snap = takeSnapshot("pre-rollback", tmpDir);
    // Modify after snapshot
    writeFileSync(join(tmpDir, "rollback.txt"), "v3-after-snapshot");
    rollbackToSnapshot(snap.hash, tmpDir);
    const content = execSync("cat rollback.txt", { cwd: tmpDir }).toString().trim();
    expect(content).toBe("v2-snapshot");
  });
});

describe("pruneSnapshots", () => {
  it("removes old snapshot tags keeping recent N", () => {
    // Clean up tags left by previous tests
    execSync("git tag -l 'dev-loop/snap-*' | xargs -r git tag -d", { cwd: tmpDir });

    // Create 3 snapshot commits (each with a tag)
    writeFileSync(join(tmpDir, "p1.txt"), "1");
    takeSnapshot("prune-test", tmpDir);
    writeFileSync(join(tmpDir, "p2.txt"), "2");
    takeSnapshot("prune-test", tmpDir);
    writeFileSync(join(tmpDir, "p3.txt"), "3");
    takeSnapshot("prune-test", tmpDir);

    const before = execSync("git tag -l 'dev-loop/snap-*'", { cwd: tmpDir }).toString().trim().split("\n").filter(Boolean).length;
    expect(before).toBe(3);

    pruneSnapshots(1, tmpDir);

    const after = execSync("git tag -l 'dev-loop/snap-*'", { cwd: tmpDir }).toString().trim().split("\n").filter(Boolean).length;
    expect(after).toBe(1);
  });
});

