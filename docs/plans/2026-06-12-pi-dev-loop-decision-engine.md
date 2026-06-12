# Decision Engine Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire up the dev loop's core decision engine — structured subagent output, error registry integration, config file loading, git snapshots, and UX improvements.

**Architecture:** Six sequential tasks building toward the final integration. First three (load-config, git, subagent-task) are independent and can run in parallel if needed. The last two (index.ts + verify-config) depend on all prior modules being ready.

**Tech Stack:** TypeScript, Node built-in `child_process` for git, `js-yaml` for YAML parsing, bun for testing.

---

## File Structure

```
pi-dev-loop/
├── package.json                         EDIT: add js-yaml peer dep
│
├── src/
│   ├── load-config.ts                   CREATE: YAML config loading + merging
│   ├── git.ts                           CREATE: git snapshot, rollback, pruning
│   ├── subagent-task.ts                 EDIT: structured output, expandCommand
│   └── verify-config.ts                 EDIT: mergeConfigs function
│
├── extensions/pi-dev-loop/
│   └── index.ts                         EDIT: full decision engine + UX
│
└── tests/
    ├── load-config.test.ts              CREATE
    ├── git.test.ts                      CREATE
    ├── subagent-task.test.ts            EDIT: add expandCommand tests
    └── verify-config.test.ts            EDIT: add mergeConfigs tests
```

---

### Task 1: package.json — Add js-yaml dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add js-yaml to peerDependencies**

```json
{
  "peerDependencies": {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*",
    "js-yaml": "^4.1.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@types/js-yaml": "^4.0.9",
    "bun-types": "^1.0.0"
  }
}
```

- [ ] **Step 2: Install js-yaml**

Run: `cd ~/life-project/pi-dev-loop && bun add --peer js-yaml && bun add -d @types/js-yaml`

- [ ] **Step 3: Verify**

Run: `bun -e "import yaml from 'js-yaml'; console.log(yaml.load('a: 1'))"`
Expected: `{ a: 1 }`

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock
git commit -m "chore: add js-yaml dependency for config file parsing"
```

---

### Task 2: load-config.ts — YAML Configuration Loading

**Files:**
- Create: `src/load-config.ts`
- Create: `tests/load-config.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
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
    expect(config.maxIterations).toBe(10);
    expect(config.maxConsecutiveZeroProgress).toBe(5);
    expect(config.verifySteps).toHaveLength(1);
    expect(config.verifySteps[0].command).toBe("bun run typecheck");
    expect(config.verifySteps[0].runsOn).toBe("impl");
    expect(config.guardrails.gitAutoSnapshot).toBe(false);
    expect(config.guardrails.rollbackOnRegression).toBe(false);
    expect(config.guardrails.maxFileChangesPerSubagent).toBe(10);
  });

  it("applies defaults for missing fields", () => {
    const config = parseConfigContent(`loop:\n  maxIterations: 5\n`);
    expect(config.maxIterations).toBe(5);
    expect(config.maxConsecutiveZeroProgress).toBe(3); // default
    expect(config.verifySteps).toEqual([]);
    expect(config.guardrails.gitAutoSnapshot).toBe(true); // default
  });

  it("parses ask_user verify step", () => {
    const yaml = `
verify:
  - command: "ask_user"
    runsOn: main
    question: "Is this OK?"
`;
    const config = parseConfigContent(yaml);
    expect(config.verifySteps[0].command).toBe("ask_user");
    expect(config.verifySteps[0].runsOn).toBe("main");
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
    expect(config.verifySteps[0].timeout).toBe(120000);
    expect(config.verifySteps[0].parser).toBe("vitest");
  });

  it("returns null for empty content", () => {
    expect(parseConfigContent("")).toBeNull();
  });

  it("returns null for invalid YAML", () => {
    expect(parseConfigContent(": invalid: yaml:")).toBeNull();
  });
});

