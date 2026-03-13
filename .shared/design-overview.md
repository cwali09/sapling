# Sapling - Design Overview

Headless coding agent with proactive context management. Part of the os-eco ecosystem (Mulch, Seeds, Canopy, Overstory).

## Core Innovation

Context management as a first-class concern. Between every LLM call, a 5-stage pipeline evaluates, prunes, and reshapes what the model sees — so it operates at maximum capacity for the entire task, not just the first 20 turns.

## Entry Points

- **CLI:** `sp run <prompt>` / `sapling run <prompt>` (via `src/index.ts` Commander)
- **RPC:** `--mode rpc` enables JSON-RPC stdin control for programmatic steering
- **Unix socket:** `--rpc-socket <path>` exposes `getState` for external queries
- **NDJSON:** `--json` emits structured per-turn events on stdout

## Data Flow

```
sp run "Add validation to auth.ts"
    │
    ▼
src/index.ts → src/cli.ts (runCommand)
    │
    ├── Load: system prompt + config + guards
    ├── Wire: client + tools + context manager + hooks
    │
    ▼
src/loop.ts (runLoop) ←──── RPC channel (steer/followUp/abort)
    │
    ├── 1. Call LLM (AnthropicClient)
    ├── 2. No tool calls? → Stop (task complete)
    ├── 3. Execute tool calls in parallel (Promise.all)
    ├── 4. Run context pipeline on message array
    │       │
    │       ├── Ingest  → Parse into Turn objects
    │       ├── Evaluate → Score relevance 0–1
    │       ├── Compact  → Summarize low-scoring turns
    │       ├── Budget   → Allocate tokens across zones
    │       └── Render   → Assemble final messages
    │
    └── 5. Next turn (repeat until done or max turns)
```

## Key Abstractions

| Module | Responsibility |
|--------|---------------|
| `loop.ts` | Agent turn loop with retry, backoff, and stop conditions |
| `context/v1/pipeline.ts` | 5-stage context pipeline orchestrator |
| `context/v1/evaluate.ts` | Weighted signal scoring (recency, file overlap, errors, decisions) |
| `client/anthropic.ts` | LLM calls via Anthropic SDK with model alias resolution |
| `hooks/guards.ts` | 5 guard types: blockedTools, readOnly, pathBoundary, fileScope, blockedBashPatterns |
| `rpc/server.ts` | Programmatic agent steering (steer, followUp, abort) |
| `tools/` | 6 built-in tools: bash, read, write, edit, grep, glob |

## Dependencies

- **Runtime:** Bun >= 1.0 (runs TypeScript directly)
- **Required:** chalk, commander
- **Optional:** @anthropic-ai/sdk (dynamic import)
- **Dev:** @biomejs/biome, @types/bun, typescript

## Exit Points

- **stdout** — Task output or NDJSON events (with `--json`)
- **stderr** — Logs, timing info
- **File system** — Code changes via tools (write, edit)
- **Session log** — `.sapling/session.jsonl` for history tracking
- **RPC responses** — JSON-RPC replies on stdin/stdout or Unix socket
