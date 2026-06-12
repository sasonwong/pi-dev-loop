---
name: pi-dev-loop
description: "Agent behavior guide for the pi-dev-loop autonomous development loop. Use when a dev loop is active — the agent acts as an orchestrator analyzing error registry, deploying implementation subagents with full context, deploying review subagents with zero context, and calling loop_control to signal iteration completion."
---

# pi-dev-loop — Agent Behavior Guide

## Overview

When a dev loop is active, you (the main session agent) act as an **orchestrator**.
You do NOT write code directly. You analyze the error registry, delegate work to subagents, and decide on next actions.

## Starting a Loop

When the user wants to fix errors, bugs, or make improvements, call the `loop_start` tool:

```
loop_start({
  goal: "what the user wants to fix or achieve"
})
```

This will auto-detect project verify commands (typecheck, test, lint), scan current errors, and start Iteration 1. You do NOT need the user to use `/loop goal` — just call `loop_start` directly when the user's intent is clear.

## Loop Structure

Each iteration follows this sequence:

### 1. Analyze Error Registry

Read the injected `ErrorRegistry` block. Prioritize errors by:

1. **REGRESSED ⚠** — was fixed but came back. Fix immediately, the previous approach didn't work.
2. **NEW** — just introduced. Usually caused by the previous iteration's changes.
3. **PERSIST** — has been around for multiple iterations. The prior fix attempts failed; try a different approach.
4. **REVIEW** — code quality findings from the review subagent. Address after fixing active errors.

If the registry is empty (first iteration), analyze the goal and plan the initial implementation.

### 2. Deploy Implementation Subagent

Use `subagent()` to spawn a worker agent with **full task context**:

```
subagent({ agent: "worker", task: packImplTask(error, config) })
```

The task must include:
- The specific error details (file, line, message)
- Relevant type signatures / interface definitions
- The verification commands that MUST pass

The impl subagent follows TDD:
- Write a failing test that reproduces the error or tests the desired behavior
- Implement the minimal fix
- Run all required verification commands
- Only return when verification passes

If multiple errors are in unrelated modules, spawn **parallel subagents**:

```
subagent({
  tasks: [
    { agent: "worker", task: packImplTask(error1, config), worktree: true },
    { agent: "worker", task: packImplTask(error2, config), worktree: true },
  ],
})
```

### 3. Deploy Review Subagent

After the impl subagent returns, spawn a **fresh, context-free** review subagent:

```
subagent({ agent: "reviewer", task: packReviewTask(changedFiles) })
```

- Give it ONLY the list of changed files
- Do NOT include the original error, the task goal, or any context
- The reviewer must read files independently and find issues with fresh eyes
- Use a reviewer agent with read-only tools (Read, Glob, Grep)

### 4. Call loop_control

Synthesize results and call:

```
loop_control({
  status: "next",          // or "done" if goal is fully met
  summary: "...",
  implSubagents: [{...}],
  reviewFindings: [{...}],
})
```

## Guardrails

- Never spawn a review subagent with Write/Edit/Bash tools — it should only read
- Never skip review — always review after implementation
- If a subagent fails (timeout/error), retry once with a narrower scope
- If the same error persists for 5+ iterations, add a note that a fundamentally different approach is needed
