/**
 * Context Pipeline v1 — Ingest Stage
 *
 * Responsibilities:
 * 1. Turn extraction: pair assistant+toolResults messages into Turn objects
 * 2. Boundary detection: weighted hybrid heuristic to detect operation transitions
 * 3. Operation registry management: assign turns to operations, finalize completed ones
 *
 * See docs/context-pipeline-v1.md section 4.1.
 */

import type { Message, ToolPipelineMetadata } from "../../types.ts";
import type {
	BoundarySignals,
	Commitment,
	Operation,
	OperationType,
	PipelineTuning,
	ToolPhase,
	Turn,
	TurnMetadata,
} from "./types.ts";
import {
	BOUNDARY_THRESHOLD,
	BOUNDARY_WEIGHTS,
	INTENT_PATTERNS,
	STEER_REDIRECT_PATTERNS,
	TOOL_PHASES,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Turn extraction
// ---------------------------------------------------------------------------

/**
 * Extract assistant text from a message's content blocks.
 */
function extractAssistantText(msg: Message & { role: "assistant" }): string {
	return msg.content
		.filter((b) => b.type === "text")
		.map((b) => (b.type === "text" ? b.text : ""))
		.join(" ");
}

/**
 * Extract tool names invoked in an assistant message.
 */
function extractToolNames(msg: Message & { role: "assistant" }): string[] {
	return msg.content
		.filter((b) => b.type === "tool_use")
		.map((b) => (b.type === "tool_use" ? b.name : ""));
}

/**
 * Extract file paths from tool inputs and outputs.
 * Looks for common path-shaped strings in tool_use inputs and tool_result content.
 */
function extractFilePaths(
	assistant: Message & { role: "assistant" },
	toolResults: (Message & { role: "user" }) | null,
): string[] {
	const paths = new Set<string>();
	const pathPattern = /(?:^|[\s"'`=,([{])(\/?(?:[\w.-]+\/)+[\w.-]+\.\w+)/g;

	// Extract from tool_use inputs
	for (const block of assistant.content) {
		if (block.type !== "tool_use") continue;
		const input = block.input;
		// Common path keys: path, file, filename, target
		for (const key of ["path", "file", "filename", "target"]) {
			const val = input[key];
			if (typeof val === "string" && val.length > 0) {
				paths.add(val);
			}
		}
	}

	// Extract from tool_result content strings.
	// toolResults.content is typed as string | ContentBlock[] but at runtime
	// user messages with tool results contain ToolResultBlock[] — cast via unknown.
	if (toolResults && Array.isArray(toolResults.content)) {
		for (const block of toolResults.content as unknown[]) {
			if (
				typeof block === "object" &&
				block !== null &&
				"type" in block &&
				(block as { type: unknown }).type === "tool_result"
			) {
				const content = (block as { type: string; content: string }).content;
				if (typeof content === "string") {
					for (const m of content.matchAll(pathPattern)) {
						if (m[1] !== undefined) paths.add(m[1]);
					}
				}
			}
		}
	}

	return [...paths];
}

/**
 * Detect whether any tool result was an error.
 */
function detectError(toolResults: (Message & { role: "user" }) | null): boolean {
	if (!toolResults) return false;
	if (!Array.isArray(toolResults.content)) return false;
	return toolResults.content.some(
		(b) =>
			typeof b === "object" &&
			b !== null &&
			"is_error" in b &&
			(b as { is_error?: boolean }).is_error === true,
	);
}

// ---------------------------------------------------------------------------
// Commitment extraction
// ---------------------------------------------------------------------------

/** Regex patterns for extracting future-action commitments from assistant text. */
const COMMITMENT_NUMBERED_PATTERN = /^\s*\d+[.)]\s+(.{5,150})$/gm;
const COMMITMENT_BULLET_PATTERN = /^\s*[-*]\s+(.{5,150})$/gm;
const COMMITMENT_FUTURE_PATTERN =
	/\b(?:I(?:'ll| will| need to| should| must)|(?:then |next |also )I(?:'ll| will))\s+([^.!?\n]{5,120})/gi;

/** Matches file paths and action verbs to filter relevant commitment items. */
const COMMITMENT_ACTION_PATTERN =
	/\b(?:edit|write|create|update|fix|add|remove|implement|run|test|check|modify|read|delete|rename|move|refactor)\b/i;
const COMMITMENT_FILE_PATTERN =
	/(?:[\w.-]+\/[\w.-]+|[\w.-]+\.(?:ts|js|py|go|rs|json|yaml|yml|md|css|html))/;

/** Regex to extract file paths from a commitment string. */
const FILE_IN_COMMITMENT_PATTERN =
	/(?:^|[\s"'`=,([{])(\/?(?:[\w.-]+\/)+[\w.-]+\.\w+|[\w.-]+\.(?:ts|js|py|go|rs|json|yaml|yml|md|css|html))/g;

/**
 * Extract future-action commitments from assistant text.
 * Detects numbered/bulleted action lists and future-tense promises.
 * Returns deduplicated list, capped at 20 items.
 *
 * IDs are deterministic: `c-<turnNumber>-<n>` (1-based n). The same input text +
 * turn number always yields the same IDs, so re-running the extractor across
 * pipeline cycles produces stable identities.
 *
 * @param turnNumber 1-based turn number that produced this assistant text.
 */
export function extractCommitments(text: string, turnNumber: number): Commitment[] {
	const seen = new Set<string>();
	const ordered: string[] = [];

	const add = (raw: string | undefined): void => {
		if (raw === undefined) return;
		const trimmed = raw.slice(0, 120);
		if (seen.has(trimmed)) return;
		seen.add(trimmed);
		ordered.push(trimmed);
	};

	// Numbered lists: "1. edit foo.ts"
	for (const match of text.matchAll(COMMITMENT_NUMBERED_PATTERN)) {
		const item = match[1]?.trim();
		if (item && (COMMITMENT_ACTION_PATTERN.test(item) || COMMITMENT_FILE_PATTERN.test(item))) {
			add(item);
		}
	}

	// Bulleted lists: "- edit foo.ts"
	for (const match of text.matchAll(COMMITMENT_BULLET_PATTERN)) {
		const item = match[1]?.trim();
		if (item && (COMMITMENT_ACTION_PATTERN.test(item) || COMMITMENT_FILE_PATTERN.test(item))) {
			add(item);
		}
	}

	// Future-tense promises: "I'll edit foo.ts", "I need to run tests"
	for (const match of text.matchAll(COMMITMENT_FUTURE_PATTERN)) {
		const action = match[1]?.trim();
		if (action && action.length >= 5) {
			add(action);
		}
	}

	return ordered
		.slice(0, 20)
		.map((textValue, idx) => ({ id: `c-${turnNumber}-${idx + 1}`, text: textValue }));
}

/**
 * Extract file paths mentioned in a commitment text.
 */
export function extractFilesFromCommitment(commitmentText: string): string[] {
	const files: string[] = [];
	for (const match of commitmentText.matchAll(FILE_IN_COMMITMENT_PATTERN)) {
		if (match[1] !== undefined) files.push(match[1]);
	}
	return files;
}

/**
 * Compute pending commitments for an operation at finalization time.
 * A commitment is "pending" if:
 *   - It mentions file paths that are not in op.artifacts (the file was never modified), OR
 *   - It has no file paths and comes from the last turn (general unresolved promise).
 * Returns empty list if outcome is "success" (all work completed).
 */
export function computePendingCommitments(op: Operation): Commitment[] {
	if (op.outcome === "success") return [];

	const artifactSet = new Set(op.artifacts);
	const pending: Commitment[] = [];
	const seenIds = new Set<string>();
	const lastTurnIds = new Set<string>(
		(op.turns[op.turns.length - 1]?.meta.commitments ?? []).map((c) => c.id),
	);

	for (const turn of op.turns) {
		for (const commitment of turn.meta.commitments ?? []) {
			if (seenIds.has(commitment.id)) continue;
			const mentionedFiles = extractFilesFromCommitment(commitment.text);
			if (mentionedFiles.length > 0) {
				// Pending if any mentioned file was not produced as an artifact
				if (mentionedFiles.some((f) => !artifactSet.has(f))) {
					pending.push(commitment);
					seenIds.add(commitment.id);
				}
			} else if (lastTurnIds.has(commitment.id)) {
				// Non-file commitment from the last turn — include as-is
				pending.push(commitment);
				seenIds.add(commitment.id);
			}
		}
	}

	return pending.slice(0, 10);
}

/**
 * Detect whether the assistant text contains decision language.
 */
function detectDecision(text: string): boolean {
	const decisionPattern =
		/\b(?:I(?:'ll| will| should| must| need to) (?:implement|create|add|remove|use|change|update|fix|refactor)|(?:the (?:best|right|correct) approach|decision is|choosing|going with))\b/i;
	return decisionPattern.test(text);
}

/**
 * Estimate token count using the 4 chars/token heuristic.
 */
function estimateTokens(msg: Message): number {
	const text = JSON.stringify(msg.content);
	return Math.ceil(text.length / 4);
}

/**
 * Build TurnMetadata from an assistant message and its tool results.
 *
 * `turnNumber` is the 1-based turn number used to mint stable commitment IDs of the
 * form `c-<turnNumber>-<n>`. extractTurns() passes (0-based index + 1).
 */
function extractTurnMetadata(
	assistant: Message & { role: "assistant" },
	toolResults: (Message & { role: "user" }) | null,
	turnNumber: number,
): TurnMetadata {
	const tools = extractToolNames(assistant);
	const files = extractFilePaths(assistant, toolResults);
	const assistantText = extractAssistantText(assistant);
	const assistantTokens = estimateTokens(assistant);
	const resultTokens = toolResults ? estimateTokens(toolResults) : 0;

	return {
		tools,
		files,
		hasError: detectError(toolResults),
		hasDecision: detectDecision(assistantText),
		tokens: assistantTokens + resultTokens,
		timestamp: Date.now(),
		commitments: extractCommitments(assistantText, turnNumber),
	};
}

/**
 * Extract Turn objects from a raw message array.
 * Pairs each assistant message with its following user message (tool results).
 * Skips non-assistant-led pairs (e.g., standalone user messages like followUp RPC injections).
 */
export function extractTurns(messages: Message[]): Turn[] {
	const turns: Turn[] = [];
	let turnIndex = 0;

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg === undefined || msg.role !== "assistant") continue;

		const assistantMsg = msg as Message & { role: "assistant" };
		const nextMsg = messages[i + 1];
		const hasResults = nextMsg !== undefined && nextMsg.role === "user";

		const toolResults = hasResults ? (nextMsg as Message & { role: "user" }) : null;
		const idx = turnIndex++;

		turns.push({
			index: idx,
			assistant: assistantMsg,
			toolResults,
			meta: extractTurnMetadata(assistantMsg, toolResults, idx + 1),
		});

		if (hasResults) i++; // skip the paired user message
	}

	return turns;
}

// ---------------------------------------------------------------------------
// Boundary detection
// ---------------------------------------------------------------------------

/**
 * Resolve the pipeline phase for a tool.
 * Checks tool metadata first; falls back to the TOOL_PHASES constant.
 * Returns undefined for tools with no phase information.
 */
export function resolveToolPhase(
	toolName: string,
	toolMetadataMap?: Map<string, ToolPipelineMetadata>,
): ToolPhase | undefined {
	const meta = toolMetadataMap?.get(toolName);
	if (meta?.phase !== undefined) return meta.phase;
	return TOOL_PHASES[toolName];
}

/**
 * Categorize a set of tool names into their ToolPhase categories.
 */
function getPhases(
	tools: Iterable<string>,
	toolMetadataMap?: Map<string, ToolPipelineMetadata>,
): Set<string> {
	const phases = new Set<string>();
	for (const t of tools) {
		const phase = resolveToolPhase(t, toolMetadataMap);
		if (phase !== undefined) phases.add(phase);
	}
	return phases;
}

/**
 * Detect tool-type transition: current turn uses phases with no overlap to prev operation's phases.
 */
export function hasToolTransition(
	prevTools: Set<string>,
	currentTools: string[],
	toolMetadataMap?: Map<string, ToolPipelineMetadata>,
): boolean {
	const prevPhases = getPhases(prevTools, toolMetadataMap);
	const currPhases = getPhases(currentTools, toolMetadataMap);
	if (prevPhases.size === 0 || currPhases.size === 0) return false;
	for (const phase of currPhases) {
		if (prevPhases.has(phase)) return false;
	}
	return true;
}

/**
 * Detect file-scope change: Jaccard similarity of turn files vs. operation files < 0.2.
 */
export function hasFileScopeChange(operationFiles: Set<string>, turnFiles: string[]): boolean {
	if (operationFiles.size === 0 || turnFiles.length === 0) return false;
	const turnSet = new Set(turnFiles);
	const intersection = [...turnSet].filter((f) => operationFiles.has(f)).length;
	const union = new Set([...operationFiles, ...turnSet]).size;
	return union > 0 && intersection / union < 0.2;
}

/**
 * Detect intent signal: assistant text contains task-transition phrases.
 */
export function hasIntentSignal(assistantText: string): boolean {
	return INTENT_PATTERNS.some((p) => p.test(assistantText));
}

/**
 * Detect steer redirect: any tool result in the turn contains a [STEER] block
 * with redirect language, indicating the agent is being redirected to a new task.
 */
export function hasSteerRedirect(toolResults: (Message & { role: "user" }) | null): boolean {
	if (!toolResults || !Array.isArray(toolResults.content)) return false;
	for (const block of toolResults.content as unknown[]) {
		if (typeof block !== "object" || block === null) continue;
		if ((block as { type: unknown }).type !== "tool_result") continue;
		const content = (block as { type: string; content: string }).content;
		if (typeof content !== "string") continue;
		// Only examine blocks that are steer injections
		if (!content.startsWith("[STEER]")) continue;
		if (STEER_REDIRECT_PATTERNS.some((p) => p.test(content))) return true;
	}
	return false;
}

/**
 * Detect temporal gap: > 30 seconds between last operation turn and current turn.
 */
export function hasTemporalGap(lastTimestamp: number, currentTimestamp: number): boolean {
	return currentTimestamp - lastTimestamp > 30_000;
}

/**
 * Compute boundary signals for a new turn relative to the active operation.
 */
export function computeBoundarySignals(activeOp: Operation, turn: Turn): BoundarySignals {
	const lastTurn = activeOp.turns[activeOp.turns.length - 1];
	const lastTimestamp = lastTurn !== undefined ? lastTurn.meta.timestamp : 0;
	const assistantText = extractAssistantText(turn.assistant);

	return {
		toolTypeTransition: hasToolTransition(activeOp.tools, turn.meta.tools),
		fileScopeChange: hasFileScopeChange(activeOp.files, turn.meta.files),
		intentSignal: hasIntentSignal(assistantText),
		temporalGap: hasTemporalGap(lastTimestamp, turn.meta.timestamp),
		steerRedirect: hasSteerRedirect(turn.toolResults),
	};
}

/**
 * Compute weighted boundary score and return whether a boundary is detected.
 * steerRedirect is an unconditional override: a steer with redirect language
 * always triggers a boundary regardless of other signals.
 */
export function detectBoundary(signals: BoundarySignals, tuning?: PipelineTuning): boolean {
	if (signals.steerRedirect) return true;
	const weights = { ...BOUNDARY_WEIGHTS, ...tuning?.boundaryWeights };
	const threshold = tuning?.boundaryThreshold ?? BOUNDARY_THRESHOLD;
	const score =
		(signals.toolTypeTransition ? weights.toolTypeTransition : 0) +
		(signals.fileScopeChange ? weights.fileScopeChange : 0) +
		(signals.intentSignal ? weights.intentSignal : 0) +
		(signals.temporalGap ? weights.temporalGap : 0);
	return score >= threshold;
}

// ---------------------------------------------------------------------------
// Operation type inference
// ---------------------------------------------------------------------------

/**
 * Infer operation type based on dominant tool usage.
 */
export function inferOperationType(
	tools: Set<string>,
	toolMetadataMap?: Map<string, ToolPipelineMetadata>,
): OperationType {
	const phases = getPhases(tools, toolMetadataMap);

	const hasWrite = phases.has("write");
	const hasVerify = phases.has("verify");
	const hasRead = phases.has("read");
	const hasSearch = phases.has("search");

	if (hasWrite && hasVerify) return "mixed";
	if (hasWrite) return "mutate";
	if (hasVerify) return "verify";
	if (hasRead || hasSearch) return "explore";
	return "explore";
}

// ---------------------------------------------------------------------------
// Outcome inference
// ---------------------------------------------------------------------------

/**
 * Infer the outcome of a completed operation.
 */
export function inferOutcome(operation: Operation): Operation["outcome"] {
	const lastTurn = operation.turns[operation.turns.length - 1];
	if (!lastTurn) return "partial";

	if (lastTurn.meta.hasError) return "failure";

	if (operation.tools.has("write") || operation.tools.has("edit")) {
		if (lastTurn.meta.tools.includes("bash") && !lastTurn.meta.hasError) return "success";
		return "partial";
	}

	return "success";
}

// ---------------------------------------------------------------------------
// Dependency computation
// ---------------------------------------------------------------------------

/**
 * Compute dependsOn IDs for a newly created operation.
 *
 * Two detection strategies:
 * 1. Artifact overlap: if a previous operation produced artifacts (via write/edit)
 *    that the new operation touches, the new op depends on that prior op.
 * 2. Investigate→fix chain: if the immediately preceding completed operation ended
 *    in failure, the new op likely exists to fix it — add it as a dependency.
 *
 * @param newOpFiles - Files touched by the first turn of the new operation.
 * @param prevOps    - All operations finalized before the new one.
 */
export function computeDependsOn(newOpFiles: Set<string>, prevOps: Operation[]): number[] {
	const deps = new Set<number>();

	// Strategy 1: file-level artifact dependency
	for (const op of prevOps) {
		if (op.artifacts.length === 0) continue;
		const opArtifacts = new Set(op.artifacts);
		for (const f of newOpFiles) {
			if (opArtifacts.has(f)) {
				deps.add(op.id);
				break;
			}
		}
	}

	// Strategy 2: investigate→fix chain
	// The last non-active operation is the one just finalized before this new op.
	let lastCompleted: Operation | undefined;
	for (let i = prevOps.length - 1; i >= 0; i--) {
		const op = prevOps[i];
		if (op !== undefined && op.status !== "active") {
			lastCompleted = op;
			break;
		}
	}
	if (lastCompleted !== undefined && lastCompleted.outcome === "failure") {
		deps.add(lastCompleted.id);
	}

	return [...deps];
}

// ---------------------------------------------------------------------------
// Operation registry management
// ---------------------------------------------------------------------------

/**
 * Create a new operation with the given first turn and explicit ID.
 */
function createOperation(turn: Turn, id: number): Operation {
	const op: Operation = {
		id,
		status: "active",
		type: inferOperationType(new Set(turn.meta.tools)),
		turns: [turn],
		files: new Set(turn.meta.files),
		tools: new Set(turn.meta.tools),
		outcome: "in_progress",
		artifacts: turn.meta.tools.some((t) => t === "write" || t === "edit")
			? [...turn.meta.files]
			: [],
		dependsOn: [],
		score: 0,
		summary: null,
		pendingCommitments: [],
		startTurn: turn.index,
		endTurn: turn.index,
	};
	return op;
}

/**
 * Add a turn to an existing operation, updating its metadata.
 */
function addTurnToOperation(op: Operation, turn: Turn): Operation {
	op.turns.push(turn);
	for (const f of turn.meta.files) op.files.add(f);
	for (const t of turn.meta.tools) op.tools.add(t);
	op.endTurn = turn.index;
	op.type = inferOperationType(op.tools);
	if (turn.meta.tools.some((t) => t === "write" || t === "edit")) {
		for (const f of turn.meta.files) {
			if (!op.artifacts.includes(f)) op.artifacts.push(f);
		}
	}
	return op;
}

/**
 * Finalize the active operation when a boundary is detected.
 */
function finalizeOperation(op: Operation): Operation {
	op.status = "completed";
	op.outcome = inferOutcome(op);
	op.pendingCommitments = computePendingCommitments(op);
	return op;
}

/**
 * IngestResult: the operation registry after ingesting a new turn.
 */
export interface IngestResult {
	/** All operations (including completed ones). */
	operations: Operation[];
	/** The ID of the currently active operation (null only when no turns have been ingested). */
	activeOperationId: number | null;
	/** The next available operation ID (instance-owned counter). */
	nextOperationId: number;
}

/**
 * Ingest a new turn into the operation registry.
 *
 * Algorithm:
 * 1. If no active operation exists, create one.
 * 2. Compute boundary signals relative to the active operation.
 * 3. If boundary detected: finalize active op, create new op with this turn.
 * 4. Otherwise: add turn to active op.
 *
 * @param nextOperationId - The next available operation ID (owned by the pipeline instance).
 */
export function ingestTurn(
	operations: Operation[],
	activeOperationId: number | null,
	turn: Turn,
	nextOperationId: number,
	tuning?: PipelineTuning,
): IngestResult {
	// No active operation — start fresh
	if (activeOperationId === null || operations.length === 0) {
		const newOp = createOperation(turn, nextOperationId);
		return {
			operations: [...operations, newOp],
			activeOperationId: newOp.id,
			nextOperationId: nextOperationId + 1,
		};
	}

	const activeIdx = operations.findIndex((op) => op.id === activeOperationId);
	if (activeIdx === -1) {
		// Active op not found — create new
		const newOp = createOperation(turn, nextOperationId);
		return {
			operations: [...operations, newOp],
			activeOperationId: newOp.id,
			nextOperationId: nextOperationId + 1,
		};
	}

	// activeIdx !== -1 is guaranteed by the check above
	// biome-ignore lint/style/noNonNullAssertion: activeIdx was just verified valid
	const activeOp = operations[activeIdx]!;
	const signals = computeBoundarySignals(activeOp, turn);
	const isBoundary = detectBoundary(signals, tuning);

	const updatedOps = [...operations];

	if (isBoundary) {
		// Finalize active operation (copy to avoid mutating the original array element)
		updatedOps[activeIdx] = finalizeOperation(Object.assign({}, activeOp));
		// Create new operation and populate dependsOn based on artifact overlap / error chain
		const newOp = createOperation(turn, nextOperationId);
		newOp.dependsOn = computeDependsOn(newOp.files, updatedOps);
		updatedOps.push(newOp);
		return {
			operations: updatedOps,
			activeOperationId: newOp.id,
			nextOperationId: nextOperationId + 1,
		};
	}

	// Add turn to active operation (copy to avoid mutating the original array element)
	updatedOps[activeIdx] = addTurnToOperation(Object.assign({}, activeOp), turn);
	return {
		operations: updatedOps,
		activeOperationId: activeOperationId,
		nextOperationId: nextOperationId,
	};
}

/**
 * Full ingest pipeline entry point.
 *
 * Given raw messages and the existing operation registry, extract new turns
 * and assign them to operations.
 *
 * This is designed to be called incrementally: pass the full message array
 * each time, and it will identify which turns are new since last ingest.
 *
 * @param nextOperationId - The next available operation ID (owned by the pipeline instance).
 */
export function ingest(
	messages: Message[],
	existingOperations: Operation[],
	activeOperationId: number | null,
	nextOperationId: number,
	tuning?: PipelineTuning,
): IngestResult {
	const allTurns = extractTurns(messages);

	// Determine how many turns are already tracked.
	// After compaction/archiving, the rendered message array has fewer turns than the raw stored
	// operation turn count:
	//   - Compacted ops render as 1 synthetic pair (not N original turns)
	//   - Archived ops render as 0 messages (moved to system prompt)
	// We must match how the Render stage emits turns, not the raw stored count.
	const trackedTurnCount = existingOperations.reduce((sum, op) => {
		if (op.status === "archived") return sum;
		if (op.status === "compacted") return sum + 1;
		return sum + op.turns.length;
	}, 0);

	// New turns are those beyond what's already tracked
	const newTurns = allTurns.slice(trackedTurnCount);

	let result: IngestResult = {
		operations: existingOperations,
		activeOperationId,
		nextOperationId,
	};

	for (const turn of newTurns) {
		result = ingestTurn(
			result.operations,
			result.activeOperationId,
			turn,
			result.nextOperationId,
			tuning,
		);
	}

	return result;
}
