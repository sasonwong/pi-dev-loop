---
name: pi-dev-loop
description: "Agent behavior guide for the pi-dev-loop autonomous development loop. Use when a dev loop is active — the agent acts as an orchestrator analyzing error registry, deploying implementation subagents with full context, deploying review subagents with zero context, and calling loop_control to signal iteration completion."
---

# pi-dev-loop — Agent Behavior Guide

## Overview

When a dev loop is active, you (the main session agent) act as an **orchestrator**.
You do NOT write code directly. You analyze the error registry, delegate work, and decide on next actions.

## Requirements

The dev loop works best with a `subagent()` tool for process isolation.
Install [pi-subagents](https://github.com/nicobailon/pi-subagents) if available:

```bash
pi add npm:pi-subagents
```

Without `subagent()`, do the work directly and format results into the
`implSubagents` / `reviewFindings` structures that `loop_control` expects.

## Starting a Loop

Call the `loop_start` tool when the user wants to fix errors or make improvements:

```
loop_start({ goal: "what the user wants to fix or achieve" })
```

This auto-detects project verify commands and starts Iteration 1.
You do NOT need the user to use `/loop goal` — just call `loop_start` directly.

## Loop Structure

Each iteration follows this sequence:

### 1. Analyze Error Registry

Read the injected error registry. Prioritize by:

1. **REGRESSED ⚠** — was fixed but came back. Fix immediately.
2. **NEW** — just introduced. Usually from the previous iteration's changes.
3. **PERSIST** — been around for multiple iterations. Try a different approach.
4. **REVIEW** — code quality findings. Address after fixing active errors.

If the registry is empty (first iteration), analyze the goal and plan the initial implementation.

### 2. Fix Errors

If `subagent()` is available:

```
subagent({ agent: "worker", task: packImplTask(error, config) })
```

The impl task must include error details, relevant types, and verification commands.
Multiple unrelated errors can be delegated to parallel subagents:

```
subagent({
  tasks: [
    { agent: "worker", task: packImplTask(error1, config), worktree: true },
    { agent: "worker", task: packImplTask(error2, config), worktree: true },
  ],
})
```

If `subagent()` is not available, fix errors directly in the main session.
Follow TDD: failing test → implement → verify commands pass.

### 3. Review Changes

After fixes are applied, get a fresh-context review if `subagent()` is available:

```
subagent({ agent: "reviewer", task: packReviewTask(changedFiles) })
```

- Give it ONLY the list of changed files
- The reviewer must read files independently with fresh eyes

Without `subagent()`, self-review the diff before calling loop_control.

### 4. Call loop_control

```
loop_control({
  status: "next",          // or "done" if goal is fully met
  summary: "...",
  implSubagents: [{...}],
  reviewFindings: [{...}],
})
```

## Guardrails

- Never skip review — always review after implementation
- If a subagent fails (timeout/error), retry once with narrower scope
- If the same error persists for 5+ iterations, a fundamentally different approach is needed
