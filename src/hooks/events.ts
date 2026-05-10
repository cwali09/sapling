/**
 * NDJSON event emitter for Sapling --json mode.
 *
 * Emits structured per-turn events to process.stdout when enabled.
 * Each event is a single JSON line (NDJSON format) with a timestamp field added automatically.
 * When disabled (non-json mode), all methods are no-ops.
 *
 * Event types (consumed by an orchestrator's NDJSON parser):
 *   ready      — once after initialization
 *   turn_start — at the start of each turn (1-based)
 *   tool_start — before each tool execution
 *   tool_end   — after each tool, with duration and success
 *   turn_end   — after each LLM call, with token counts and model
 *   progress   — at meaningful milestones, with estimated percent complete and subtask label
 *   result     — when run loop exits, with outcome and summary
 *   error      — on failures, with message and classification
 *   compact    — when the v1 pipeline moves an op to status=compacted (score-driven)
 *                or status=archived (budget-driven)
 *   commitment_added    — when the ingest/commitment-track stage observes a new
 *                         commitment ID (deterministic format `c-<turn>-<n>`)
 *   commitment_resolved — when a later operation's artifacts cover all files
 *                         mentioned in a previously pending commitment
 *   pipeline_stage — verbose-only structured summary of each pipeline stage's run
 *                    (ingest, evaluate, compact, budget, render)
 */

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Emits NDJSON per-turn events to process.stdout when enabled.
 *
 * Convenience methods build the correct event shape and delegate to emit().
 * All events have a `type` discriminator and a `timestamp` ISO 8601 field injected by emit().
 */
export class EventEmitter {
	readonly enabled: boolean;

	constructor(enabled: boolean) {
		this.enabled = enabled;
	}

	/**
	 * Emit a single NDJSON event to stdout.
	 * Adds a `timestamp` field automatically.
	 * No-op if disabled.
	 */
	emit(event: Record<string, unknown>): void {
		if (!this.enabled) return;
		process.stdout.write(`${JSON.stringify({ ...event, timestamp: new Date().toISOString() })}\n`);
	}

	/** Emitted once when the agent loop begins. */
	ready(model: string, maxTurns: number, tools: string[]): void {
		this.emit({ type: "ready", model, maxTurns, tools });
	}

	/** Emitted at the start of each turn (1-based). */
	turnStart(turn: number): void {
		this.emit({ type: "turn_start", turn });
	}

	/** Emitted before a tool call is dispatched. argsSummary is a truncated JSON of the inputs. */
	toolStart(turn: number, toolName: string, toolCallId: string, argsSummary: string): void {
		this.emit({ type: "tool_start", turn, toolName, toolCallId, argsSummary });
	}

	/** Emitted after a tool call completes. */
	toolEnd(
		turn: number,
		toolName: string,
		toolCallId: string,
		success: boolean,
		durationMs: number,
		filesModified?: string[],
		errorMessage?: string,
		outputSummary?: string,
	): void {
		this.emit({
			type: "tool_end",
			turn,
			toolName,
			toolCallId,
			success,
			durationMs,
			filesModified,
			...(errorMessage ? { errorMessage } : {}),
			...(outputSummary ? { outputSummary } : {}),
		});
	}

	/**
	 * Emitted at the end of each turn after context management runs.
	 * Token counts are cumulative totals; cache counts are from the most recent LLM response.
	 *
	 * @param contextUtilization    - Ratio of total context used (0.0–1.0).
	 * @param activeOperationId     - ID of the operation the turn ended inside (null if none).
	 * @param activeOperationScore  - Evaluator score (0.0–1.0) of the active operation at end of turn,
	 *                                or null when there is no active operation. The seed-requested
	 *                                `score` field is emitted as an alias of this value.
	 */
	turnEnd(
		turn: number,
		inputTokens: number,
		outputTokens: number,
		cacheReadTokens: number,
		cacheWriteTokens: number,
		model: string,
		contextUtilization: number,
		activeOperationId: number | null,
		activeOperationScore: number | null,
	): void {
		this.emit({
			type: "turn_end",
			turn,
			inputTokens,
			outputTokens,
			cacheReadTokens,
			cacheWriteTokens,
			model,
			contextUtilization,
			activeOperationId,
			activeOperationScore,
			score: activeOperationScore,
		});
	}

