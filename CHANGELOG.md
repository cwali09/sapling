# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.2] - 2026-05-10

### Added

#### Orchestrator Surface
- `EcosystemConfig` type (`src/types.ts`) — generic orchestrator integration config (`agentName`, `taskId`, `metricsPath`); wired through CLI flags (`--agent-name`, `--task-id`, `--metrics-path`) and env vars (`SAPLING_AGENT_NAME`, `SAPLING_TASK_ID`, `SAPLING_METRICS_PATH`)
- Per-turn metrics file writes plus a final `_exit` metrics record (exit reason, total turns, cumulative tokens) when an orchestrator config is present — orchestrator reads the file directly; sapling never pushes
- SIGTERM / SIGINT graceful shutdown — wired to the loop's `AbortController`; final metrics and `onSessionEnd` lifecycle hook still fire on termination
- `docs/event-schema.md` — full NDJSON event schema reference with payload definitions for every emitted event
- `docs/orchestrator-migration.md` — migration note for consumers that previously relied on sapling shelling out to a specific orchestrator
- `src/orchestrator-surface.test.ts` (880 lines) — comprehensive E2E tests covering NDJSON event stream, JSON-RPC stdin control, Unix socket state queries, guards/lifecycle hooks, metrics file, agent labeling, and graceful shutdown

#### Pipeline Observability
- `compact` event with reason taxonomy emitted from compact + budget stages (token-overflow, low-score, redundancy, etc.)
- `commitment_added` and `commitment_resolved` events with stable commitment IDs surfaced from the v1 ingest stage
- `pipeline_stage` events emitted under `--verbose` — per-stage diagnostic data for ingest/evaluate/compact/budget/render
- `turn_end` event extended with `activeOperationId` and `activeOperationScore` fields
- `EventEmitter` and `currentTurn` threaded through the v1 pipeline so stages can emit events with correct turn correlation
- Pipeline commitments included in RPC `getState` responses (`src/rpc/socket.ts`, `src/rpc/server.ts`)

#### Pipeline Tuning
- `PipelineTuning` interface (`src/types.ts`) — optional overrides for evaluate weights (recency, file overlap, causal dependency, outcome significance, operation type), recency half-life, boundary weights/threshold, and budget allocations
- Tuning overrides threaded through the config cascade (env → project YAML → home YAML → defaults) and wired into pipeline stage functions
- Unset tuning fields fall back to compile-time defaults from `src/context/v1/types.ts`

#### Agent Personas
- Builder system prompt rebuilt (`agents/builder.md`) and auto-loaded by `--agent-name` — running with `--agent-name builder` no longer needs `--system-prompt-file`

### Fixed
- `sp doctor` auth check now provider-aware — surfaces a remediation hint on `SDK_AUTH_FAILED` and reports configured providers from `~/.sapling/auth.json`
- `fileScope` guard correctly enforces path boundaries in conjunction with `abortSignal` (E2E test added in `src/hooks/e2e.test.ts`)
- 91 failing tests in pipeline and config resolved
- TypeScript and Biome quality gate failures from the orchestrator-surface refactor resolved
- Biome formatting in `evaluate.ts` `buildSignals`

### Changed
- **Refactor:** Sapling decoupled from any specific orchestrator — no source file references "overstory" by name; the orchestrator surface (`docs/orchestrator-migration.md`) is now generic. CLI flags use neutral names (`--agent-name`, `--task-id`, `--metrics-path`).
- `tools/grep.ts` rewritten — adds richer ripgrep flag coverage, JSON output mode, and concurrent stdout/stderr draining (287 lines changed)
- `loop.ts` extended with ecosystem hooks, abort wiring, per-turn metrics writes, and event correlation (191 lines changed)
- Test suite: 859 tests across 40 files (3076 expect() calls), up from 792/39/2451

## [0.3.1] - 2026-03-04

### Added

#### Context Pipeline Enhancements
- `StageRegistry` (`src/context/v1/registry.ts`) — composable pipeline with register, replace, and remove stage operations; default stages: ingest → evaluate → compact → budget → render
- `EvalSignal` interface and signal registry in evaluate stage for extensible scoring signals
- Operation `dependsOn` tracking via artifact overlap and error chain in ingest stage
- Commitment tracking in ingest stage — extracts pending commitments (promises, plans, next steps) from assistant messages
- Pending commitments surfaced in compact summaries and system prompt rendering
- Dynamic zone rebalancing in budget stage — redistributes unused tokens across zones instead of wasting them
- `ToolPipelineMetadata` interface on `Tool` for pipeline-stage extensibility

