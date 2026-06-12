# pi-dev-loop — Autonomous Development Loop Engine

> Design doc for a pi extension that runs verify-driven development loops with subagent isolation, error tracking, and autonomous iteration.
>
> Status: Draft · Date: 2026-06-12

---

## Table of Contents

1. [Problem & Motivation](#1-problem--motivation)
2. [Architecture Overview](#2-architecture-overview)
3. [Iteration Lifecycle](#3-iteration-lifecycle)
4. [Subagent Isolation Strategy](#4-subagent-isolation-strategy)
5. [Error Registry](#5-error-registry)
6. [State Model](#6-state-model)
7. [Commands & Tools](#7-commands--tools)
8. [Configuration](#8-configuration)
9. [Skill Design](#9-skill-design)
10. [Package Structure](#10-package-structure)
11. [Key Module Interfaces](#11-key-module-interfaces)

---

## 1. Problem & Motivation

**pi-agent-loop** provides a basic loop framework but relies on the LLM to self-judge completion.
**pi-loop-designer** writes blueprints but never executes them.

Both lack:

- **Verify-driven stopping** — no automatic command execution and output analysis; decisions are purely subjective LLM judgments
- **Error tracking across iterations** — no registry of what errors existed, which were fixed, which regressed
- **Regression detection** — no way to know if a new iteration broke something that previously worked
- **Context isolation** — all tool calls (file reads, writes, test output) accumulate in the main session, causing rapid context bloat
- **Autonomous work dispatch** — no mechanism to spawn isolated workers for focused subtasks

**pi-dev-loop** solves these with a three-layer architecture: orchestrator → subagent workers → verification engine.

---

## 2. Architecture Overview

### Three Layers

```
┌──────────────────────────────────────────────────────────┐
│  Layer 1: Main Session (Orchestrator)                    │
│                                                          │
│  Responsibilities:                                       │
│  - Track error registry across iterations                │
│  - Decide what to fix next (priority-ordered errors)     │
│  - Pack context for subagents                            │
│  - Deploy impl subagents → collect results               │
│  - Deploy review subagents → collect findings            │
│  - Synthesize results → call dev_control                 │
│  - Handle regression detection and rollback              │
│                                                          │
│  Context growth per iteration: ~3-5 short messages        │
│  10 iterations ≈ 30-50 messages (vs 200-500 without       │
│  isolation)                                              │
├──────────────────────────────────────────────────────────┤
│  Layer 2: Subagents (Implementation Workers)             │
│                                                          │
│  Two types:                                              │
│  ┌─ Impl Subagent ──────────────────────────────────┐    │
│  │  Receives: full context (error details, types,    │    │
│  │             verification requirements)            │    │
│  │  Does: TDD (write test → implement → verify)      │    │
│  │  Returns: changedFiles, verificationPassed, summary│    │
│  │  Context: discarded after completion               │    │
│  └───────────────────────────────────────────────────┘    │
│  ┌─ Review Subagent ────────────────────────────────┐    │
│  │  Receives: ONLY changedFiles list                  │    │
│  │  Does: reads files independently, finds issues     │    │
│  │  Returns: review findings (severity, file, message)│    │
│  │  Context: fresh, no task context (unbiased review) │    │
│  └───────────────────────────────────────────────────┘    │
├──────────────────────────────────────────────────────────┤
│  Layer 3: Verification Engine (System, no LLM)           │
│                                                          │
│  Responsibilities:                                       │
│  - Parse .pidev.yml / inline --verify args               │
│  - Provide impl subagents with verification commands     │
│  - No "system auto-run" step — verification happens      │
│    inside the impl subagent before it returns            │
└──────────────────────────────────────────────────────────┘
```

### Key Principle

The main session never writes code or runs tests directly. It **analyzes** the error registry and **deploys** subagents. This keeps its context lean and focused on orchestration.

---

## 3. Iteration Lifecycle

### Per-Iteration Sequence

```
         Main Session                     Impl Subagent           Review Subagent
    ┌─────────────────────┐             ┌──────────────┐        ┌──────────────┐
    │  1. Analyze state   │             │              │        │              │
    │  ─ read error reg   │             │              │        │              │
    │  ─ pick next fix    │             │              │        │              │
    │  ─ pack context     │             │              │        │              │
    │                     │             │              │        │              │
    │  2. Deploy impl ────┼────────────▶│  TDD cycle    │        │              │
    │                     │             │  - write test │        │              │
    │                     │             │  - implement  │        │              │
    │                     │             │  - verify     │        │              │
    │                     │             │  - refactor   │        │              │
    │  ◀──────────────────┼─────────────│  (returns)    │        │              │
    │                     │             │              │        │              │
    │  3. Deploy review ──┼───────────────────────────────────▶│  read files   │
    │                     │             │              │        │  find issues  │
    │  ◀──────────────────┼───────────────────────────────────│  (returns)    │
    │                     │             │              │        │              │
    │  4. Synthesize      │             │              │        │              │
    │  ─ merge results    │             │              │        │              │
    │  ─ update error reg │             │              │        │              │
    │  ─ call dev_control │             │              │        │              │
    └─────────────────────┘             └──────────────┘        └──────────────┘
```

### Decision Logic (in dev_control handler)

```
1. Check: all impl subagents returned verificationPassed=true?
   NO  → block, agent must retry or explain

2. Merge review findings into error registry
   - critical/important → add to next iteration's task list
   - minor → record for later

3. Detect progress:
   - Any regressions found?
     YES → git revert last clean snapshot, add regression to task list, next
   - Error count decreased?
     YES → progress, next
   - Error count same but errors changed (fixed some, introduced others)?
     YES → progress (net change in error composition), next
   - Error count same and same errors?
     YES → increment consecutiveZeroProgress counter
     If consecutiveZeroProgress >= max → pause with "zero progress" warning
   - Error count increased?
     YES → increment consecutiveZeroProgress, warn

4. All errors resolved AND no critical/important review findings?
   YES → done
   NO  → schedule next iteration
```

---

## 4. Subagent Isolation Strategy

### Context Inheritance

| Aspect | Impl Subagent | Review Subagent |
|--------|---------------|-----------------|
| Task context | Full (error details, types, files) | None (only changedFiles list) |
| Project context (AGENTS.md, codebase) | Yes (forked) | No (fresh) |
| Conversation history | No (fresh) | No (fresh) |
| Tool set | Read, Edit, Write, Glob, Grep, Bash | Read, Glob, Grep (read-only) |
| Worktree | Yes (if parallel) | No (read-only) |

### Parallel Dispatch

When multiple errors are independent (unrelated modules, no shared state):

```typescript
subagent({
  tasks: [
    { agent: "worker", task: taskForErrorA, worktree: true },
    { agent: "worker", task: taskForErrorB, worktree: true },
  ],
  // Both impl subagents run concurrently
});
```

After all impl subagents complete, spawn review subagents for each.

### Task Serialization

What an impl subagent receives:

```
Task: Fix type error in src/user/register.ts

Error:
  [TYPE_ERROR] Line 42 — Type 'string | undefined' not assignable to 'string'
  Variable `email` comes from CreateUserInput.email (optional field)

Context:
  interface CreateUserInput {
    name: string;
    email?: string;       // ← optional, can be undefined
  }

  function createUser(input: CreateUserInput): User {
    // email used as string without null check
  }

Verification commands that MUST pass:
  bun run typecheck
  bun run test -- --related=src/user/register.ts

Changed files so far in this iteration:
  (none — clean state)
```

---

## 5. Error Registry

### ErrorRecord

```typescript
interface ErrorRecord {
  id: string;          // hash(normalized(file:line:message))
  category: "type" | "lint" | "test" | "compile" | "runtime" | "review";
  file: string;
  line?: number;
  message: string;

  status: "new" | "fixed" | "regressed" | "persistent";
  firstSeenAt: number;
  lastSeenAt: number;
  fixedAt?: number;
  regressedAt?: number[];     // track regression history

  resolvedBySubagent?: string;
  reviewNotes?: string;
}

interface ReviewFinding {
  id: string;
  severity: "critical" | "important" | "minor";
  file: string;
  message: string;
  suggestion?: string;
  status: "open" | "addressed";
}
```

### Error Fingerprinting

```typescript
import { createHash } from "node:crypto";

function fingerprint(file: string, line: number, message: string): string {
  const normal = message
    .replace(/line \d+/g, "line N")
    .replace(/:\d+:/g, ":N:")
    .replace(/expected \d+/gi, "expected N")
    .replace(/got \d+/gi, "got N")
    .trim();
  return createHash("sha256")
    .update(`${file}:${line}:${normal}`)
    .digest("hex")
    .slice(0, 16);
}
```

### Status State Machine

```
┌────────┐   next iteration    ┌─────────┐
│  new   │ ─── error gone ───▶ │  fixed  │
└───┬────┘                     └─────────┘
    │                               │
    │ error reappears               │ error reappears
    ▼                               ▼
┌────────┐                     ┌──────────┐
│persist │  (same error        │regressed │
└────────┘   persists >1 iter) └──────────┘
```

### Update Rules

```
FOR each existing record:
  IF id IN newErrors:
    IF status was "new"  → status = "persistent"
    IF status was "regressed" or "persistent" → keep
  ELSE:
    IF status was "new" or "persistent" → status = "fixed"
    IF status was "regressed" → status = "fixed"

FOR each new error NOT in existing records:
  IF id matches any "fixed" record → status = "regressed"
  ELSE → create new record with status = "new"
```

---

## 6. State Model

### DevLoopState

```typescript
interface DevLoopState {
  active: boolean;
  mode: "goal" | "passes" | "pipeline";
  goal: string;

  currentStep: number;
  maxSteps: number;               // goal mode = Infinity
  errorRegistry: ErrorRecord[];
  reviewFindings: ReviewFinding[];
  consecutiveZeroProgress: number;
  pauseReason?: "regression" | "zero-progress" | "max-iterations";

  // Pipeline
  stages: string[];
  currentStage: number;

  // Config (from .pidev.yml or --verify args)
  config: DevLoopConfig;

  // Git snapshots
  lastCleanSnapshot?: string;     // commit hash where all verify passed
  latestSnapshot?: string;

  done: boolean;
  reasonDone: string;
}

interface DevLoopConfig {
  maxIterations: number;             // default 20
  maxConsecutiveZeroProgress: number; // default 3
  verifySteps: VerifyStep[];
  guardrails: GuardrailsConfig;
}

interface VerifyStep {
  command: string;
  runsOn: "impl" | "main";
  timeout?: number;                  // ms
  parser?: string;                   // "tsc" | "eslint" | "vitest" | "generic"
}

interface GuardrailsConfig {
  gitAutoSnapshot: boolean;
  rollbackOnRegression: boolean;
  maxFileChangesPerSubagent: number;
}
```

### State Persistence

- State is stored via `pi.appendEntry("dev-loop-state", state)` after each iteration
- On `session_start`, rebuilt from session branch by scanning tool result details
- Same pattern as pi-agent-loop and pi-loop-designer

---

## 7. Commands & Tools

### User Commands

| Command | Description |
|---------|-------------|
| `/dev goal <desc> [options]` | Start verify-driven loop |
| `/dev stop` | Stop active loop |
| `/dev pause` | Pause loop (preserve state) |
| `/dev resume` | Resume paused loop |
| `/dev status` | Show loop state + error registry |

Options for `/dev goal`:
- `--verify "cmd"` — add verification command (repeatable)
- `--max-iterations N` — max iterations before auto-pause (default 20)
- `--from-config` — load `.pidev.yml`

### LLM Tool

**dev_control** — called by the main session to signal iteration completion.

```typescript
dev_control({
  status: "next" | "done",
  summary: string,                     // what was accomplished this iteration

  implSubagents: [{                    // results from each impl subagent
    id: string,
    task: string,
    changedFiles: string[],
    verificationPassed: boolean,
    summary: string,
  }],

  reviewFindings: [{                   // findings from review subagent(s)
    severity: "critical" | "important" | "minor",
    file: string,
    message: string,
  }],
})
```

### System Prompt Injection

Each iteration, the main session receives:

```
## Dev Loop — Iteration 3/∞

### Goal
实现用户注册模块

### Error Registry
| Status   | File                     | Error                                  | Since        |
|----------|--------------------------|----------------------------------------|--------------|
| NEW      | src/user.ts:42           | Type 'string\|undefined' not assignable | iter 3       |
| PERSIST  | src/auth.ts:5            | ESLint: unused variable                 | iter 1→2→3   |
| FIXED ✓  | src/hash.ts              | Password hashing missing salt           | iter 2       |

### Review Findings (from iter 2)
- ⚠ src/user.ts:88 — Edge case: empty input not handled (important)

# Priority:
1. [REGRESSED] — something came back, fix immediately
2. [NEW] — newly introduced, fix before adding more
3. [PERSISTENT] — old unresolved, may need different approach
4. [REVIEW] — code quality issues

### Available Subagent Commands
Use subagent() with agent="worker" for implementation (provide full context).
Use subagent() with agent="reviewer" for review (provide only changedFiles).

Call dev_control("next") after impl + review are done.
```

---

## 8. Configuration

### Inline (via command args)

```bash
/dev goal "实现注册模块" \
  --verify "bun run typecheck" \
  --verify "bun run test" \
  --max-iterations 15
```

### Config File (.pidev.yml)

```yaml
# .pidev.yml
loop:
  mode: goal
  maxIterations: 20
  maxConsecutiveZeroProgress: 3

verify:
  - command: "bun run typecheck"
    runsOn: impl
  - command: "bun run lint"
    runsOn: impl
  - command: "bun run test -- --related={files}"
    runsOn: impl
    timeout: 120000
  - command: "ask_user"
    runsOn: main
    question: "请确认当前改动是否符合预期"

guardrails:
  gitAutoSnapshot: true
  rollbackOnRegression: true
  maxFileChangesPerSubagent: 20
```

The `{files}` template variable expands to the comma-separated list of changed files in that subagent.
The `runsOn: "main"` option is reserved for user-interaction verifiers only (type `"ask_user"`).
After impl subagent returns and before the next decision, the system pauses and presents the user with the question.
The loop waits for user input to resume. This is the only mechanism for user interaction in the loop.
All automated verification commands (typecheck, lint, test) MUST use `runsOn: "impl"`.

---

## 9. Skill Design

The skill is the agent's behavior manual for the dev loop. Its full content is in `skills/pi-dev-loop/SKILL.md`.

Key directives:

1. **Orchestrator role** — you do NOT write code directly, you analyze and delegate
2. **Subagent discipline** — impl subagents get full context; review subagents get zero context beyond file list
3. **Priority rules** — regressed > new > persistent > review findings
4. **Parallelism** — independent errors get parallel subagents with worktree isolation
5. **Guardrails** — never give write tools to review subagents, never timeout without retry
6. **Error registry interpretation** — how to read and prioritize the injected error table

---

## 10. Package Structure

```
~/life-project/pi-dev-loop/
├── package.json                     ← pi manifest
├── AGENTS.md                        ← project dev paradigm
├── README.md
│
├── extensions/
│   └── pi-dev-loop/
│       ├── index.ts                 ← entry: commands, tools, events, skill injection
│       ├── state.ts                 ← DevLoopState + serialize/restore
│       ├── session-prompt.ts        ← build iteration prompt templates
│       ├── error-registry.ts        ← ErrorRecord CRUD, fingerprint, status transitions
│       ├── verify-config.ts         ← parse .pidev.yml and --verify args
│       └── subagent-task.ts         ← context packing helpers for subagent tasks
│
├── skills/
│   └── pi-dev-loop/
│       └── SKILL.md                 ← agent behavior guide
│
├── prompts/
│   └── dev-goal.md                  ← quick-start prompt template
│
└── tests/
    └── ...
```

### package.json

```json
{
  "name": "pi-dev-loop",
  "version": "0.1.0",
  "description": "Autonomous development loop engine for pi",
  "keywords": ["pi-package", "dev-loop", "agent-loop"],
  "license": "MIT",
  "pi": {
    "extensions": ["./extensions/pi-dev-loop/index.ts"],
    "skills": ["./skills"],
    "prompts": ["./prompts"]
  },
  "peerDependencies": {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  }
}
```

---

## 11. Key Module Interfaces

### index.ts

```typescript
export default function (pi: ExtensionAPI) {
  // Commands
  pi.registerCommand("dev", { handler });
  pi.registerCommand("dev-stop", { handler });
  pi.registerCommand("dev-status", { handler });

  // Tool
  pi.registerTool({ name: "dev_control", execute });

  // Input prefix transform (loop: / #loop)
  pi.on("input", transformDevPrefix);

  // Skill injection
  pi.on("before_agent_start", injectDevLoopSkill);

  // Session lifecycle
  pi.on("session_start", reconstructState);
  pi.on("session_tree", reconstructState);
}
```

### state.ts — Core API

```typescript
function createState(mode, goal, config): DevLoopState
function updateErrorRegistry(state, newErrors): ErrorRecord[]
function detectProgress(state): "progress" | "zero-progress" | "regression"
function restoreFromBranch(entries): DevLoopState | null
function toSnapshot(state): object  // for pi.appendEntry
```

### error-registry.ts — Core API

```typescript
function fingerprint(file, line?, message): string
function categorize(exitCode, output): ErrorCategory
function parseOutput(tool: "tsc" | "eslint" | "vitest", output: string): ErrorSignature[]
function mergeRegistry(existing: ErrorRecord[], incoming: ErrorSignature[], iter: number): ErrorRecord[]
function prioritizeErrors(registry): ErrorRecord[]  // regressed > new > persistent
```

### subagent-task.ts — Core API

```typescript
function packImplTask(error: ErrorRecord, config: DevLoopConfig): string
function packImplTaskParallel(errors: ErrorRecord[], config): string[]
function packReviewTask(changedFiles: string[]): string
```

### verify-config.ts — Core API

```typescript
function parseConfig(args: string): DevLoopConfig
function parseYamlFile(path: string): DevLoopConfig
function resolveVerifyCommands(config, runsOn): VerifyStep[]
```

---

### Error Registry Detail

```typescript
function mergeRegistry(
  existing: ErrorRecord[],
  incoming: ErrorSignature[],
  iteration: number
): ErrorRecord[] {
  const updated: ErrorRecord[] = [];
  const incomingIds = new Set(incoming.map(e => e.id));

  for (const record of existing) {
    if (record.status === "fixed") continue; // keep for regression detection but don't display

    if (incomingIds.has(record.id)) {
      // Error still present
      const newStatus = record.status === "new" ? "persistent" : record.status;
      updated.push({ ...record, status: newStatus, lastSeenAt: iteration });
      incomingIds.delete(record.id);
    } else {
      // Error gone — mark fixed
      updated.push({ ...record, status: "fixed", fixedAt: iteration });
    }
  }

  // New errors
  for (const sig of incoming) {
    if (!incomingIds.has(sig.id)) continue; // already processed

    const wasFixed = existing.find(r => r.id === sig.id && r.status === "fixed");
    if (wasFixed) {
      updated.push({
        ...wasFixed,
        status: "regressed",
        lastSeenAt: iteration,
        regressedAt: [...(wasFixed.regressedAt ?? []), iteration],
      });
    } else {
      updated.push({
        id: sig.id,
        category: sig.category,
        file: sig.file,
        line: sig.line,
        message: sig.message,
        status: "new",
        firstSeenAt: iteration,
        lastSeenAt: iteration,
      });
    }
  }

  return updated;
}
```

---

## 12. Guardrails & Failure Modes

| Scenario | Behavior |
|----------|----------|
| Impl subagent fails (timeout/error) | Retry once with narrower scope |
| Regression detected | Git revert to last clean snapshot; add regression to error registry |
| Zero progress for N iterations | Auto-pause; notify user with summary |
| Max iterations reached | Auto-pause; notify user |
| User runs /dev goal while loop active | Warn and cancel new loop |
| Review subagent finds critical issue | Treat as new error in registry |
| No verification commands provided | Refuse to start; require --verify or .pidev.yml |
| File changes exceed limit per subagent | Subagent must explain or split into multiple |

---

## 13. Comparison to Existing Plugins

| Feature | pi-agent-loop (v0.1.1) | pi-loop-designer (v0.1.0) | pi-dev-loop (design) |
|---------|---------------|------------------|-------------|
| Loop execution | ✅ Basic goal/passes/pipeline | ❌ None | ✅ Verify-driven |
| Stop decision | LLM self-judgment | Blueprint only | Verification commands pass/fail |
| Error tracking | ❌ | ❌ | ✅ Fingerprinted error registry |
| Subagent isolation | ❌ | ❌ | ✅ Impl + Review with different context strategies |
| Config file | ❌ | ❌ | ✅ .pidev.yml |
| Regression protection | ❌ | ❌ | ✅ Auto git revert |
| Skill | ❌ | ✅ (loop-design skill) | ✅ (dev-loop behavior skill) |
| Prompt templates | ❌ | ✅ | ✅ |
| Context bloat | ⚠️ High | N/A | ✅ Low (isolation + summary-only) |