	/**
	 * Emitted at meaningful milestones to report estimated progress.
	 * @param percent - Estimated completion percentage (0–100). Can be derived from turn/maxTurns ratio.
	 * @param subtask - Human-readable description of the current activity (e.g. 'Running tests').
	 * @param filesChanged - Number of files modified so far in this run.
	 */
	progress(percent: number, subtask: string, filesChanged: number): void {
		this.emit({ type: "progress", percent, subtask, filesChanged });
	}

	/** Emitted once when the agent loop finishes (all exit paths). */
	result(
		outcome: "success" | "max_turns" | "error",
		summary: string,
		totalTurns: number,
		totalInputTokens: number,
		totalOutputTokens: number,
	): void {
		this.emit({
			type: "result",
			outcome,
			summary,
			totalTurns,
			totalInputTokens,
			totalOutputTokens,
		});
	}

	/** Emitted on LLM or unrecoverable errors. */
	error(message: string, classification: string): void {
		this.emit({ type: "error", message, classification });
	}

	/**
	 * Emitted when the v1 pipeline moves an operation out of the active
	 * history zone. Two reasons today:
	 *   - score_below_threshold: compact stage compacted the op (status → "compacted")
	 *   - budget_pressure:       budget stage archived the op (status → "archived")
	 *
	 * @param turn         - 1-based turn number that produced the decision.
	 * @param operationId  - ID of the affected operation.
	 * @param reason       - Why the op was moved.
	 * @param archivedAs   - The new operation status.
	 * @param score        - The op's evaluator score (0.0–1.0) at decision time.
	 */
	compact(
		turn: number,
		operationId: number,
		reason: "score_below_threshold" | "budget_pressure",
		archivedAs: "compacted" | "archived",
		score: number,
	): void {
		this.emit({ type: "compact", turn, operationId, reason, archivedAs, score });
	}

	/**
	 * Emitted when the v1 pipeline's commitment-track stage observes a new
	 * commitment in an operation's turn metadata.
	 *
	 * The commitment ID is deterministic (`c-<turn>-<n>`) so consumers can
	 * correlate this event with a later `commitment_resolved` event for the same ID.
	 *
	 * @param turn         - 1-based turn number that produced the decision (currentTurn).
	 * @param commitmentId - Stable commitment identity.
	 * @param text         - Verbatim commitment text.
	 * @param operationId  - ID of the operation containing the producing turn.
	 * @param producedTurn - 1-based turn number that contained the commitment text.
	 */
	commitmentAdded(
		turn: number,
		commitmentId: string,
		text: string,
		operationId: number,
		producedTurn: number,
	): void {
		this.emit({
			type: "commitment_added",
			turn,
			commitmentId,
			text,
			operationId,
			producedTurn,
		});
	}

	/**
	 * Emitted when a previously pending commitment becomes resolved — i.e. a
	 * later operation (different from the one that produced the commitment)
	 * has artifacts covering all files mentioned in the commitment text.
	 *
	 * @param turn          - 1-based turn number when the resolution was detected.
	 * @param commitmentId  - Stable commitment identity.
	 * @param resolvedBy    - { operationId, turn, files } describing what covered it.
	 */
	commitmentResolved(
		turn: number,
		commitmentId: string,
		resolvedBy: { operationId: number; turn: number; files: string[] },
	): void {
		this.emit({ type: "commitment_resolved", turn, commitmentId, resolvedBy });
	}

	/**
	 * Emitted at the end of each pipeline stage run when --verbose is on.
	 * Structured replacement for the per-stage stderr lines emitted by registry.ts.
	 *
	 * Stage-specific metadata is spread alongside the type/turn/stage fields. Consumers
	 * should treat unknown fields as forward-compatible additions.
	 *
	 * @param turn  - 1-based turn number that produced the stage execution.
	 * @param stage - Which pipeline stage just ran.
	 * @param data  - Stage-specific metadata (operation counts, scores, utilization, ...).
	 */
	pipelineStage(
		turn: number,
		stage: "ingest" | "evaluate" | "compact" | "budget" | "render" | "commitment-track",
		data: Record<string, unknown>,
	): void {
		this.emit({ type: "pipeline_stage", turn, stage, ...data });
	}
}