#### CLI Enhancements
- `--dry-run` flag on `sp run` — shows what tools would do without executing
- `--prompt-file <path>` flag on `sp run` — read prompt from file instead of positional argument
- `dryRun` property added to all six tools (bash, read, write, edit, grep, glob)

#### RPC Enhancements
- Unix domain socket server (`src/rpc/socket.ts`) — `--rpc-socket <path>` exposes `getState` queries to external tools independently of `--mode rpc`
- Steer-redirect boundary detection for RPC steers

#### Documentation
- Archive persistence design documents (`docs/`) for swarm agent restart scenarios

#### Testing
- E2e guard enforcement chain tests (`src/hooks/e2e.test.ts`)
- StageRegistry tests (`src/context/v1/registry.test.ts`)
- Template rendering tests (`src/context/v1/templates.test.ts`)
- Unix socket server tests (`src/rpc/socket.test.ts`)
- CLI `--prompt-file` tests (`src/index.test.ts`)
- Expanded ingest, evaluate, compact, budget, and render tests for new features (commitment tracking, dependsOn, rebalancing)

### Fixed
- `_nextOperationId` moved from module scope to `SaplingPipelineV1` instance — fixes shared state across concurrent pipeline instances
- Budget overflow from large failure-output turns now prevented

### Changed
- **Breaking:** CC and Pi subprocess backends removed — SDK is now the only backend; `--backend cc` and `--backend pi` no longer accepted; `src/client/cc.ts` and `src/client/pi.ts` deleted
- Default model changed to `MiniMax-M2.5` via MiniMax's Anthropic-compatible API
- Dead 5-zone `ContextBudget` type removed in favor of v1 budget model
- `.env.example` removed
- Test suite: 792 tests across 39 files (2451 expect() calls), up from 690/36/2619

## [0.3.0] - 2026-03-04

### Added

#### New CLI Commands
- `sp init` command (`src/commands/init.ts`) — scaffolds `.sapling/` project directory structure with `config.yaml` and `session.jsonl`
- `sp config` command (`src/commands/config.ts`) — get, set, list, and init project/home YAML configuration
  - Subcommands: `config get <key>`, `config set <key> <value>`, `config list`, `config init`

#### Session Tracking
- Session history logging (`src/session.ts`) — appends a record to `.sapling/session.jsonl` after each run with prompt summary, token usage, duration, model, exit reason, and turn count

#### YAML Configuration
- `loadConfig()` extended with project-level (`.sapling/config.yaml`) and home-level (`~/.sapling/config.yaml`) YAML config support
- Three-layer config cascade: env vars → project YAML → home YAML → defaults

#### Testing
- Mock-client integration tests (`src/integration.test.ts`) for real tool dispatch without API calls
- Session tracking tests (`src/session.test.ts`)
- Config command tests (`src/commands/config.test.ts`)
- Init command tests (`src/commands/init.test.ts`)
- Extended `loadConfig` tests for YAML loading (`src/config.test.ts`)
- v1 pipeline orphan-prevention tests (`src/context/v1/ingest.test.ts`, `src/context/v1/pipeline.test.ts`)

### Fixed
- Orphaned `tool_use`/`tool_result` blocks after context pipeline compaction — v1 render stage now ensures every `tool_use` has a matching `tool_result` in the output

### Changed
- **Breaking:** v0 context pipeline removed — all v0 files (`manager.ts`, `measure.ts`, `score.ts`, `prune.ts`, `archive.ts`, `reshape.ts` and their tests) deleted; `--context-pipeline` flag removed; v1 is now the only pipeline
- Agent loop (`src/loop.ts`) simplified — v0 pipeline branches and `contextPipeline` option removed
- Benchmark harness (`src/bench/harness.ts`) streamlined for v1-only operation
- v1 render stage (`src/context/v1/render.ts`) enhanced with orphan detection and session-aware system prompt composition
- Test suite: 690 tests across 36 files (2619 expect() calls), down from 744/39/2807 due to v0 test removal

## [0.2.0] - 2026-03-04

### Added

