# Agent Instructions — Development Paradigm

> Development conventions for this project. Based on proven workflows: design-confirm-implement → TDD → planned execution → independent review → verify-before-claim.

---

## 1. Design First (brainstorming)

All creative work (new features, components, behavior changes) must go through a design process first:

1. **Explore context** — read project files, docs, recent commits
2. **Clarify requirements** — ask questions one at a time, understand constraints and success criteria
3. **Propose approaches** — 2-3 options with trade-offs and recommendation
4. **Present design** — section by section, get user approval after each
5. **Write design doc** — save to `docs/specs/YYYY-MM-DD-<topic>-design.md`
6. **Self-review spec** — check for placeholders, contradictions, scope creep, ambiguity
7. **User reviews spec** — wait for user to read and approve before proceeding
8. **Write implementation plan** — use the `writing-plans` skill

> See the `brainstorming` skill for the full process.

**Hard gate**: No implementation code before design is presented and approved.

---

## 2. Test-Driven Development (tdd)

Every line of production code must have a failing test written first. Iron law:

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

**Red-Green-Refactor cycle**:
1. **RED** — write one minimal test that shows desired behavior
2. **Verify RED** — run the test; confirm it fails because the feature is missing (not a typo)
3. **GREEN** — write the minimal code to pass the test (no over-engineering)
4. **Verify GREEN** — run the test; confirm it passes and other tests still pass
5. **REFACTOR** — clean up while keeping tests green

**Never skip TDD for**: new features, bug fixes, refactoring, behavior changes. Exceptions (ask user first): throwaway prototypes, generated code, config files.

> See the `test-driven-development` skill.

---

## 3. Plan First (writing-plans)

Before implementing from a spec or requirements, write a detailed implementation plan:

1. **Scope check** — split into independent plans if the spec covers multiple subsystems
2. **File structure** — map every file to be created or modified, with responsibilities
3. **Bite-sized tasks** — each step is one action (2-5 min): write failing test → run to see fail → implement → run to see pass → commit
4. **Save plan** — `docs/plans/YYYY-MM-DD-<feature-name>.md`
5. **No placeholders** — every step must contain complete code and commands

> See the `writing-plans` skill.

---

## 4. Parallel & Sequential Execution (subagent-driven-development)

Prefer parallel execution for independent modules. After the plan is ready, use subagent-driven execution.

### 4.1 Task Extraction

Extract all tasks from the plan. Give each subagent:
- The full task text and context (do NOT make the subagent read the plan file)
- Relevant interfaces and type definitions
- Expected output

### 4.2 Sequential Tasks — Chain Subagents

Coupled tasks execute in a chain: one fresh subagent per task, each following TDD.

```
module/A.go → [TDD implement + self-review]
  ↓ (complete)
module/B.go → [TDD implement + self-review]
  ↓ (complete)
module/C.go → [TDD implement + self-review]
```

### 4.3 Parallel Tasks — Parallel Subagents + Worktree

Independent modules (no shared state, no sequential dependency) are developed in parallel using `worktree: true` for filesystem isolation:

```typescript
subagent({
  tasks: [
    { agent: "worker", task: "Implement module A" },
    { agent: "worker", task: "Implement module B" }
  ],
  worktree: true
})
```

**Parallel when**: modules are truly independent (different concerns, no shared types).
**Sequential when**: modules share types or have ordering dependencies.

Before parallel dispatch, use the `using-git-worktrees` skill to ensure workspaces are isolated.

> See `subagent-driven-development` and `dispatching-parallel-agents` skills.

---

## 5. Independent Code Review (requesting-code-review)

**After every completed task, spawn at least one independent code reviewer subagent.**

Review process:

1. **Spec compliance review** — does the code match the design doc / plan requirements? No extra features?
2. **Code quality review** — architecture, maintainability, error handling, test coverage

Reviewer agents use **fresh context** (do NOT inherit the current session). They inspect the repo and diff directly.

Severity levels:
- **Critical / Important** — must fix before the next task starts
- **Minor** — record for later

> See `requesting-code-review` for dispatching reviewers.
>
> When receiving review feedback, follow `receiving-code-review`: read, understand, verify, evaluate, then implement. No performative agreement.

---

## 6. Verify Before Completion (verification-before-completion)

**Before claiming anything is done, run the verification command and read the output.**

Iron law:
```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

| Claim | Requires | Not Sufficient |
|-------|----------|----------------|
| Tests pass | Test command output: 0 failures | Previous run, "should pass" |
| Build succeeds | Build command, exit 0 | Linter passing |
| Bug fixed | Test reproduces original symptom and passes | Code changed, "looks fixed" |
| Requirements met | Line-by-line checklist against the plan | Tests passing alone |

> See the `verification-before-completion` skill.

---

## 7. Branch Completion (finishing-a-development-branch)

When implementation is complete and all tests pass:

1. **Verify tests** — run full suite, confirm 0 failures
2. **Detect environment** — normal repo or git worktree?
3. **Present options** — merge locally / push and create PR / keep branch / discard
4. **Execute choice** — merge/PR/keep/cleanup accordingly

> See the `finishing-a-development-branch` skill.

---

## 8. Knowledge Sync (neat-freak)

When a phase is complete or the user asks for it (e.g., "sync up", "tidy up", "clean up"):

1. **Size check** — AGENTS.md must stay under ~300 lines / ~15KB
2. **Inventory docs** — list `docs/`, check `README.md`, `AGENTS.md`, `docs/*.md`
3. **Precise updates** — delete stale > merge duplicates > fix to absolute dates > add what is needed
4. **Cross-project check** — did this phase affect other projects' docs?
5. **Self-check** — AGENTS.md net growth ≤ 30 lines, no relative time references, no historical narrative bloat

**Red line**: No historical narratives in AGENTS.md ("Since X date Y is live"). Only rules the next AI must see when writing code.

> See the `neat-freak` skill.

---

## 9. Systematic Debugging (systematic-debugging)

When encountering bugs or test failures, find the root cause before attempting fixes:

1. Read error messages and full stack trace carefully
2. Reproduce consistently — determine exact trigger conditions
3. Check recent changes — `git diff`, recent commits
4. Multi-component systems: add diagnostic logging at each layer boundary to locate the failing component
5. Once root cause is found: write a reproduction test (TDD Red), then implement the fix

> See the `systematic-debugging` skill.

---

## 10. Execution Mode Quick Reference

| Scenario | Approach | Key Skill |
|----------|----------|-----------|
| New feature design | Guided conversation → spec doc | `brainstorming` |
| Simple coupled implementation | Chain subagents one task at a time | `subagent-driven-development` |
| Multiple independent modules | Parallel subagents + worktree isolation | `dispatching-parallel-agents` |
| After each task completes | Fresh-context reviewer inspects result | `requesting-code-review` |
| Before implementing from spec | Write a plan document | `writing-plans` |
| Branch done, all tests pass | Verify → present merge/PR options | `finishing-a-development-branch` |
| Phase complete, tidy up | Trim → inventory → update | `neat-freak` |
| Bug or test failure | Root cause → reproduction test → fix | `systematic-debugging` + `tdd` |
