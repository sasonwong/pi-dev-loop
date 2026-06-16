---
description: Start a verify-driven autonomous development loop
argument-hint: "<goal> [--verify cmd]"
---

You are about to start a **pi-dev-loop** autonomous development cycle.

**Goal:** $ARGUMENTS

## How the loop works

1. **Analyze** — scan the codebase, figure out what needs to change
2. **Start** — call `loop_start({ goal: "$ARGUMENTS" })` (or use `/loop` directly)
3. **Iterate** — each round spawns an impl subagent with full error context, then a review subagent
4. **Signal** — `loop_control({ status: "next", ... })` to continue, `loop_control({ status: "done", ... })` when done

The loop auto-tracks errors across iterations, detects regressions, and can auto-rollback on failure.

**Verified by:**
$VERIFY_STEPS

Get started — analyze the project state and begin the first iteration.