#### Context Pipeline v1
- Complete rewrite of the inter-turn context management pipeline (`src/context/v1/`)
- Five new pipeline stages replacing the v0 measure/score/prune/archive/reshape approach:
  - **Ingest** (`ingest.ts`) — parses raw messages into paired `Turn` objects with extracted metadata (files touched, errors, decisions, questions)
  - **Evaluate** (`evaluate.ts`) — scores each turn 0–1 using weighted signals (recency, file overlap, error context, decision content, unresolved questions, size penalty)
  - **Compact** (`compact.ts`) — summarizes low-scoring turns and truncates large tool outputs while preserving turn structure
  - **Budget** (`budget.ts`) — token budget allocation and enforcement across system/archive/history/current zones
  - **Render** (`render.ts`) — assembles final message array with archive block and system prompt composition
- `SaplingPipelineV1` orchestrator class with stateful per-turn processing
- Template-based archive rendering (`templates.ts`) — no LLM calls needed for summarization
- Full type system (`types.ts`) with `Turn`, `TurnMetadata`, `PipelineState`, `StageResult`, and stage-specific types
- `--context-pipeline <v0|v1>` CLI flag — v1 is the default; use `--context-pipeline v0` to fall back to the legacy pipeline
- Design document (`docs/context-pipeline-v1.md`) with architecture, stage specifications, and rationale

#### Benchmarking Expansion
- Expanded benchmark scenarios from 14 to full coverage of v1 pipeline workloads (`src/bench/scenarios.ts` — 2125 lines)
- Enhanced benchmark harness (`src/bench/harness.ts` — 638 lines) with v1 pipeline support
- Extended harness tests (`src/bench/harness.test.ts` — 538 lines)

#### Testing
- 6 new test files for v1 pipeline stages: `ingest.test.ts` (565 lines), `compact.test.ts` (498 lines), `render.test.ts` (495 lines), `budget.test.ts` (414 lines), `pipeline.test.ts` (382 lines), `evaluate.test.ts` (359 lines)
- All 60 lint warnings in scoped test files resolved

### Changed
- Agent loop (`src/loop.ts`) updated to support both v0 and v1 pipelines — v1 uses `SaplingPipelineV1.process()` with turn hints instead of `SaplingContextManager`
- `RunOptions` and `LoopOptions` extended with `contextPipeline` and `contextWindowSize` fields
- RPC server extended with pipeline-aware state reporting
- Test suite grown from 520 tests / 33 files / 1400 expects to 744 tests / 39 files / 2807 expects

## [0.1.5] - 2026-03-04

### Added

#### Auth Command
- New `sp auth` command (`src/commands/auth.ts`) for global API key management in `~/.sapling/auth.json`
- Subcommands: `auth set <provider>`, `auth show`, `auth remove <provider>`
- Supports `anthropic` and `minimax` providers with optional `--base-url` override
- Auth store wired into `loadConfig` as credential fallback when env vars are unset
- Full test coverage (`src/commands/auth.test.ts`)

#### Event System Overhaul
- Standardized NDJSON event stream for overstory `parseEvents()` compatibility
- Renamed events for consistency; added `setState` event for agent state broadcasting
- New `progress()` event for dashboard visibility of long-running operations
- `EventConfig` lifecycle hooks (`onStart`, `onEnd`) for overstory watchdog heartbeats
- All RPC requests drained per turn (not just one) for reliable multi-request handling

#### RPC Enhancements
- New `getState` RPC method for synchronous agent health queries
- `followUp` RPC injection differentiated from `steer` in the loop (no `[FOLLOWUP]` prefix)
- RPC acknowledgment events include `argsSummary` field

#### Backend Changes
- CC and Pi subprocess backends deprecated in favor of SDK-only (warnings emitted on use)
- Model alias resolution — short names like `sonnet` or `opus` resolve to full model IDs
- `ANTHROPIC_AUTH_TOKEN` supported as fallback for `ANTHROPIC_API_KEY`
- `CLAUDECODE` dead code removed from backend detection

#### Doctor
- `sp doctor` now checks auth store status and reports configured providers

#### Testing
- New auth command tests (`src/commands/auth.test.ts`) — 214 lines
- New RPC server tests for `getState` method
- New RPC channel tests for multi-request draining
- New loop tests for event lifecycle hooks and follow-up injection
- New event emitter tests for `progress()`, `setState`, and lifecycle hooks

### Fixed
- `[FOLLOWUP]` prefix no longer injected into follow-up task context (was polluting LLM input)
- Missing `argsSummary` in RPC acknowledgment events
- Auth store credential fallback wired into config loading (keys from `~/.sapling/auth.json` now used when env vars are absent)