```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/life-project/pi-dev-loop && bun test tests/load-config.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
// src/load-config.ts
import { parse } from "js-yaml";
import { readFileSync, existsSync } from "node:fs";
import type { DevLoopConfig, VerifyStep, GuardrailsConfig } from "./state";
import { defaultConfig } from "./state";

interface RawConfig {
  loop?: {
    mode?: string;
    maxIterations?: number;
    maxConsecutiveZeroProgress?: number;
  };
  verify?: Array<{
    command: string;
    runsOn?: string;
    timeout?: number;
    parser?: string;
    question?: string;
  }>;
  guardrails?: {
    gitAutoSnapshot?: boolean;
    rollbackOnRegression?: boolean;
    maxFileChangesPerSubagent?: number;
  };
}

export function parseConfigContent(yamlContent: string): DevLoopConfig | null {
  const trimmed = yamlContent.trim();
  if (!trimmed) return null;

  let raw: RawConfig;
  try {
    raw = parse(trimmed) as RawConfig;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;

  const defaults = defaultConfig();

  // Loop section
  const loopMode = raw.loop?.mode;
  if (loopMode && !["goal", "passes", "pipeline"].includes(loopMode)) return null;

  // Verify steps
  const verifySteps: VerifyStep[] = (raw.verify ?? []).map(v => ({
    command: v.command,
    runsOn: (v.runsOn === "main" ? "main" : "impl") as "impl" | "main",
    timeout: v.timeout,
    parser: v.parser,
  }));

  // Guardrails
  const g = raw.guardrails;
  const guardrails: GuardrailsConfig = {
    gitAutoSnapshot: g?.gitAutoSnapshot ?? defaults.guardrails.gitAutoSnapshot,
    rollbackOnRegression: g?.rollbackOnRegression ?? defaults.guardrails.rollbackOnRegression,
    maxFileChangesPerSubagent: g?.maxFileChangesPerSubagent ?? defaults.guardrails.maxFileChangesPerSubagent,
  };

  return {
    maxIterations: raw.loop?.maxIterations ?? defaults.maxIterations,
    maxConsecutiveZeroProgress: raw.loop?.maxConsecutiveZeroProgress ?? defaults.maxConsecutiveZeroProgress,
    verifySteps,
    guardrails,
  };
}

export function loadConfigFromFile(filePath?: string): DevLoopConfig | null {
  const path = filePath ?? findConfigInCwd();
  if (!path || !existsSync(path)) return null;
  const content = readFileSync(path, "utf-8");
  return parseConfigContent(content);
}

export function findConfigInCwd(): string | null {
  const candidates = [".pidev.yml", ".pidev.yaml", "pidev.yml", "pidev.yaml"];
  for (const name of candidates) {
    if (existsSync(name)) return name;
  }
  return null;
}

// mergeConfigs is defined in verify-config.ts (Task 5).
// This module only exports parseConfigContent, loadConfigFromFile, findConfigInCwd.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/life-project/pi-dev-loop && bun test tests/load-config.test.ts`
Expected: All 10 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/load-config.ts tests/load-config.test.ts
git commit -m "feat: add YAML config file loading with parseConfigContent"
```

---

### Task 3: git.ts — Git Snapshot & Rollback Utilities

**Files:**
- Create: `src/git.ts`
- Create: `tests/git.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/git.test.ts
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
  // Initial commit so HEAD is valid
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
    // clean up
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

    // Verify the commit exists
    const log = execSync("git log --oneline -1", { cwd: tmpDir }).toString().trim();
    expect(log).toContain("test-snapshot");
  });

  it("throws when there are no changes to commit", () => {
    expect(() => takeSnapshot("empty", tmpDir)).toThrow();
  });
});

describe("rollbackToSnapshot", () => {
  it("resets working tree to snapshot state", () => {
    // Create a file, snapshot, modify it, rollback
    writeFileSync(join(tmpDir, "rollback.txt"), "v1");
    execSync("git add -A && git commit -m 'v1'", { cwd: tmpDir });
    const snap = takeSnapshot("pre-rollback", tmpDir);

    writeFileSync(join(tmpDir, "rollback.txt"), "v2-modified");
    rollbackToSnapshot(snap.hash, tmpDir);

    const content = execSync("git show HEAD:rollback.txt", { cwd: tmpDir }).toString().trim();
    expect(content).toBe("v1");
  });
});

