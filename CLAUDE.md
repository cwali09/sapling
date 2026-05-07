# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Sapling

Sapling (`@os-eco/sapling-cli`, CLI: `sp` / `sapling`) is a headless coding agent with proactive context management. Its core innovation is an inter-turn context pipeline that evaluates, prunes, and reshapes what the LLM sees between every turn. Part of the os-eco ecosystem (Mulch, Seeds, Canopy, Overstory).

## Build & Test Commands

All commands use **Bun** as the runtime. There is no build/compile step — TypeScript runs directly.

```bash
bun test                  # Run all 792 tests (39 files, 2451 expect() calls)
bun test src/loop.test.ts # Run a single test file
bun run lint              # Lint (Biome)
bun run lint:fix          # Lint + auto-fix
bun run typecheck         # TypeScript strict check (tsc --noEmit)
```

Quality gate before finishing work: `bun test && bun run lint && bun run typecheck`

## Architecture

### Entry flow

`src/index.ts` (Commander CLI) → `src/cli.ts` (`runCommand()`) → `src/loop.ts` (`runLoop()`)

`runCommand()` wires together: system prompt → LLM client → tool registry → context manager → agent loop.

### Agent loop (`src/loop.ts`)

Each turn: call LLM → if no tool calls, stop → execute all tool calls in parallel (`Promise.all`) → append results → run v1 context pipeline on message array → next turn. Stops on: task complete (no tools), max turns (200), or unrecoverable error. LLM errors use exponential backoff (3 retries, immediate abort on auth/model errors).

### LLM client (`src/client/`)

**AnthropicClient** (`anthropic.ts`) — calls Anthropic SDK directly; `@anthropic-ai/sdk` is an optional dep, dynamically imported; supports `ANTHROPIC_BASE_URL` and model alias resolution. SDK is the only backend (CC and Pi backends removed).

### Context pipeline (`src/context/v1/`)

Turn-based pipeline with `SaplingPipelineV1.process()`:
1. **Ingest** (`ingest.ts`) — parses messages into paired `Turn` objects, extracts metadata (files, errors, decisions, questions, commitments, dependsOn)
2. **Evaluate** (`evaluate.ts`) — scores turns 0–1 using weighted signals via `EvalSignal` registry (recency, file overlap, error context, decisions, questions, size)
3. **Compact** (`compact.ts`) — summarizes low-scoring turns, truncates large tool outputs, surfaces pending commitments
4. **Budget** (`budget.ts`) — token allocation and enforcement across system/archive/history/current zones with dynamic rebalancing
5. **Render** (`render.ts`) — assembles final message array with archive and composed system prompt; ensures orphaned tool_use/tool_result pairs are never emitted

`StageRegistry` (`registry.ts`) — composable pipeline with register/replace/remove stage operations. Types in `types.ts`, archive templates in `templates.ts`.

### Benchmarking (`src/bench/`)

Deterministic context pipeline benchmarking: `harness.ts` runs scenarios through the pipeline, `scenarios.ts` defines 14 predefined message sequences covering common agent workloads (SHORT/10 turns, MEDIUM/30 turns, LONG/100 turns).

### Hooks (`src/hooks/`)

Guard system and event emission: `guards.ts` evaluates five guard types (blockedTools, readOnly, pathBoundary, fileScope, blockedBashPatterns) on tool calls. `manager.ts` (`HookManager`) applies pre/post tool call hooks using guard config loaded via `--guards-file`. `events.ts` (`EventEmitter`) emits structured NDJSON per-turn events in `--json` mode.

### RPC (`src/rpc/`)

JSON-RPC stdin control channel for programmatic agent steering (`--mode rpc`). `channel.ts` reads NDJSON lines from stdin and dispatches to `server.ts`. Three methods: `steer` (inject context), `followUp` (queue task), `abort` (stop loop). Types in `types.ts`. `socket.ts` (`RpcSocketServer`) exposes `getState` queries over a Unix domain socket (`--rpc-socket <path>`), independent of `--mode rpc`.

### Logging (`src/logging/`)

Structured logger (`logger.ts`) with JSON output support and color control (`color.ts`). All console output routed through the logger for `--json`/`--quiet` mode compatibility.

### CLI commands (`src/commands/`)

Subcommands registered from `src/index.ts`: `auth` (API key management in `~/.sapling/auth.json`), `config` (get/set/list/init project and home YAML configuration), `init` (scaffold `.sapling/` project directory), `completions` (shell completion scripts for bash/zsh/fish), `upgrade` (check/install latest version), `doctor` (health checks), `version` (shared version utilities). `typo.ts` provides Levenshtein-based command suggestions for unknown commands.