### Changed
- Test suite grown from 470 tests / 32 files / 1273 expects to 520 tests / 33 files / 1400 expects
- Event names standardized for overstory compatibility (breaking change for `--json` consumers)
- CC and Pi backends emit deprecation warnings; SDK is now the recommended backend

## [0.1.4] - 2026-03-03

### Added

#### Guard System (Hooks)
- New `src/hooks/` module with pre/post tool call guard system
- `HookManager` (`src/hooks/manager.ts`) evaluates guard rules before and after tool execution
- Five guard evaluators (`src/hooks/guards.ts`): `blockedTools`, `readOnly`, `pathBoundary`, `fileScope`, `blockedBashPatterns`
- Rules support `block`, `warn`, and `allow` actions with tool-specific or wildcard matching
- `--guards-file <path>` CLI option to load guard configuration from a JSON file
- `GuardConfig` type added to `src/types.ts` with `IHookManager` interface

#### NDJSON Event Emission
- New `EventEmitter` class (`src/hooks/events.ts`) for structured per-turn NDJSON events in `--json` mode
- Events emitted: `started`, `turnStart`, `turnEnd`, `toolCall`, `toolResult`, `completed`
- All events include ISO 8601 `timestamp` field; no-op when `--json` is not enabled

#### JSON-RPC Control Channel
- New `--mode rpc` flag enables a JSON-RPC stdin control channel for programmatic agent steering
- Three RPC methods: `steer` (inject context), `followUp` (queue follow-up task), `abort` (stop the loop)
- NDJSON acknowledgment events emitted to stdout for each request
- New `src/rpc/` module: `channel.ts` (line reader + dispatcher), `server.ts` (request handler), `types.ts`, `index.ts`

#### Testing
- Guard evaluator tests (`src/hooks/guards.test.ts`) — 324 lines covering all five guard types
- HookManager tests (`src/hooks/manager.test.ts`) — block/warn/allow rule evaluation
- EventEmitter tests (`src/hooks/events.test.ts`) — enabled/disabled modes, all event types
- RPC channel tests (`src/rpc/channel.test.ts`) — line parsing, dispatch, error handling
- RPC server tests (`src/rpc/server.test.ts`) — steer/followUp/abort request processing
- CC backend smoke tests exposing tool dispatch failure
- Additional loop tests for guard integration and event emission

#### CI
- npm auth configured before version check in publish workflow
- ripgrep installed in CI workflows for grep tool tests

### Fixed
- `eventEmitter` field restored in `LoopOptions` alongside flattened `GuardConfig` fields — event emission was broken when guard config was added

### Changed
- Test suite grown from 358 tests / 27 files / 1081 expects to 470 tests / 32 files / 1273 expects

## [0.1.3] - 2026-03-03

### Added

#### ANTHROPIC_BASE_URL Support
- New `ANTHROPIC_BASE_URL` env var to configure compatible API providers (e.g., MiniMax)
- `apiBaseUrl` field added to `SaplingConfig` and threaded through `AnthropicClient`
- `.env.example` file with documented env vars for easy setup
- `.env` added to `.gitignore`

#### Integration Tests
- New `src/integration.test.ts` with 4 end-to-end tests using the real Anthropic SDK backend
- Tests cover: file reading, file creation, bash execution, and CLI stdout output
- Gated behind `SAPLING_INTEGRATION_TESTS=1` to avoid accidental API costs

#### Testing
- Tests for `baseURL` passthrough in `AnthropicClient`
- Tests for `ANTHROPIC_BASE_URL` config loading
- Proper env var isolation in `loadConfig` tests (save/restore pattern)

### Fixed

#### CLI Output
- Duplicate `responseText` output removed — response was being printed twice in non-JSON mode
- `responseText` now correctly emitted as a JSON `"response"` event in `--json` mode
- TTY-safe timing output — `--timing` no longer emits ANSI escape codes when stderr is not a TTY

#### SDK Backend
- `AnthropicClient` response filtering now handles unknown block types (e.g., `"thinking"`) from compatible providers instead of mapping them as `tool_use`

### Changed
- Test suite grown from 354 tests / 26 files / 1076 expects to 358 tests / 27 files / 1081 expects

## [0.1.2] - 2026-03-03

### Added

