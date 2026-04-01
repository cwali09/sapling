/**
 * Context Pipeline v1 — Compact stage
 *
 * Responsibilities:
 * 1. Threshold-based decision: score < COMPACTION_SCORE_THRESHOLD → compact, else keep
 * 2. Compaction: generate template-based summary, set operation status to "compacted"
 * 3. Truncation: for kept operations, truncate large tool outputs to stay within budget
 *
 * See docs/context-pipeline-v1.md §4.3.
 */

import { renderCompactSummary } from "./templates.ts";
import type { Operation, PipelineTuning, Turn } from "./types.ts";
import { COMPACTION_SCORE_THRESHOLD, TOOL_OUTPUT_TRUNCATION } from "./types.ts";

/** Characters-per-token heuristic (matches budget.ts). */
const CHARS_PER_TOKEN = 4;

/**
 * Re-estimate token count for a turn after tool output truncation.
 * Updates turn.meta.tokens so budget.ts sees the post-truncation size.
 */
function reestimateTurnTokens(turn: Turn): number {
	let tokens = 0;
	for (const block of turn.assistant.content) {
		if (block.type === "text") {
			tokens += Math.ceil(block.text.length / CHARS_PER_TOKEN);
		} else {
			// tool_use block: fixed overhead
			tokens += 20;
		}
	}
	if (turn.toolResults !== null) {
		for (const block of turn.toolResults.content as unknown[]) {
			if (
				typeof block !== "object" ||
				block === null ||
				(block as { type?: unknown }).type !== "tool_result"
			) {
				continue;
			}
			const content = (block as { content: string }).content;
			tokens += Math.ceil(content.length / CHARS_PER_TOKEN);
		}
	}
	return tokens;
}

// ---------------------------------------------------------------------------
// Tool output truncation helpers
// ---------------------------------------------------------------------------

/**
 * Truncate a string to at most maxTokens (using 4 chars/token heuristic).
 * Appends a "[... truncated ...]" marker when truncated.
 */
function truncateToTokens(content: string, maxTokens: number): string {
	const maxChars = maxTokens * 4;
	if (content.length <= maxChars) return content;
	return `${content.slice(0, maxChars)}\n[... truncated ...]`;
}

/**
 * Truncate using a head+tail line strategy.
 * Keeps the first `keepFirst` lines and last `keepLast` lines when over budget.
 * Falls back to simple char truncation if line-based strategy cannot help.
 */
function truncateWithLines(
	content: string,
	maxTokens: number,
	keepFirst: number,
	keepLast: number,
): string {
	const maxChars = maxTokens * 4;
	if (content.length <= maxChars) return content;

	const lines = content.split("\n");
	const totalLines = lines.length;

	if (totalLines <= keepFirst + keepLast) {
		// Not enough lines to apply head+tail — fall back to char truncation
		return `${content.slice(0, maxChars)}\n[... truncated ...]`;
	}

	const head = lines.slice(0, keepFirst).join("\n");
	const tail = lines.slice(totalLines - keepLast).join("\n");
	const omitted = totalLines - keepFirst - keepLast;
	return `${head}\n[... ${omitted} lines omitted ...]\n${tail}`;
}

/**
 * Truncate glob output to at most maxResults non-empty lines.
 */
function truncateGlob(content: string, maxResults = TOOL_OUTPUT_TRUNCATION.globMaxResults): string {
	const lines = content.split("\n").filter((l) => l.trim().length > 0);
	if (lines.length <= maxResults) return content;
	const kept = lines.slice(0, maxResults);
	return `${kept.join("\n")}\n[... ${lines.length - maxResults} more results ...]`;
}

/**
 * Apply tool-specific truncation to a tool result content string.
 * Tools not listed here are returned unchanged.
 *
 * @param bashMaxTokens       - Override for bash token limit (e.g. use failureBashMaxTokens for failure ops).
 * @param truncationOverrides - Optional per-field overrides from PipelineTuning.
 */
