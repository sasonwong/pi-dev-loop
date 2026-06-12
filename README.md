# pi-dev-loop

Autonomous development loop engine for [pi](https://github.com/earendil-works/pi-coding-agent) — verify-driven iteration with subagent isolation and error tracking.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Architecture

Three-layer isolation:

```
┌─ Orchestrator (main session) ───────────────────┐
│  Tracks error registry, dispatches work,         │
│  never writes code directly.                     │
├─ Impl Subagents (forked) ───────────────────────┤
│  Follow TDD: failing test → implement → verify   │
├─ Review Subagents (fresh, read-only) ───────────┤
│  Independently evaluate code with zero context   │
└──────────────────────────────────────────────────┘
```

## Quick Start

Start a loop from conversation (the agent picks it up):
```
loop_start({ goal: "Fix type errors in src/user.ts" })
```

Or via commands:
```
/loop goal "Implement registration module" --verify "bun run typecheck" --verify "bun run test"
```

## Subcommands

| Command | Description |
|---------|-------------|
| `/loop goal <desc> [options]` | Start a verification-driven loop |
| `/loop stop` | Stop active loop |
| `/loop pause` | Pause loop (preserve state) |
| `/loop resume` | Resume paused loop |
| `/loop status` | Show loop state + error registry |
| `/loop history` | Show iteration history |

Options for `/loop goal`:
- `--verify <cmd>` — add verification command (repeatable)
- `--max-iterations <N>` — max iterations before auto-pause (default 20)
- `--from-config [path]` — load `.pidev.yml`

## Config File (`.pidev.yml`)

```yaml
loop:
  mode: goal
  maxIterations: 20
  maxConsecutiveZeroProgress: 3

verify:
  - command: "bun run typecheck"
    runsOn: impl
  - command: "bun run test -- --related={files}"
    runsOn: impl
    timeout: 120000

guardrails:
  gitAutoSnapshot: true
  rollbackOnRegression: true
  maxFileChangesPerSubagent: 20
```

## Verification-Driven Stopping

Unlike pure LLM-judged loops, pi-dev-loop **requires** verification commands to pass before advancing. Errors are tracked across iterations with SHA-256 fingerprinting, detecting:

- **Regressed errors** — previously fixed errors that reappeared
- **New errors** — introduced by the current iteration's changes
- **Persistent errors** — unresolved across multiple iterations

## Project Layout

```
pi-dev-loop/
├── src/                     # Core modules
│   ├── state.ts             # DevLoopState, ErrorRecord types + serialization
│   ├── error-registry.ts    # Fingerprinting, mergeRegistry, parseOutput
│   ├── verify-config.ts     # --verify arg parsing, mergeConfigs
│   ├── load-config.ts       # .pidev.yml parsing
│   ├── git.ts               # Snapshot, rollback, pruning
│   ├── subagent-task.ts      # Context packing for impl/review subagents
│   ├── session-prompt.ts    # Iteration prompt builder
│   └── auto-detect.ts       # Auto-detect verify commands from project
├── extensions/pi-dev-loop/  # pi extension entry point
│   └── index.ts             # Commands, tools, events, decision engine
├── skills/pi-dev-loop/      # Agent behavior guide
├── prompts/                 # Prompt templates
├── tests/                   # Bun test suite (86 tests)
└── docs/
    ├── specs/               # Design documents
    └── plans/               # Implementation plans
```

## Development

```bash
bun test              # Run all tests (86 tests, 196 expect calls)
bun run typecheck     # TypeScript check
```

This project follows [design-confirm-implement → TDD → planned execution → review → verify](AGENTS.md). See `docs/specs/` for design docs and `docs/plans/` for implementation plans.

## License

[MIT](LICENSE) © 2026 Sason Wong