#### Pi Backend
- New `PiClient` (`src/client/pi.ts`) — multi-provider LLM backend that communicates via JSONL events with a `pi` subprocess
- `--backend pi` flag and `SAPLING_BACKEND=pi` env var support
- Full test coverage for PiClient (`src/client/pi.test.ts`)

#### New CLI Commands
- `sapling completions <bash|zsh|fish>` — generate shell completion scripts
- `sapling upgrade` — check for and install the latest version from npm (`--check` for dry run)
- `sapling doctor` — run health checks on the Sapling setup and environment
- Typo suggestions for unknown commands using Levenshtein distance

#### Branding & Color
- Brand color palette (forest green / amber / muted stone) in `src/logging/color.ts`
- Status icons (ecosystem Set D) and message helpers (`printSuccess`, `printError`, `printWarning`)
- Branded CLI help header with tool name and version

#### Output Improvements
- `--timing` flag on `run` command to display elapsed execution time on stderr
- `responseText` field added to `LoopResult` — final LLM text is now returned from the loop
- Final response text printed via stdout instead of logger, so `--quiet` doesn't suppress it
- JSON envelope redesigned: `{ success, command, ...data }` format replaces previous `{ name, version }` format

### Fixed

#### Tool Path Resolution
- `WriteTool`, `ReadTool`, and `EditTool` now resolve relative `file_path` against `cwd` instead of requiring absolute paths

#### Subprocess Reliability
- `BashTool` drains stdout/stderr concurrently with `proc.exited` to prevent pipe deadlocks
- `GrepTool` drains stdout/stderr concurrently to prevent pipe deadlocks
- `CcClient` subprocess timeout (120s default) prevents indefinite hangs on invalid model or stalled network

#### CC Backend
- Thinking text from CC backend suppressed from user-visible output (logged at debug level instead)
- `tool_result` blocks handled correctly in CC backend serializer
- `tool_result` blocks handled correctly in `estimateBlockTokens`

#### Config & Validation
- `NaN` and `Infinity` rejected for `maxTurns` and `contextWindow` in config validation
- Empty prompt, missing cwd, and missing system-prompt-file produce clean `SaplingError` messages instead of uncaught exceptions
- Env var overrides for config flags fixed

#### SDK Backend
- Client-side auth errors (missing API key) correctly classified as `SDK_AUTH_FAILED`

#### Other
- `version` command supports `--json` flag with standard JSON envelope
- `--version --json` flag combination handled before Commander parsing
- Fish completions fixed to use single `__fish_seen_subcommand_from` call

### Changed
- Test suite grown from 298 tests / 24 files / 959 expects to 354 tests / 26 files / 1076 expects
- `LlmBackend` type extended from `"cc" | "sdk"` to `"cc" | "pi" | "sdk"`
- JSON output envelope format changed from `{ name, version, ...data }` to `{ success, command, ...data }`
- Biome schema version updated for 2.4.5 compatibility

## [0.1.1] - 2026-03-02

### Added

#### Context Pipeline Enhancements
- File hash tracking (`fileHashes`) wired through the context manager for content-aware scoring
- Grep result summarization in the prune stage — large grep outputs are condensed instead of dropped
- Unresolved-question scoring signal — messages containing open questions score higher to stay in context

#### Benchmarking Harness
- New `src/bench/` module with deterministic context pipeline benchmarking
- Scenario-based test harness (`harness.ts`) with reproducible message sequences
- 14 predefined scenarios (`scenarios.ts`) covering common agent workloads
- Full test coverage for the harness itself (`harness.test.ts`)

#### SDK Backend Improvements
- SDK backend (`--backend sdk`) promoted to primary with auto-detection inside Claude Code sessions
- Error classification for Anthropic API errors (auth, rate-limit, overload, model-not-found)

#### Logging & Output
- `--json` flag now produces structured NDJSON envelope output on stdout
- All `console.*` calls routed through a structured logger (`src/logging/`)
- Logger initialization wired from CLI flags (`--verbose`, `--quiet`, `--json`)

### Fixed
- Context pruning no-op bug — history messages were not categorized as `history`, so the prune stage skipped them entirely
- Index misalignment in `pruneMessages` after dropped entries caused messages to shift incorrectly
- Consecutive user messages in `reshapeMessages` violated the Anthropic API's alternating-role requirement
- `findToolResult` type checks in `archive.ts` used wrong comparison, missing tool results
- CC client now reads the `structured_output` field from the `claude` CLI response (was silently ignoring it)
- CC client normalizes tool names to lowercase and strengthens the name directive in the system prompt
- Sapling tool definitions are now injected into the CC system prompt so the model knows its available tools