export function truncateToolOutput(
	toolName: string,
	content: string,
	bashMaxTokens = TOOL_OUTPUT_TRUNCATION.bashMaxTokens,
	truncationOverrides?: PipelineTuning["toolOutputTruncation"],
): string {
	const t = { ...TOOL_OUTPUT_TRUNCATION, ...truncationOverrides };
	switch (toolName) {
		case "bash":
			return truncateWithLines(content, bashMaxTokens, t.bashKeepFirstLines, t.bashKeepLastLines);
		case "grep":
			return truncateToTokens(content, t.grepMaxTokens);
		case "read":
			return truncateWithLines(content, t.readMaxTokens, t.readKeepFirstLines, t.readKeepLastLines);
		case "glob":
			return truncateGlob(content, truncationOverrides?.globMaxResults);
		default:
			return content;
	}
}

// ---------------------------------------------------------------------------
// Operation-level compaction
// ---------------------------------------------------------------------------

/**
 * Compact a single operation: generate a template-based summary and mark as "compacted".
 * Mutates the operation in-place.
 */
export function compactOperation(op: Operation): void {
	op.summary = renderCompactSummary(op);
	op.status = "compacted";
}

/**
 * Truncate tool outputs in all turns of a retained operation.
 *
 * For each turn, builds a map of tool_use_id → tool_name from the assistant message,
 * then truncates any tool_result content whose tool exceeds its budget.
 * Failure-outcome operations use a more aggressive bash token limit.
 * Mutates the turn messages in-place and updates turn.meta.tokens.
 */
export function truncateOperationOutputs(op: Operation, tuning?: PipelineTuning): void {
	const truncation = tuning?.toolOutputTruncation;
	// Failure operations get a tighter bash limit to prevent overflow from large test outputs
	const bashMaxTokens =
		op.outcome === "failure"
			? (truncation?.failureBashMaxTokens ?? TOOL_OUTPUT_TRUNCATION.failureBashMaxTokens)
			: (truncation?.bashMaxTokens ?? TOOL_OUTPUT_TRUNCATION.bashMaxTokens);

	for (const turn of op.turns) {
		// Build id → name map from assistant tool_use blocks
		const toolNameById = new Map<string, string>();
		for (const block of turn.assistant.content) {
			if (block.type === "tool_use") {
				toolNameById.set(block.id, block.name);
			}
		}

		// Nothing to truncate if no tool results
		if (turn.toolResults === null) continue;
		if (!Array.isArray(turn.toolResults.content)) continue;

		// Mutate each tool_result block in-place
		for (const block of turn.toolResults.content as unknown[]) {
			if (
				typeof block !== "object" ||
				block === null ||
				(block as { type?: unknown }).type !== "tool_result"
			) {
				continue;
			}

			const resultBlock = block as { type: string; tool_use_id: string; content: string };
			const toolName = toolNameById.get(resultBlock.tool_use_id);
			if (toolName === undefined) continue;

			resultBlock.content = truncateToolOutput(
				toolName,
				resultBlock.content,
				bashMaxTokens,
				truncation,
			);
		}

		// Update cached token count to reflect truncated content so budget.ts sees the real size
		turn.meta.tokens = reestimateTurnTokens(turn);
	}
}

// ---------------------------------------------------------------------------
// Stage entry point
// ---------------------------------------------------------------------------

/**
 * Compact stage: process all operations.
 *
 * - Active operations are truncated (but never compacted) to cap large tool outputs.
 * - Completed/in-progress operations with score < COMPACTION_SCORE_THRESHOLD are compacted.
 * - Operations with score >= COMPACTION_SCORE_THRESHOLD have tool outputs truncated.
 * - Already-compacted or archived operations are left unchanged.
 *
 * @param operations       - The full operation registry (mutated in-place).
 * @param activeOperationId - ID of the currently active operation (never compacted).
 */
export function compact(
	operations: Operation[],
	activeOperationId: number | null,
	tuning?: PipelineTuning,
): void {
	const threshold = tuning?.compactionScoreThreshold ?? COMPACTION_SCORE_THRESHOLD;

	for (const op of operations) {
		if (op.id === activeOperationId) {
			// Active operation: apply truncation only (never compact — it's still in progress)
			truncateOperationOutputs(op, tuning);
			continue;
		}

		// Skip already-processed states
		if (op.status === "compacted" || op.status === "archived") continue;

		if (op.score < threshold) {
			compactOperation(op);
		} else {
			truncateOperationOutputs(op, tuning);
		}
	}
}
