---
description: Start a verify-driven autonomous development loop
argument-hint: "<goal>"
---

You are about to start a **pi-dev-loop** autonomous development cycle.

**Goal:** $ARGUMENTS

## How the loop works

1. **Start** — call `loop_start({ goal: "$ARGUMENTS" })`
2. **Iterate** — each round spawns an impl subagent (or works directly), then reviews
3. **Signal** — `loop_control({ status: "next", ... })` to continue, `loop_control({ status: "done", ... })` when done

The loop auto-tracks errors across iterations, detects regressions, and auto-rollbacks on failure.

Get started — analyze the project state and begin the first iteration.
