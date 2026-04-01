/**
 * Context Pipeline v1 — Evaluate stage
 *
 * Scores each operation for relevance to the current work.
 * See docs/context-pipeline-v1.md §4.2 for the full specification.
 */

import {
	EVAL_WEIGHTS,
	type EvalSignal,
	type EvalSignalContext,
	type Operation,
	type OperationType,
	type PipelineTuning,
	RECENCY_HALF_LIFE_OPS,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Individual scoring functions (exported for testability)
// ---------------------------------------------------------------------------

/**
 * Exponential decay based on how many operations ago this one ended.
 * Half-life = RECENCY_HALF_LIFE_OPS (4 ops → score halves every 4 ops).
 */
export function recencyScore(opsAgo: number): number {
	return Math.exp((-Math.log(2) * opsAgo) / RECENCY_HALF_LIFE_OPS);
}

/**
 * Jaccard similarity between the operation's files and the active operation's files.
 * Returns 0 when either set is empty.
 */
export function fileOverlapScore(opFiles: Set<string>, activeFiles: Set<string>): number {
	if (opFiles.size === 0 || activeFiles.size === 0) return 0;
	const intersection = [...opFiles].filter((f) => activeFiles.has(f)).length;
	const union = new Set([...opFiles, ...activeFiles]).size;
	return intersection / union;
}

/**
 * Binary causal dependency: 1.0 if the active operation reads files this operation
 * produced, or if the active operation explicitly lists this operation in dependsOn.
 * Otherwise 0.0.
 */
export function causalDependencyScore(op: Operation, activeOp: Operation): number {
	// Explicit dependency recorded in the operation registry
	if (activeOp.dependsOn.includes(op.id)) return 1.0;

	// Implicit: active operation touches files this operation produced
	const opArtifacts = new Set(op.artifacts);
	if (opArtifacts.size > 0) {
		for (const f of activeOp.files) {
			if (opArtifacts.has(f)) return 1.0;
		}
	}

	return 0.0;
}

/**
 * Outcome significance with a decision-content bonus.
 * Base values: failure=1.0, in_progress=0.8, partial=0.6, success=0.3.
 * +0.2 if any turn in the operation contains decision language (capped at 1.0).
 */
export function outcomeSignificanceScore(op: Operation): number {
	let base: number;
	switch (op.outcome) {
		case "failure":
			base = 1.0;
			break;
		case "in_progress":
			base = 0.8;
			break;
		case "partial":
			base = 0.6;
			break;
		case "success":
			base = 0.3;
			break;
	}

	const hasDecision = op.turns.some((t) => t.meta.hasDecision);
	return Math.min(1.0, hasDecision ? base + 0.2 : base);
}

/**
 * Operation type score: mutate > mixed > investigate > verify > explore.
 */
export function operationTypeScore(type: OperationType): number {
	switch (type) {
		case "mutate":
			return 1.0;
		case "mixed":
			return 0.8;
		case "investigate":
			return 0.7;
		case "verify":
			return 0.6;
		case "explore":
			return 0.3;
	}
}

// ---------------------------------------------------------------------------
// Signal registry
// ---------------------------------------------------------------------------

/**
 * The default set of scoring signals used by the evaluate stage.
 * Weights are taken from EVAL_WEIGHTS and sum to 1.0, so normalization is a no-op
 * for the built-in registry. Custom registries may use arbitrary relative weights.
 */
export const DEFAULT_SIGNALS: EvalSignal[] = [
	{
		name: "recency",
		weight: EVAL_WEIGHTS.recency,
		scoreFn: ({ opsAgo }: EvalSignalContext) => recencyScore(opsAgo),
	},
	{
		name: "fileOverlap",
		weight: EVAL_WEIGHTS.fileOverlap,
		scoreFn: ({ op, activeFiles }: EvalSignalContext) => fileOverlapScore(op.files, activeFiles),
	},
	{
		name: "causalDependency",
		weight: EVAL_WEIGHTS.causalDependency,
		scoreFn: ({ op, activeOp }: EvalSignalContext) =>
			activeOp !== null ? causalDependencyScore(op, activeOp) : 0,
	},
	{
		name: "outcomeSignificance",
		weight: EVAL_WEIGHTS.outcomeSignificance,
		scoreFn: ({ op }: EvalSignalContext) => outcomeSignificanceScore(op),
	},
	{
		name: "operationType",
		weight: EVAL_WEIGHTS.operationType,
		scoreFn: ({ op }: EvalSignalContext) => operationTypeScore(op.type),
	},
];

/**
 * Compute per-signal normalized weights so they sum to 1.0 regardless of the
 * raw weight values supplied in the registry.
 */
function normalizeWeights(signals: EvalSignal[]): number[] {
	const total = signals.reduce((sum, s) => sum + s.weight, 0);
	const divisor = total > 0 ? total : 1;
	return signals.map((s) => s.weight / divisor);
}

// ---------------------------------------------------------------------------
// Per-operation evaluation
// ---------------------------------------------------------------------------

/**
 * Compute a relevance score for a single operation.
 *
 * @param op        - The operation being scored.
 * @param activeOp  - The currently active operation (null when there is none).
 * @param totalOps  - Total number of operations in the registry (including active).
 * @param signals   - Signal registry to use (defaults to DEFAULT_SIGNALS).
 */
export function evaluateOperation(
	op: Operation,
	activeOp: Operation | null,
	totalOps: number,
	signals: EvalSignal[] = DEFAULT_SIGNALS,
): number {
	// opsAgo = how many operations have run since this one ended.
	// When op IS the active operation, opsAgo = 0.
	const opsAgo = activeOp !== null ? totalOps - 1 - op.id : 0;
	const activeFiles = activeOp?.files ?? new Set<string>();
	const ctx: EvalSignalContext = { op, activeOp, opsAgo, activeFiles };

	const weights = normalizeWeights(signals);
	let score = 0;
	for (let i = 0; i < signals.length; i++) {
		score += (weights[i] as number) * (signals[i] as EvalSignal).scoreFn(ctx);
	}

	return Math.min(1.0, Math.max(0.0, score));
}

// ---------------------------------------------------------------------------
// Stage entry point
// ---------------------------------------------------------------------------

/**
 * Build evaluation signals with optional tuning overrides.
 * Falls back to EVAL_WEIGHTS defaults for any unset weight.
 */
function buildSignals(tuning: PipelineTuning): EvalSignal[] {
	const w = tuning.evalWeights ?? {};
	const halfLife = tuning.recencyHalfLifeOps ?? RECENCY_HALF_LIFE_OPS;
	return [
		{
			name: "recency",
			weight: w.recency ?? EVAL_WEIGHTS.recency,
			scoreFn: ({ opsAgo }: EvalSignalContext) => Math.exp((-Math.log(2) * opsAgo) / halfLife),
		},
		{
			name: "fileOverlap",
			weight: w.fileOverlap ?? EVAL_WEIGHTS.fileOverlap,
			scoreFn: ({ op, activeFiles }: EvalSignalContext) => fileOverlapScore(op.files, activeFiles),
		},
		{
			name: "causalDependency",
			weight: w.causalDependency ?? EVAL_WEIGHTS.causalDependency,
			scoreFn: ({ op, activeOp }: EvalSignalContext) =>
				activeOp !== null ? causalDependencyScore(op, activeOp) : 0,
		},
		{
			name: "outcomeSignificance",
			weight: w.outcomeSignificance ?? EVAL_WEIGHTS.outcomeSignificance,
			scoreFn: ({ op }: EvalSignalContext) => outcomeSignificanceScore(op),
		},
		{
			name: "operationType",
			weight: w.operationType ?? EVAL_WEIGHTS.operationType,
			scoreFn: ({ op }: EvalSignalContext) => operationTypeScore(op.type),
		},
	];
}

/**
 * Evaluate stage: update the `score` field on every operation in-place.
 *
 * The active operation (status === "active") always receives the recency score
 * of 0 opsAgo (i.e. 1.0 recency), full self-overlap, and maximum causal weight.
 */
export function evaluate(operations: Operation[], tuning?: PipelineTuning): void {
	const totalOps = operations.length;
	const activeOp = operations.find((o) => o.status === "active") ?? null;

	// Build signals with tuning overrides if provided
	const signals = tuning?.evalWeights ? buildSignals(tuning) : DEFAULT_SIGNALS;

	for (const op of operations) {
		op.score = evaluateOperation(op, activeOp, totalOps, signals);
	}
}
