# Sapling NDJSON event schema

Reference for every event type emitted on stdout under `--json`. One JSON object per line, each with a `type` discriminator and an ISO-8601 `timestamp` field added automatically.

Consumers should treat unknown event types and unknown fields as forward-compatible additions — sapling adds payload fields without bumping a schema version. See `src/hooks/events.ts` for the canonical `EventEmitter` and `src/orchestrator-surface.test.ts` for end-to-end assertions.

## Gating

| Gate | Effect |
|---|---|
| `--json` off | Every event below is suppressed; sapling writes human-readable logs only. |
| `--json` on | All events except `pipeline_stage` fire. |
| `--json --verbose` | Adds `pipeline_stage` events (one per stage per turn). |

Every payload below assumes `--json` is on. The `timestamp` field is implicit on every event and is omitted from the shapes for brevity.

## Run lifecycle

### `ready`
Fires once after initialization, before turn 1.

```json
{ "type": "ready", "model": "claude-sonnet-4-6", "maxTurns": 200, "tools": ["bash", "read", "write", "edit", "grep", "glob"] }
```

### `turn_start`
Fires at the start of each turn (1-based).

```json
{ "type": "turn_start", "turn": 1 }
```

### `turn_end`
Fires after each LLM call, after the v1 pipeline runs. Token counts are cumulative across the run; `cacheReadTokens` / `cacheWriteTokens` are from the most recent LLM response.

```json
{
  "type": "turn_end",
  "turn": 1,
  "inputTokens": 1840,
  "outputTokens": 312,
  "cacheReadTokens": 0,
  "cacheWriteTokens": 1804,
  "model": "claude-sonnet-4-6",
  "contextUtilization": 0.42,
  "activeOperationId": 3,
  "activeOperationScore": 0.78,
  "score": 0.78
}
```

- `activeOperationId` — id of the operation the turn ended inside, or `null` if there is none.
- `activeOperationScore` — evaluator score (0–1) of the active operation at end of turn, or `null`.
- `score` — alias of `activeOperationScore`. Documented for the warren V2 consumer; new consumers may prefer the unambiguous `activeOperationScore`.

### `progress`
Fires at meaningful milestones (currently every 10% of `maxTurns`).

```json
{ "type": "progress", "percent": 30, "subtask": "Running tests", "filesChanged": 4 }
```

### `result`
Fires once when the loop exits (every exit path). Last event in the stream.

```json
{
  "type": "result",
  "outcome": "success",
  "exitReason": "task_complete",
  "summary": "Read 3 files, no edits.",
  "totalTurns": 5,
  "totalInputTokens": 9100,
  "totalOutputTokens": 1240
}
```

- `outcome` ∈ `"success" | "max_turns" | "error"` (event-level outcome).
- `exitReason` ∈ `"task_complete" | "max_turns" | "error" | "aborted"` (loop-level reason).

### `error`
Fires on LLM or unrecoverable failures. Does not replace `result` — both fire on error exits.

```json
{ "type": "error", "message": "Auth failed", "classification": "AUTH_FAILED" }
```

## Tool execution

### `tool_start`
Fires before each tool call is dispatched. `argsSummary` is a truncated JSON of the tool inputs.

```json
{
  "type": "tool_start",
  "turn": 2,
  "toolName": "read",
  "toolCallId": "tc-1",
  "argsSummary": "{\"file_path\":\"src/loop.ts\"}"
}
```

### `tool_end`
Fires after each tool call returns.

```json
{
  "type": "tool_end",
  "turn": 2,
  "toolName": "edit",
  "toolCallId": "tc-2",
  "success": true,
  "durationMs": 18,
  "filesModified": ["src/loop.ts"],
  "errorMessage": "...",
  "outputSummary": "..."
}
```

- `filesModified` — array of paths for `write` / `edit`; `[]` for `bash`; omitted for read-only tools.
- `errorMessage` — present only when `success === false`.
- `outputSummary` — present when the tool returned a useful summary (truncated).

## Pipeline decisions

