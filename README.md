# pi-dev-loop

Autonomous development loop engine for [pi](https://github.com/earendil-works/pi-coding-agent) — verify-driven iteration with error tracking and regression detection.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Prerequisites

- [pi](https://github.com/earendil-works/pi-coding-agent)
- **Subagent capability** (recommended) — the dev loop uses `subagent()` for
  process isolation. Install [pi-subagents](https://github.com/nicobailon/pi-subagents):

  ```bash
  pi add npm:pi-subagents
  ```

  Without it, the dev loop still works — the orchestrator does the work directly.

## Architecture

Three-layer isolation (with subagents):

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
/loop goal "Implement registration module"
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
- `--verify <cmd>` — add verification command (repeatable; auto-detected otherwise)
- `--max-iterations <N>` — max iterations before auto-pause (default 20)

## Verification-Driven Stopping

The dev loop **requires** verification commands to pass before advancing.
Errors are tracked across iterations with SHA-256 fingerprinting, detecting:

- **Regressed errors** — previously fixed errors that reappeared
- **New errors** — introduced by the current iteration's changes
- **Persistent errors** — unresolved across multiple iterations

The engine auto-rollbacks on regression when git snapshots are enabled.

## Project Layout

```
pi-dev-loop/
├── src/                     # Core modules
│   ├── state.ts             # DevLoopState, ErrorRecord types + serialization
│   ├── error-registry.ts    # Fingerprinting, mergeRegistry, parseOutput
│   ├── verify-config.ts     # --verify arg parsing, buildConfig
│   ├── git.ts               # Snapshot, rollback, pruning
│   ├── subagent-task.ts     # Context packing for impl/review subagents
│   ├── session-prompt.ts    # Iteration prompt builder
│   └── auto-detect.ts       # Auto-detect verify commands from project
├── extensions/pi-dev-loop/  # pi extension entry point
│   └── index.ts             # Commands, tools, events, decision engine
├── skills/pi-dev-loop/      # Agent behavior guide
├── prompts/                 # Prompt templates
├── tests/                   # Bun test suite
└── docs/
    ├── specs/               # Design documents
    └── plans/               # Implementation plans
```

## Development

```bash
bun test              # Run all tests
bun run typecheck     # TypeScript check
```

This project follows [design-confirm-implement → TDD → planned execution → review → verify](AGENTS.md).

## License

[MIT](LICENSE) © 2026 Sason Wong
