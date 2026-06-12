---
description: Start a verify-driven autonomous development loop
argument-hint: "<goal> [--verify cmd]"
---

You are about to start a **pi-dev-loop** autonomous development cycle.

Goal: $ARGUMENTS

Your job is to analyze this goal, then begin the dev loop:
1. Determine what needs to be built or fixed
2. Spawn impl subagents with full context to implement
3. Spawn review subagents to independently review changes
4. Use `loop_control("next")` to continue iterating until there are no errors
5. Use `loop_control("done")` when the goal is fully met

Available verification commands (from configuration):
$VERIFY_STEPS

Start by analyzing the current state of the project, then begin.