### Other source files

- `src/json.ts` — JSON envelope utilities (`{ success, command, ...data }` format)
- `src/session.ts` — Session history tracking (appends records to `.sapling/session.jsonl`)
- `src/test-helpers.ts` — Shared test helpers (temp dirs, mock client/tool factories)

### Tools (`src/tools/`)

Six tools registered via `createDefaultRegistry()`: `bash`, `read`, `write`, `edit`, `grep`, `glob`. All implement the `Tool` interface from `src/types.ts`.

### Agent personas (`agents/`)

Three system prompt files emitted by Canopy: **builder** (writes code), **reviewer** (reviews, no edits), **scout** (explores, no edits).

## Orchestrator integration surface

Sapling is orchestrator-agnostic: it does not call any external tool, name a specific orchestrator in source, or assume a particular runtime layout. Any orchestrator that wants to drive sapling subprocesses uses these documented surfaces:

- **NDJSON event stream (`--json`)** — per-turn structured events on stdout: `ready`, `turn_start`, `turn_end`, `tool_start`, `tool_end`, `progress`, `result`, `error`. Each line is a single JSON object with a `timestamp` field. See `src/hooks/events.ts`.
- **JSON-RPC stdin control (`--mode rpc`)** — orchestrator pushes `steer` (inject context into the current turn), `followUp` (queue a new user message), `abort` (terminate the loop) as NDJSON requests over stdin. See `src/rpc/`.
- **Unix socket state queries (`--rpc-socket <path>`)** — exposes `getState` so external tools can read live agent state (current phase, pipeline utilization) without consuming the stdin channel. See `src/rpc/socket.ts`.
- **Guards + lifecycle hooks (`--guards-file <path>`)** — `guards.json` declares `blockedTools`, `readOnly`, `pathBoundary`, `fileScope`, `blockedBashPatterns`, plus optional `eventConfig` argv hooks (`onToolStart`, `onToolEnd`, `onSessionEnd`) that fire as subprocesses. See `src/hooks/`.
- **Metrics file (`--metrics-path <path>`)** — per-turn token usage and a final `_exit` block (exit reason, total turns, cumulative tokens) written to disk. The orchestrator reads the file directly — sapling never pushes.
- **Agent labeling (`--agent-name`, `--task-id`, `SAPLING_AGENT_NAME`, `SAPLING_TASK_ID`, `SAPLING_METRICS_PATH`)** — generic labels surfaced on events and metrics; no semantics beyond identification.
- **Graceful shutdown (SIGTERM/SIGINT)** — wired to the loop's `AbortController`; final metrics + `onSessionEnd` still fire.

The end-to-end test for this surface lives at `src/orchestrator-surface.test.ts`. See `docs/orchestrator-migration.md` for the migration note covering consumers that previously relied on sapling shelling out.

## Key Conventions