### Changed
- Test suite grown from 164 tests / 17 files / 377 expects to 298 tests / 24 files / 959 expects

## [0.1.0] - 2026-03-02

Initial release of Sapling — a headless coding agent with proactive context management.

### Added

#### Core Agent Loop
- Turn-based agent loop (`src/loop.ts`) with LLM call → tool dispatch → context management cycle
- Parallel tool execution via `Promise.all` for all tool calls in a single turn
- Exponential backoff retry (3 attempts) for transient LLM failures
- Immediate abort on unrecoverable errors (auth failures, model not found)
- Three stop conditions: task complete (no tool calls), max turns (200), unrecoverable error
- NDJSON event streaming (`--json`) and quiet mode (`--quiet`) output options

#### Context Pipeline
- Five-stage inter-turn context manager (`src/context/manager.ts`):
  - **Measure** — token budget tracking with 4-chars/token heuristic and 5-zone window split (15% system, 10% archive, 40% history, 15% current, 20% headroom)
  - **Score** — relevance scoring (0–1) per message using weighted signals: recency (0.30), file overlap (0.25), error context (0.20), decision content (0.15), size penalty (0.10)
  - **Prune** — truncate large bash output, replace stale file reads, summarize/drop low-score old messages
  - **Archive** — rolling work summary from dropped messages (template-based, no LLM call), with file modification tracking and resolved error detection
  - **Reshape** — rebuild message array: [task] → [archive] → [pruned history] → [current turn]

#### Tool System
- Six tools implementing the `Tool` interface (`src/tools/`): `bash`, `read`, `write`, `edit`, `grep`, `glob`
- Tool registry with `createDefaultRegistry()` for registration and dispatch
- Tool result metadata (token estimates, file paths, truncation flags)
- Error-safe execution: tool failures return error results rather than crashing the loop

#### LLM Backends
- **CcClient** (`src/client/cc.ts`) — spawns `claude` subprocess with `--max-turns 1`, parses structured JSON responses; uses Claude Code subscription billing
- **AnthropicClient** (`src/client/anthropic.ts`) — direct Anthropic SDK calls; `@anthropic-ai/sdk` is an optional dependency, dynamically imported

#### CLI
- `sapling run <prompt>` command with options: `--model`, `--cwd`, `--backend`, `--system-prompt-file`, `--max-turns`, `--verbose`, `--json`, `--quiet`
- `sapling version` command
- Dual binary names: `sp` (short) and `sapling` (full)
- Configuration via env vars: `SAPLING_MODEL`, `SAPLING_BACKEND`, `SAPLING_MAX_TURNS`, `SAPLING_CONTEXT_WINDOW`
- Config validation with typed error hierarchy

#### Agent Personas
- Three system prompt personas emitted by Canopy (`agents/`):
  - **Builder** — writes code, runs quality gates, follows existing patterns
  - **Reviewer** — reviews code without making edits
  - **Scout** — explores codebases without making edits

#### Project Infrastructure
- CI workflow (GitHub Actions): test, lint, typecheck on push/PR
- Publish workflow: npm publish on version tags
- Biome linting (tabs, 100-char width, `noExplicitAny: error`)
- TypeScript strict mode (`tsc --noEmit`)
- Contributing guidelines, security policy, issue/PR templates
- Mulch expertise management, Seeds issue tracking, Canopy prompt management integration

#### Testing
- 164 tests across 17 files with 377 `expect()` calls
- Colocated test files (`src/foo.test.ts` next to `src/foo.ts`)
- Real temp directory helpers (`src/test-helpers.ts`)
- Full coverage of: agent loop, context pipeline (all 5 stages), both LLM clients, all 6 tools, config validation, error hierarchy

[Unreleased]: https://github.com/jayminwest/sapling/compare/v0.3.2...HEAD
[0.3.2]: https://github.com/jayminwest/sapling/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/jayminwest/sapling/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/jayminwest/sapling/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jayminwest/sapling/compare/v0.1.5...v0.2.0
[0.1.5]: https://github.com/jayminwest/sapling/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/jayminwest/sapling/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/jayminwest/sapling/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/jayminwest/sapling/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/jayminwest/sapling/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/jayminwest/sapling/releases/tag/v0.1.0