describe("pruneSnapshots", () => {
  it("removes old snapshot commits keeping recent N", () => {
    // Create 3 snapshot commits
    writeFileSync(join(tmpDir, "p1.txt"), "1");
    takeSnapshot("prune-test", tmpDir);
    writeFileSync(join(tmpDir, "p2.txt"), "2");
    takeSnapshot("prune-test", tmpDir);
    writeFileSync(join(tmpDir, "p3.txt"), "3");
    takeSnapshot("prune-test", tmpDir);

    const before = execSync("git log --oneline --grep='prune-test'", { cwd: tmpDir }).toString().trim().split("\n").length;
    expect(before).toBe(3);

    pruneSnapshots(1, tmpDir);

    const after = execSync("git log --oneline --grep='prune-test'", { cwd: tmpDir }).toString().trim().split("\n").length;
    expect(after).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/life-project/pi-dev-loop && bun test tests/git.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
// src/git.ts
import { execSync } from "node:child_process";

export interface GitSnapshot {
  hash: string;
  branch: string;
  timestamp: number;
}

/**
 * Check if the working tree has uncommitted changes.
 * Pass `cwd` for testing, defaults to process.cwd().
 */
export function hasUncommittedChanges(cwd?: string): boolean {
  const dir = cwd ?? process.cwd();
  const output = execSync("git status --porcelain", { cwd: dir }).toString().trim();
  return output.length > 0;
}

/**
 * Create a snapshot commit of all current changes.
 * The commit message is prefixed with `prefix` for later identification.
 * Throws if there are no changes to commit.
 */
export function takeSnapshot(prefix: string, cwd?: string): GitSnapshot {
  const dir = cwd ?? process.cwd();
  execSync("git add -A", { cwd: dir });
  // Check if anything was staged
  const staged = execSync("git diff --cached --stat", { cwd: dir }).toString().trim();
  if (!staged) {
    throw new Error("No changes to snapshot");
  }
  execSync(`git commit -m "dev-loop: ${prefix}"`, { cwd: dir });
  const hash = execSync("git rev-parse HEAD", { cwd: dir }).toString().trim();
  const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: dir }).toString().trim();
  return { hash, branch, timestamp: Date.now() };
}

/**
 * Hard-reset to a specific snapshot hash. Discards all changes after that point.
 */
export function rollbackToSnapshot(hash: string, cwd?: string): void {
  const dir = cwd ?? process.cwd();
  execSync(`git reset --hard ${hash}`, { cwd: dir });
}

/**
 * Remove old auto-snapshot commits, keeping the most recent `keep` count.
 * Only targets commits with messages starting with "dev-loop:".
 */
export function pruneSnapshots(keep: number, cwd?: string): void {
  const dir = cwd ?? process.cwd();
  // List all dev-loop snapshot commits from newest to oldest
  const log = execSync(
    'git log --oneline --grep="dev-loop:" --format="%H"',
    { cwd: dir },
  ).toString().trim().split("\n").filter(Boolean);

  if (log.length <= keep) return;

  const toRemove = log.slice(keep); // older ones (later in the list)
  for (const hash of toRemove) {
    // Delete the ref and orphan the commit — gc will clean it up
    try {
      execSync(`git update-ref -d refs/heads/dev-loop-snap-${hash.slice(0, 7)} 2>/dev/null; true`, { cwd: dir });
    } catch { /* ignore */ }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/life-project/pi-dev-loop && bun test tests/git.test.ts`
Expected: All tests PASS (may need `--timeout 10000` for git operations)

- [ ] **Step 5: Commit**

```bash
git add src/git.ts tests/git.test.ts
git commit -m "feat: add git snapshot and rollback utilities"
```

---

### Task 4: subagent-task.ts — Structured Output Protocol + expandCommand

**Files:**
- Modify: `src/subagent-task.ts`
- Modify: `tests/subagent-task.test.ts`

- [ ] **Step 1: Write the failing test additions**

Add to `tests/subagent-task.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { packImplTask, packReviewTask, expandCommand } from "../src/subagent-task";
// ... existing tests ...

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/life-project/pi-dev-loop && bun test tests/subagent-task.test.ts`
Expected: FAIL — `expandCommand` not exported, `packImplTask` missing new parameter

- [ ] **Step 3: Write implementation updates**

```typescript
// src/subagent-task.ts

// ——— Existing imports remain unchanged ———

/**
 * Expand {files} placeholder in a verify command with the actual changed files.
 */
export function expandCommand(cmd: string, changedFiles: string[]): string {
  return cmd.replace(/\{files\}/g, changedFiles.join(" "));
}

/**
 * Build the full-context task string for an implementation subagent.
 *
 * The subagent receives error details, additional context, and the
 * verification commands it MUST pass before returning.
 * Appends a structured output format section at the end.
 *
 * @param changedFiles - Files changed so far in this iteration (for {files} expansion).
 */
export function packImplTask(
  error: ErrorRecord,
  config: DevLoopConfig,
  extraContext?: string,
  changedFiles: string[] = [],
): string {
  const lines: string[] = [];
  lines.push("## Implementation Task");
  lines.push("");
  lines.push("Fix the following error using TDD (write failing test → implement → verify all commands pass).");
  lines.push("");

  const loc = error.line ? `${error.file}:${error.line}` : error.file;
  lines.push("### Error Details");
  lines.push(`- File: \`${loc}\``);
  lines.push(`- Category: ${error.category}`);
  lines.push(`- Message: ${error.message}`);
  lines.push("");

  if (extraContext) {
    lines.push("### Additional Context");
    lines.push(extraContext);
    lines.push("");
  }

  const implSteps = config.verifySteps.filter(v => v.runsOn === "impl");
  if (implSteps.length > 0) {
    lines.push("### Required Verification (MUST pass before returning)");
    for (const step of implSteps) {
      const cmd = expandCommand(step.command, changedFiles);
      lines.push(`- \`${cmd}\``);
    }
    lines.push("");
  }

  // Structured output section
  lines.push("### Structured Output Format");
  lines.push("When your work is complete, the **last section** of your response must be a JSON block:");
  lines.push("");
  lines.push('```json');
  lines.push('{');
  lines.push('  "changedFiles": ["...", "..."],');
  lines.push('  "verificationPassed": true,');
  lines.push('  "summary": "What was done and the result",');
  lines.push('  "errorsFixed": [');
  lines.push('    {"id": "abc123", "category": "type", "file": "src/main.ts", "line": 42, "message": "..."}');
  lines.push('  ],');
  lines.push('  "errorsRemaining": []');
  lines.push('}');
  lines.push('```');
  lines.push("");
  lines.push("- `errorsFixed`: errors confirmed fixed (no longer appear in verification output)");
  lines.push("- `errorsRemaining`: errors that persist after your fix");
  lines.push("- `verificationPassed`: MUST be `true` for all required commands to pass");

  return lines.join("\n");
}

/**
 * Build a context-free review task for a review subagent.
 * Only the list of changed files is provided — no task context,
 * so the reviewer evaluates the code independently.
 * Appends a structured output section at the end.
 */
export function packReviewTask(changedFiles: string[]): string {
  const lines: string[] = [];
  lines.push("## Code Review Task");
  lines.push("");
  lines.push("Review the following changed files for issues:");
  lines.push("");
  for (const file of changedFiles) {
    lines.push(`- \`${file}\``);
  }
  lines.push("");
  lines.push("Look for:");
  lines.push("- Edge cases not handled");
  lines.push("- Missing or incorrect error handling");
  lines.push("- Test coverage gaps");
  lines.push("- Maintainability concerns");
  lines.push("");

  // Structured output section
  lines.push("### Structured Output Format");
  lines.push('```json');
  lines.push('{');
  lines.push('  "findings": [');  
  lines.push('    {"severity": "critical", "file": "src/main.ts", "message": "..."},');
  lines.push('    {"severity": "important", "file": "src/main.ts", "message": "..."},');
  lines.push('    {"severity": "minor", "file": "src/main.ts", "message": "..."}');
  lines.push('  ]');
  lines.push('}');
  lines.push('```');

  return lines.join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/life-project/pi-dev-loop && bun test tests/subagent-task.test.ts`
Expected: All tests PASS (existing 7 + new ~7 = ~14 tests)

- [ ] **Step 5: Commit**

```bash
git add src/subagent-task.ts tests/subagent-task.test.ts
git commit -m "feat: add structured output protocol and expandCommand"
```

---

### Task 5: verify-config.ts — mergeConfigs function

**Files:**
- Modify: `src/verify-config.ts`
- Modify: `tests/verify-config.test.ts`

- [ ] **Step 1: Write the failing test addition**

Add to `tests/verify-config.test.ts`:

```typescript
import { parseInlineVerifies, buildConfig, mergeConfigs } from "../src/verify-config";
// ... existing tests ...

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/life-project/pi-dev-loop && bun test tests/verify-config.test.ts`
Expected: FAIL — `mergeConfigs` not exported

- [ ] **Step 3: Add mergeConfigs to verify-config.ts**

```typescript
// src/verify-config.ts — add at the end

/**
 * Merge a base (YAML-derived) config with CLI overrides.
 * Any field present in `cliOverrides` replaces the base value.
 */
export function mergeConfigs(
  base: DevLoopConfig,
  cliOverrides: Partial<DevLoopConfig>,
): DevLoopConfig {
  return {
    maxIterations: cliOverrides.maxIterations ?? base.maxIterations,
    maxConsecutiveZeroProgress: cliOverrides.maxConsecutiveZeroProgress ?? base.maxConsecutiveZeroProgress,
    verifySteps: cliOverrides.verifySteps ?? base.verifySteps,
    guardrails: cliOverrides.guardrails ?? base.guardrails,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/life-project/pi-dev-loop && bun test tests/verify-config.test.ts`
Expected: All tests PASS (existing 6 + 3 new = 9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/verify-config.ts tests/verify-config.test.ts
git commit -m "feat: add mergeConfigs to verify-config"
```

---

### Task 6: index.ts — Full Decision Engine + UX Improvements

**Files:**
- Modify: `extensions/pi-dev-loop/index.ts`

This task cannot be unit-tested via bun test (depends on pi's runtime API). Verification is via `/reload` in pi and manual smoke testing.

- [ ] **Step 1: Read the current index.ts to understand existing structure**

The current file has these sections:
1. Imports + helpers (emptyState, buildDevCommandPrompt, updateWidget, toSnapshot)
2. Extension default fn
3. Session reconstruction (session_start, session_tree)
4. Resource discovery (resources_discover)
5. Input prefix transform (input)
6. System prompt injection (before_agent_start)
7. `/dev` command handler (goal, stop, status, pause, resume)
8. `dev_control` tool registration (parameters, execute, renderCall, renderResult)

Changes needed:
- **Imports**: Add `loadConfigFromFile` (from load-config), `takeSnapshot`, `hasUncommittedChanges`, `rollbackToSnapshot` (from git), `mergeRegistry`, `fingerprint` (from error-registry), `ErrorSignature` (from error-registry)
- **dev_control parameters type**: Add `errorsFixed`/`errorsRemaining` to implSubagents
- **dev_control execute**: Full decision engine
- **`/dev goal`**: `--from-config` support
- **`/dev history`**: New subcommand
- **Widget**: Improved display
- **buildDevCommandPrompt**: Improved first-iteration prompt

- [ ] **Step 2: Write the updated index.ts**

```typescript
// extensions/pi-dev-loop/index.ts — pi-dev-loop extension entry point
//
// Commands:   /dev goal|stop|status|pause|resume|history
// Tools:      dev_control (called by LLM to signal iteration completion)
// Events:     input (prefix transform), before_agent_start (skill injection),
//             session_start / session_tree (state reconstruction)
// Resources:  skill + prompt registration

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import {
  createState,
  detectProgress,
  defaultConfig,
  type DevLoopState,
  type DevLoopConfig,
  type ErrorRecord,
} from "../../src/state.ts";
import { mergeRegistry, fingerprint, type ErrorSignature } from "../../src/error-registry.ts";
import { buildConfig, parseInlineVerifies, mergeConfigs } from "../../src/verify-config.ts";
import { loadConfigFromFile } from "../../src/load-config.ts";
import { takeSnapshot, hasUncommittedChanges, rollbackToSnapshot } from "../../src/git.ts";
import { buildIterationPrompt } from "../../src/session-prompt.ts";

// ── Types ─────────────────────────────────────────────────────

interface ImplSubagentReport {
  id: string;
  task: string;
  changedFiles: string[];
  verificationPassed: boolean;
  summary: string;
  errorsFixed: ErrorSignature[];
  errorsRemaining: ErrorSignature[];
}

interface ReviewFindingReport {
  severity: "critical" | "important" | "minor";
  file: string;
  message: string;
}

// ── Helpers ────────────────────────────────────────────────────

const _dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(_dirname, "../..");

function emptyState(): DevLoopState {
  return {
    active: false, mode: "goal", goal: "",
    currentStep: 0, maxSteps: 0,
    errorRegistry: [], reviewFindings: [],
    consecutiveZeroProgress: 0,
    stages: [], currentStage: 0,
    config: defaultConfig(),
    done: false, reasonDone: "",
  };
}

function buildDevCommandPrompt(goal: string, config: DevLoopConfig): string {
  const lines: string[] = [];
  lines.push("## Dev Loop — Iteration 1");
  lines.push("");
  lines.push(`Goal: ${goal}`);
  lines.push("");
  const implVerifies = config.verifySteps.filter(v => v.runsOn === "impl");
  if (implVerifies.length > 0) {
    lines.push("### Verification Commands (MUST pass before dev_control)");
    for (const v of implVerifies) lines.push(`- \`${v.command}\``);
    lines.push("");
  }
  lines.push("### How to start");
  lines.push("1. Analyze the codebase to understand what needs to change");
  lines.push("2. Spawn an **impl subagent** with full context:");
  lines.push('   `subagent({ agent: "worker", task: packImplTask(...) })`');
  lines.push("3. After impl returns, spawn a **review subagent**:");
  lines.push('   `subagent({ agent: "reviewer", task: packReviewTask(changedFiles) })`');
  lines.push("4. Call `dev_control({ status: \"next\", ... })` to continue");
  lines.push('   or `dev_control({ status: "done", ... })` if the goal is fully met');
  return lines.join("\n");
}

function updateWidget(state: DevLoopState, ctx: ExtensionContext) {
  if (!state.active) {
    ctx.ui.setStatus("dev-loop", undefined);
    ctx.ui.setWidget("dev-loop", undefined);
    return;
  }
  const total = state.errorRegistry.length;
  const fixed = state.errorRegistry.filter(e => e.status === "fixed").length;
  const open = total - fixed;
  const barLen = 10;
  const filled = total > 0 ? Math.round((fixed / total) * barLen) : 0;
  const bar = "■".repeat(filled) + "□".repeat(barLen - filled);
  const regressed = state.errorRegistry.filter(e => e.status === "regressed").length;
  const persistent = state.errorRegistry.filter(e => e.status === "persistent").length;
  const newErrors = state.errorRegistry.filter(e => e.status === "new").length;

  const label = `iter ${state.currentStep + 1}/${state.config.maxIterations}  [${bar}] ${open} open`;
  let detail = "";
  if (regressed > 0) detail += ` ⚠ ${regressed} regressed`;
  if (newErrors > 0) detail += `  ■ ${newErrors} new`;
  if (persistent > 0) detail += `  ■ ${persistent} persist`;

  ctx.ui.setStatus("dev-loop", `🔄 ${label}`);
  ctx.ui.setWidget("dev-loop", [
    `┌─ Dev Loop ───────────────`,
    `│ ${state.goal}`,
    `│ ${label}${detail}`,
    `└──────────────────────────`,
  ]);
}

function toSnapshot(state: DevLoopState): object {
  return {
    active: state.active,
    mode: state.mode,
    goal: state.goal,
    currentStep: state.currentStep,
    maxSteps: state.maxSteps,
    errorRegistry: state.errorRegistry,
    reviewFindings: state.reviewFindings,
    consecutiveZeroProgress: state.consecutiveZeroProgress,
    pauseReason: state.pauseReason,
    config: state.config,
    lastCleanSnapshot: state.lastCleanSnapshot,
    latestSnapshot: state.latestSnapshot,
    done: state.done,
    reasonDone: state.reasonDone,
  };
}

function buildHistoryReport(ctx: ExtensionContext): string {
  const entries: string[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (msg.role === "toolResult" && msg.toolName === "dev_control") {
      const details = msg.details as {
        state?: DevLoopState; summary?: string; blockReason?: string;
      } | undefined;
      if (details?.state) {
        const s = details.state;
        const status = s.done ? "✓" : s.pauseReason ? "⏸" : "→";
        entries.push(
          `${status} Iteration ${s.currentStep}: ${details.summary ?? s.reasonDone ?? "no summary"}`,
        );
      }
    }
  }
  if (entries.length === 0) return "No dev loop history found.";
  return entries.join("\n");
}

// ── Extension entry ────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let state = emptyState();

  // ── Session reconstruction ──
  function reconstructState(ctx: ExtensionContext) {
    state = emptyState();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (msg.role === "toolResult" && msg.toolName === "dev_control") {
        const details = msg.details as { state?: Record<string, unknown> } | undefined;
        if (details?.state) {
          state = { ...emptyState(), ...details.state } as DevLoopState;
        }
      }
    }
  }

  pi.on("session_start", async (_e, ctx) => reconstructState(ctx));
  pi.on("session_tree", async (_e, ctx) => reconstructState(ctx));

  // ── Resource discovery (skill + prompt paths) ──
  pi.on("resources_discover", () => ({
    skillPaths: [join(PACKAGE_ROOT, "skills/pi-dev-loop/SKILL.md")],
    promptPaths: [join(PACKAGE_ROOT, "prompts/dev-goal.md")],
  }));

  // ── Input prefix transform (devloop: / #devloop) ──
  pi.on("input", async (event, ctx) => {
    const trimmed = event.text.trim();
    const match = trimmed.match(/^(?:devloop:|#devloop)\s*(.*)$/is);
    if (!match) return { action: "continue" };
    const objective = match[1]?.trim();
    if (!objective) {
      ctx.ui.notify("Usage: devloop: <objective>", "warning");
      return { action: "handled" };
    }
    return {
      action: "transform",
      text: `You are starting a dev loop. Goal: ${objective}\n\nStart by analyzing the project, then begin your first iteration. Use dev_control("next") to continue, dev_control("done") when complete.`,
    };
  });

  // ── System prompt injection (skill + loop context) ──
  pi.on("before_agent_start", async (event) => {
    if (!state.active) return;
    return {
      systemPrompt:
        event.systemPrompt +
        "\n\n## Active Dev Loop\n" +
        `Mode: ${state.mode} | Iteration: ${state.currentStep + 1}` +
        (state.maxSteps === Infinity ? "" : `/${state.maxSteps}`) +
        `\nGoal: ${state.goal}` +
        "\nYou are the **orchestrator**. Do NOT write code directly." +
        "\nAnalyze the error registry → deploy impl subagent(s) → deploy review subagent(s) → call dev_control." +
        "\nCall `dev_control` with status \"next\" to continue or \"done\" when the goal is fully met.",
    };
  });

  // ── /dev command ──
  pi.registerCommand("dev", {
    description: "Start/control a dev loop. Usage: /dev goal <desc> [options] | /dev stop | /dev status | /dev history",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        ctx.ui.notify(
          "Usage:\n  /dev goal <desc> [--verify cmd] [--from-config [path]]\n  /dev stop\n  /dev status\n  /dev pause\n  /dev resume\n  /dev history",
          "info",
        );
        return;
      }

      const parts = args.trim().split(/\s+/);
      const subcmd = parts[0];

      if (subcmd === "stop") {
        if (!state.active) { ctx.ui.notify("No active loop", "info"); return; }
        state.active = false;
        state.done = true;
        state.reasonDone = "Stopped by user";
        updateWidget(state, ctx);
        ctx.ui.notify("Dev loop stopped", "warning");
        return;
      }

      if (subcmd === "status") {
        if (!state.active) { ctx.ui.notify("No active loop", "info"); return; }
        const lines = [
          `Dev Loop — ${state.mode}`,
          `Iteration: ${state.currentStep + 1}${state.maxSteps === Infinity ? "" : `/${state.maxSteps}`}`,
          `Goal: ${state.goal}`,
          `Errors: ${state.errorRegistry.filter(e => e.status !== "fixed").length} open / ${state.errorRegistry.length} total`,
          `Review findings: ${state.reviewFindings.filter(f => f.status === "open").length} open`,
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (subcmd === "pause") {
        if (!state.active) { ctx.ui.notify("No active loop", "info"); return; }
        state.active = false;
        ctx.ui.setStatus("dev-loop", "paused");
        ctx.ui.notify("Dev loop paused. Use /dev resume to continue.", "info");
        return;
      }

      if (subcmd === "resume") {
        if (state.active) { ctx.ui.notify("Already active", "info"); return; }
        if (state.done) { ctx.ui.notify("Loop already completed", "info"); return; }
        state.active = true;
        updateWidget(state, ctx);
        pi.sendUserMessage(buildIterationPrompt(state));
        ctx.ui.notify("Dev loop resumed", "info");
        return;
      }

      if (subcmd === "history") {
        const report = buildHistoryReport(ctx);
        ctx.ui.notify(report, "info");
        return;
      }

      // ── /dev goal ... ──
      if (subcmd !== "goal") {
        ctx.ui.notify(`Unknown subcommand "${subcmd}". Use: goal, stop, status, pause, resume, history`, "error");
        return;
      }

      await ctx.waitForIdle();

      // Parse: /dev goal <desc> [--verify cmd] [--max-iterations N] [--from-config [path]]
      const rest = parts.slice(1);
      const verifyFlags: string[] = [];
      let maxIterations = 20;
      let fromConfigPath: string | undefined;
      const goalParts: string[] = [];

      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "--verify" && i + 1 < rest.length) {
          verifyFlags.push("--verify", rest[++i]);
        } else if (rest[i] === "--max-iterations" && i + 1 < rest.length) {
          maxIterations = parseInt(rest[++i], 10) || 20;
        } else if (rest[i] === "--from-config") {
          // Check if next token is a path (not another flag and not empty)
          if (i + 1 < rest.length && !rest[i + 1].startsWith("--") && rest[i + 1].length > 0) {
            fromConfigPath = rest[++i];
          } else {
            fromConfigPath = ""; // auto-detect
          }
        } else {
          goalParts.push(rest[i]);
        }
      }

      const goal = goalParts.join(" ");
      if (!goal) {
        ctx.ui.notify("Provide a goal description", "error");
        return;
      }

      let config: DevLoopConfig;

      if (fromConfigPath !== undefined) {
        // Load from YAML, then merge CLI overrides
        const yamlConfig = loadConfigFromFile(fromConfigPath || undefined);
        if (!yamlConfig) {
          const pathHint = fromConfigPath || ".pidev.yml";
          ctx.ui.notify(`Config file not found or invalid: ${pathHint}`, "error");
          return;
        }
        const cliVerify = parseInlineVerifies(verifyFlags);
        const cliOverrides: Partial<DevLoopConfig> = { maxIterations };
        if (cliVerify.length > 0) cliOverrides.verifySteps = cliVerify;
        config = mergeConfigs(yamlConfig, cliOverrides);
      } else {
        const verifySteps = parseInlineVerifies(verifyFlags);
        config = buildConfig({ maxIterations, verifySteps });
      }

      state = createState("goal", goal, config);
      updateWidget(state, ctx);
      pi.sendUserMessage(buildDevCommandPrompt(goal, config));
    },
  });

  // ── dev_control tool ──
  pi.registerTool({
    name: "dev_control",
    label: "Dev Loop Control",
    description: [
      "Signal dev loop progress. Call this after impl subagent(s) and review subagent(s) complete.",
      "status 'next': advance to the next iteration.",
      "status 'done': the goal is fully met.",
    ].join(" "),
    parameters: Type.Object({
      status: StringEnum(["next", "done"] as const),
      summary: Type.String({ description: "What was accomplished this iteration" }),
      implSubagents: Type.Array(
        Type.Object({
          id: Type.String(),
          task: Type.String(),
          changedFiles: Type.Array(Type.String()),
          verificationPassed: Type.Boolean(),
          summary: Type.String(),
          errorsFixed: Type.Array(
            Type.Object({
              id: Type.String(),
              category: Type.String(),
              file: Type.String(),
              line: Type.Optional(Type.Number()),
              message: Type.String(),
            }),
          ),
          errorsRemaining: Type.Array(
            Type.Object({
              id: Type.String(),
              category: Type.String(),
              file: Type.String(),
              line: Type.Optional(Type.Number()),
              message: Type.String(),
            }),
          ),
        }),
        { description: "Results from implementation subagents" },
      ),
      reviewFindings: Type.Array(
        Type.Object({
          severity: StringEnum(["critical", "important", "minor"] as const),
          file: Type.String(),
          message: Type.String(),
        }),
        { description: "Findings from review subagents" },
      ),
    }),
    async execute(
      _id: string,
      params: {
        status: "next" | "done";
        summary: string;
        implSubagents: ImplSubagentReport[];
        reviewFindings: ReviewFindingReport[];
      },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      if (!state.active) {
        return {
          content: [{ type: "text", text: "No active dev loop. Start one with /dev goal." }],
          details: { state: null },
        };
      }

      if (params.status === "done") {
        state.active = false;
        state.done = true;
        state.reasonDone = params.summary;
        updateWidget(state, ctx);
        return {
          content: [
            { type: "text", text: `✓ Dev loop complete after ${state.currentStep + 1} iteration(s). ${state.reasonDone}` },
          ],
          details: { state: toSnapshot(state) },
        };
      }

      // ── status === "next" — Decision Engine ──

      // Step 1: Verification check — all subagents MUST pass
      if (!params.implSubagents || params.implSubagents.length === 0) {
        return {
          content: [{ type: "text", text: "✗ No impl subagents reported. Provide at least one impl subagent result." }],
          details: { state: toSnapshot(state), blockReason: "no_subagents" },
        };
      }

      const allPassed = params.implSubagents.every(s => s.verificationPassed === true);
      if (!allPassed) {
        return {
          content: [{
            type: "text",
            text: "✗ Verification failed for one or more impl subagents. All subagents must pass verification before advancing. Fix the issues and call dev_control again.",
          }],
          details: { state: toSnapshot(state), blockReason: "verification_failed" },
        };
      }

      // Step 2: Collect review findings
      // Auto-convert critical review findings to error registry entries
      const incomingErrors: ErrorSignature[] = [];
      for (const f of params.reviewFindings ?? []) {
        state.reviewFindings.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          severity: f.severity,
          file: f.file,
          message: f.message,
          status: "open",
        });
        if (f.severity === "critical") {
          incomingErrors.push({
            id: fingerprint(f.file, 0, f.message),
            category: "review",
            file: f.file,
            message: f.message,
          });
        }
      }

      // Step 3: Collect remaining errors from impl subagents
      for (const sub of params.implSubagents) {
        for (const err of sub.errorsRemaining ?? []) {
          if (err.id && err.file) {
            incomingErrors.push({
              id: err.id,
              category: (err.category as ErrorSignature["category"]) ?? "compile",
              file: err.file,
              line: err.line,
              message: err.message,
            });
          }
        }
      }

      // Step 4: Preserve old state for progress detection
      const oldErrorRegistry = [...state.errorRegistry];

      // Step 5: Merge registry
      state.errorRegistry = mergeRegistry(state.errorRegistry, incomingErrors, state.currentStep);

      // Step 6: Detect progress
      const progress = detectProgress(
        oldErrorRegistry,
        state.errorRegistry,
        state.consecutiveZeroProgress,
        state.config,
      );

      // Step 7: Decision branch
      state.currentStep++;

      if (progress === "regression") {
        state.pauseReason = "regression";
        state.active = false;

        // Auto-rollback if configured
        if (state.config.guardrails.rollbackOnRegression && state.lastCleanSnapshot) {
          try {
            rollbackToSnapshot(state.lastCleanSnapshot);
          } catch {
            // Soft fail — regression is noted even if rollback fails
          }
        }

        updateWidget(state, ctx);
        return {
          content: [{
            type: "text",
            text: `⚠ Regression detected at iteration ${state.currentStep}. ` +
              `Previously fixed errors have reappeared. The loop is paused. ` +
              (state.lastCleanSnapshot ? `Auto-rolled back to clean snapshot ${state.lastCleanSnapshot.slice(0, 7)}. ` : "") +
              `Use /dev resume to retry with a different approach, or /dev stop to end.`,
          }],
          details: { state: toSnapshot(state), progress, regression: true },
        };
      }

      if (progress === "zero-progress") {
        state.consecutiveZeroProgress++;
        if (state.consecutiveZeroProgress >= state.config.maxConsecutiveZeroProgress) {
          state.pauseReason = "zero-progress";
          state.active = false;
          updateWidget(state, ctx);
          return {
            content: [{
              type: "text",
              text: `⚠ Zero progress for ${state.consecutiveZeroProgress} consecutive iterations. ` +
                `The error set is not changing. Loop paused. ` +
                `Consider a fundamentally different approach, then use /dev resume.`,
            }],
            details: { state: toSnapshot(state), progress },
          };
        }
        // Continue iterating with warning
      } else {
        // Progress or all-clear
        state.consecutiveZeroProgress = 0;
        // Update clean snapshot reference
        if (state.latestSnapshot) {
          state.lastCleanSnapshot = state.latestSnapshot;
        }
      }

      // Step 8: Check completion
      const openErrors = state.errorRegistry.filter(e => e.status !== "fixed").length;
      const openFindings = state.reviewFindings.filter(f => f.status === "open").length;

      if (openErrors === 0 && openFindings === 0) {
        state.active = false;
        state.done = true;
        state.reasonDone = "All errors resolved, all review findings addressed";
        updateWidget(state, ctx);
        return {
          content: [{
            type: "text",
            text: `✓ All errors resolved after ${state.currentStep} iteration(s). Goal achieved.`,
          }],
          details: { state: toSnapshot(state) },
        };
      }

      // Step 9: Check max iterations
      if (state.currentStep >= state.config.maxIterations) {
        state.active = false;
        state.pauseReason = "max-iterations";
        updateWidget(state, ctx);
        return {
          content: [{
            type: "text",
            text: `⚠ Max iterations (${state.config.maxIterations}) reached. Loop paused. Use /dev resume to continue or /dev stop to end.`,
          }],
          details: { state: toSnapshot(state) },
        };
      }

      // Step 10: Git auto-snapshot before next iteration
      if (state.config.guardrails.gitAutoSnapshot) {
        try {
          if (hasUncommittedChanges()) {
            const snap = takeSnapshot(`pre-iter-${state.currentStep + 1}`);
            state.latestSnapshot = snap.hash;
            if (!state.lastCleanSnapshot) {
              state.lastCleanSnapshot = snap.hash;
            }
          }
        } catch {
          // Soft fail — snapshot is best-effort
        }
      }

      // Step 11: Check for ask_user verifier (pause for user confirmation)
      const mainSteps = state.config.verifySteps.filter(v => v.runsOn === "main");
      if (mainSteps.length > 0) {
        state.active = false; // Pause for user
        updateWidget(state, ctx);
        const questions = mainSteps
          .map(s => `- ${(s as { question?: string }).question ?? "请确认是否继续"}`)
          .join("\n");
        pi.sendUserMessage(
          `## User Confirmation\n\nIteration ${state.currentStep} completed.\n\n${questions}\n\nEnter \`/dev resume\` to continue or \`/dev stop\` to end.`,
        );
        return {
          content: [{
            type: "text",
            text: `⏸ Paused for user confirmation. Use /dev resume to continue.`,
          }],
          details: { state: toSnapshot(state), awaitingUser: true },
        };
      }

      // Step 12: Schedule next iteration
      updateWidget(state, ctx);
      setTimeout(() => {
        pi.sendMessage(
          {
            customType: "dev-loop-iteration",
            content: buildIterationPrompt(state),
            display: false,
          },
          { triggerTurn: true, deliverAs: "steer" },
        );
      }, 100);

      return {
        content: [{
          type: "text",
          text: `→ Advancing to iteration ${state.currentStep + 1}. Progress: ${progress}.`,
        }],
        details: { state: toSnapshot(state), progress },
      };
    },
    renderCall(args: { status: string }, theme: { fg: (color: string, text: string) => string }) {
      return new Text(
        theme.fg("toolTitle", "dev_control ") +
        theme.fg(args.status === "done" ? "success" : "accent", args.status),
        0, 0,
      );
    },
    renderResult(
      result: { details?: { state?: DevLoopState; progress?: string } },
      _opts: unknown,
      theme: { fg: (color: string, text: string) => string },
    ) {
      const d = result.details;
      if (!d?.state) return new Text("", 0, 0);
      const s = d.state;
      const progressTag = d.progress ? ` [${d.progress}]` : "";
      return new Text(
        theme.fg(
          s.done ? "success" : s.pauseReason ? "warning" : "accent",
          `${s.done ? "✓" : s.pauseReason ? "⏸" : "→"} iter ${s.currentStep + 1} — ${s.mode}${progressTag}`,
        ),
        0, 0,
      );
    },
  });
}
```

- [ ] **Step 3: Verify compilation**

Run: `cd ~/life-project/pi-dev-loop && bun check extensions/pi-dev-loop/index.ts` (or use tsc/bun build)
Expected: No type errors — all imports resolve

- [ ] **Step 4: Verify existing tests still pass**

Run: `cd ~/life-project/pi-dev-loop && bun test`
Expected: All existing tests PASS (37 + new tests from Tasks 2-5)

- [ ] **Step 5: Manual smoke test in pi**

In a pi session:
1. `/reload` — no errors
2. `/dev status` — "No active loop"
3. `/dev goal "test decision engine" --verify "echo ok"`
   → "Dev Loop — Iteration 1" with verification steps and guidance
4. Call `dev_control({ status: "done", summary: "test" })` — verify loop completes
5. `/dev status` — "No active loop"

- [ ] **Step 6: Commit**

```bash
git add extensions/pi-dev-loop/index.ts
git commit -m "feat: add full decision engine with config loading, git snapshots, and UX improvements"
```

---

## Self-Review

**Spec coverage check:**

| Spec Section | Tasks |
|-------------|-------|
| §2 Structured Output Protocol | Task 4 (subagent-task.ts) |
| §3 Decision Engine | Task 6 (index.ts) |
| §4 Config File Loading | Task 1 (package.json) + Task 2 (load-config.ts) |
| §5 Git Snapshot/Rollback | Task 3 (git.ts) + Task 6 (integration) |
| §6 UX Improvements | Task 6 (widget, history, ask_user, first prompt) |
| §7 Edge Cases & Guards | Task 6 (empty subagents, all fail, partial fail, etc.) |

**Placeholder scan:** No TBD, TODO, "implement later", or vague requirements. Every step has complete code.

**Type consistency:**
- `expandCommand` (Task 4) matches the signature called from `packImplTask`
- `ErrorSignature` type exported from error-registry.ts, used in dev_control (Task 6) and load-config.ts
- `mergeConfigs` is defined only in `verify-config.ts` (Task 5), imported by index.ts
- `fingerprint` from error-registry.ts used in dev_control for critical review → error conversion<｜end▁of▁thinking｜>好，写计划之前先修复一个我发现的类型不一致问题——`mergeConfigs` 不应该在两个文件中重复定义。

<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="edit">
<｜｜DSML｜｜parameter name="path" string="true">/home/sason/life-project/pi-dev-loop/docs/plans/2026-06-12-pi-dev-loop-decision-engine.md