- **Canonical types** live in `src/types.ts`. Sub-module `types.ts` files re-export from `../types.ts`.
- **All imports use `.ts` extensions** — e.g., `import { foo } from "./bar.ts"`.
- **No `any` types** — Biome enforces `noExplicitAny: error`. Use `unknown` with narrowing.
- **Tabs for indentation**, 100-char line width (Biome).
- **Tests are colocated** — `src/foo.test.ts` next to `src/foo.ts`. Tests use real temp directories (helpers in `src/test-helpers.ts`).
- **Error hierarchy** in `src/errors.ts`: `SaplingError` base → `ClientError`, `ToolError`, `ContextError`, `ConfigError`.
- **Config** (`src/config.ts`) three-layer cascade: env vars → project YAML (`.sapling/config.yaml`) → home YAML (`~/.sapling/config.yaml`) → defaults. Env vars: `SAPLING_MODEL`, `SAPLING_BACKEND`, `SAPLING_MAX_TURNS`, `SAPLING_CONTEXT_WINDOW`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`. Falls back to `~/.sapling/auth.json` credentials. Model alias resolution (e.g., `sonnet` → `claude-sonnet-4-6`). Default model: `MiniMax-M2.5` via MiniMax's Anthropic-compatible API.
- **Agent prompt files in `agents/`** are emitted by Canopy — do not manually edit them. Use `cn update <name>` then `cn emit`.
- **JSONL data files** (`.mulch/`, `.seeds/`, `.canopy/`) use `merge=union` git strategy (see `.gitattributes`).

<!-- mulch:start -->
## Project Expertise (Mulch)
<!-- mulch-onboard:v0.8.0 -->

This project uses [Mulch](https://github.com/jayminwest/mulch) v0.8.0 for structured expertise management.

**At the start of every session**, run:
```bash
ml prime
```

Injects project-specific conventions, patterns, decisions, failures, references, and guides into
your context. Run `ml prime --files src/foo.ts` before editing a file to load only records
relevant to that path (per-file framing, classification age, and confirmation scores included).

For monolith projects where dumping every record wastes context, set
`prime.default_mode: manifest` in `.mulch/mulch.config.yaml` (or pass `--manifest`) to emit a
quick reference + domain index. Agents then scope-load with `ml prime <domain>` or
`ml prime --files <path>`.

**Before completing your task**, record insights worth preserving — conventions discovered,
patterns applied, failures encountered, or decisions made:
```bash
ml record <domain> --type <convention|pattern|failure|decision|reference|guide> --description "..."
```

Evidence auto-populates from git (current commit + changed files). Link explicitly with
`--evidence-seeds <id>` / `--evidence-gh <id>` / `--evidence-linear <id>` / `--evidence-bead <id>`,
`--evidence-commit <sha>`, or `--relates-to <mx-id>`. Upserts of named records merge outcomes
instead of replacing them; validation failures print a copy-paste retry hint with missing fields
pre-filled.

Run `ml status` for domain health, `ml doctor` to check record integrity (add `--fix` to strip
broken file anchors), `ml --help` for the full command list. Write commands use file locking and
atomic writes, so multiple agents can record concurrently. Expertise survives `git worktree`
cleanup — `.mulch/` resolves to the main repo.

`ml prune` soft-archives stale records to `.mulch/archive/` instead of deleting them; pass
`--hard` for true deletion. Restore an archived record with `ml restore <id>`. Do not read
`.mulch/archive/` directly — those records are stale by definition. If you need historical
context, run `ml search --archived <query>`.

### Before You Finish

1. Discover what to record (shows changed files and suggests domains):
   ```bash
   ml learn
   ```
2. Store insights from this work session:
   ```bash
   ml record <domain> --type <convention|pattern|failure|decision|reference|guide> --description "..."
   ```
3. Validate and commit:
   ```bash
   ml sync
   ```
<!-- mulch:end -->

<!-- seeds:start -->
## Issue Tracking (Seeds)
<!-- seeds-onboard:v0.4.0 -->
<!-- seeds-onboard-schema:4 -->

This project uses [Seeds](https://github.com/jayminwest/seeds) v0.4.0 for git-native issue tracking.

**At the start of every session**, run:
```
sd prime
```

This injects session context: rules, command reference, and workflows. Pass `--format json|compact|markdown|plain|ids` on any command for agent-friendly output.

**Quick reference:**
- `sd ready` — Find unblocked work
- `sd search <query>` — Full-text search across titles + descriptions
- `sd create --title "..." --type task --priority 2` — Create issue
- `sd update <id> --status in_progress` — Claim work
- `sd close <id>` — Complete work
- `sd dep add <id> <depends-on>` — Add dependency between issues
- `sd sync` — Sync with git (run before pushing)

### Planning
Use `sd plan` when work is large or ambiguous enough that an LLM benefits from structured decomposition. Submit spawns one child seed per step and wires `step.blocks` into `blockedBy` dependencies.

- `sd plan templates` — List built-ins (`feature`, `bug`, `refactor`) plus custom templates
- `sd plan prompt <seed-id>` — Emit a structured prompt the LLM fills in
- `sd plan submit <seed-id> --plan <file>` — Validate + spawn child seeds
- `sd plan show <pl-id>` — View sections, children, sub-plans
- `sd plan outcome <pl-id> --result success|partial|failure` — Record outcome (storage-only)
- `sd plan review <pl-id> --by <name>` — Record reviewer (informational)

### Before You Finish
1. Close completed issues: `sd close <id>`
2. File issues for remaining work: `sd create --title "..."`
3. Sync and push: `sd sync && git push`
<!-- seeds:end -->

<!-- canopy:start -->
## Prompt Management (Canopy)
<!-- canopy-onboard-v:1 -->

This project uses [Canopy](https://github.com/jayminwest/canopy) for git-native prompt management.

**At the start of every session**, run:
```
cn prime
```

This injects prompt workflow context: commands, conventions, and common workflows.

**Quick reference:**
- `cn list` — List all prompts
- `cn render <name>` — View rendered prompt (resolves inheritance)
- `cn emit --all` — Render prompts to files
- `cn update <name>` — Update a prompt (creates new version)
- `cn sync` — Stage and commit .canopy/ changes

**Do not manually edit emitted files.** Use `cn update` to modify prompts, then `cn emit` to regenerate.
<!-- canopy:end -->