### `compact`
Fires when the v1 pipeline moves an operation out of the active history zone. Two reasons:

| Reason | Stage | New status |
|---|---|---|
| `score_below_threshold` | compact | `compacted` |
| `budget_pressure` | budget | `archived` |

```json
{
  "type": "compact",
  "turn": 7,
  "operationId": 3,
  "reason": "score_below_threshold",
  "archivedAs": "compacted",
  "score": 0.18
}
```

### `commitment_added`
Fires when the commitment-track stage observes a new commitment. The id is deterministic (`c-<turn>-<n>`) so consumers can correlate this with a later `commitment_resolved` for the same id.

```json
{
  "type": "commitment_added",
  "turn": 4,
  "commitmentId": "c-3-1",
  "text": "I'll add a test for src/foo.ts.",
  "operationId": 2,
  "producedTurn": 3
}
```

### `commitment_resolved`
Fires when a later operation (different from the one that produced the commitment) has artifacts covering every file mentioned in the commitment text.

```json
{
  "type": "commitment_resolved",
  "turn": 9,
  "commitmentId": "c-3-1",
  "resolvedBy": { "operationId": 5, "turn": 9, "files": ["src/foo.ts"] }
}
```

### `pipeline_stage` (verbose only)
Fires once per stage per turn, immediately after the stage finishes. Suppressed unless `--verbose` is on.

Stage names: `ingest`, `commitment-track`, `evaluate`, `compact`, `budget`, `render`. Stage-specific fields are spread alongside `type` / `turn` / `stage`.

```json
{ "type": "pipeline_stage", "turn": 1, "stage": "ingest",           "operationCount": 3, "activeOperationId": 3, "activeOperationTurns": 2 }
{ "type": "pipeline_stage", "turn": 1, "stage": "commitment-track", "totalCount": 2, "pendingCount": 1, "resolvedCount": 1 }
{ "type": "pipeline_stage", "turn": 1, "stage": "evaluate",         "operationCount": 3, "topK": 10, "operations": [{ "id": 3, "type": "...", "score": 0.78, "status": "in_progress" }] }
{ "type": "pipeline_stage", "turn": 1, "stage": "compact",          "compactedCount": 1 }
{ "type": "pipeline_stage", "turn": 1, "stage": "budget",           "utilization": 0.42, "archivedCount": 0 }
{ "type": "pipeline_stage", "turn": 1, "stage": "render",           "messageCount": 7, "archiveEntryCount": 1 }
```

`evaluate` caps its `operations` array at the top-K=10 highest-scoring ops to bound payload volume on long sessions.

## RPC `getState` response (not an NDJSON event)

`getState` is delivered over the RPC stdin channel (`--mode rpc`) or the unix socket (`--rpc-socket <path>`), not the stdout event stream. Documented here so consumers have a single reference.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "status": "working",
    "currentTool": "read",
    "pipeline": {
      "activeOperationId": 3,
      "operationCount": 5,
      "contextUtilization": 0.42,
      "archiveEntryCount": 1,
      "commitments": [
        { "id": "c-3-1", "turn": 3, "text": "...", "status": "pending" }
      ]
    }
  }
}
```

- `pipeline` is present only when the v1 pipeline is active.
- `pipeline.commitments` is most-recent-first and capped at `MAX_RPC_COMMITMENTS` (50 entries).

See `src/rpc/types.ts` for the full TypeScript shape.

## Persistence and migration

The pipeline persists to `.sapling/pipeline-state.<agent>.json` between runs. The commitment schema migrated from `string[]` to `{ id, text }[]` — old files are coerced on read by synthesizing deterministic ids, so resuming an in-flight session does not crash.

## See also

- `src/hooks/events.ts` — `EventEmitter` source of truth.
- `src/rpc/types.ts` — `getState` response shape.
- `src/orchestrator-surface.test.ts` — end-to-end assertions.
- `docs/orchestrator-migration.md` — migration note for consumers that previously relied on sapling shelling out.
- `sapling/CLAUDE.md` § "Orchestrator integration surface" — surface index.
