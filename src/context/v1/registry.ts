/**
 * Context Pipeline v1 — Stage Registry
 *
 * StageRegistry holds an ordered list of PipelineStage instances and
 * executes them sequentially, passing a shared StageContext through each.
 *
 * Default stages: ingest → evaluate → compact → budget → render
 *
 * External callers can register, replace, or remove stages to customize
 * the pipeline without editing source.
 */

import type { Message } from "../../types.ts";
import { budget, estimateTokens } from "./budget.ts";
import { compact } from "./compact.ts";
import { evaluate } from "./evaluate.ts";
import { extractFilesFromCommitment, ingest } from "./ingest.ts";
import { render } from "./render.ts";
import type { CommitmentRecord, PipelineStage, StageContext } from "./types.ts";

export type { PipelineStage, StageContext };

// ---------------------------------------------------------------------------
// StageRegistry
// ---------------------------------------------------------------------------

export class StageRegistry {
	private stages: PipelineStage[];

	constructor(stages: PipelineStage[] = []) {
		this.stages = [...stages];
	}

	/**
	 * Append a new stage to the end of the pipeline.
	 * If a stage with the same name already exists, it is replaced in place.
	 */
	register(stage: PipelineStage): void {
		const idx = this.stages.findIndex((s) => s.name === stage.name);
		if (idx !== -1) {
			this.stages[idx] = stage;
		} else {
			this.stages.push(stage);
		}
	}

	/**
	 * Replace an existing stage by name.
	 * Throws if no stage with that name is registered.
	 */
	replace(name: string, stage: PipelineStage): void {
		const idx = this.stages.findIndex((s) => s.name === name);
		if (idx === -1) {
			throw new Error(`StageRegistry: no stage named '${name}'`);
		}
		this.stages[idx] = stage;
	}

	/**
	 * Remove a stage by name.
	 * Returns true if the stage was found and removed, false otherwise.
	 */
	remove(name: string): boolean {
		const idx = this.stages.findIndex((s) => s.name === name);
		if (idx === -1) return false;
		this.stages.splice(idx, 1);
		return true;
	}

	/**
	 * Retrieve a stage by name without removing it.
	 * Returns undefined if not found.
	 */
	get(name: string): PipelineStage | undefined {
		return this.stages.find((s) => s.name === name);
	}

	/** Returns true if a stage with the given name is registered. */
	has(name: string): boolean {
		return this.stages.some((s) => s.name === name);
	}

	/** Returns a snapshot of all registered stages in order. */
	list(): PipelineStage[] {
		return [...this.stages];
	}

	/**
	 * Execute all stages sequentially, passing ctx through each.
	 * Stages may mutate ctx (operations, activeOperationId, budgetUtil, output).
	 */
	run(ctx: StageContext): void {
		for (const stage of this.stages) {
			stage.execute(ctx);
		}
	}
}

// ---------------------------------------------------------------------------
// Default stage implementations
// ---------------------------------------------------------------------------

/** Per-stage cap on `evaluate` event payload size to bound NDJSON volume on long sessions. */
const EVALUATE_EVENT_TOP_K = 10;

/**
 * Emit a structured `pipeline_stage` event when an event sink is wired.
 * Caller already gates on `ctx.verbose`; this is a no-op when no sink is present.
 */
function emitPipelineStage(
	ctx: StageContext,
	stage: "ingest" | "evaluate" | "compact" | "budget" | "render" | "commitment-track",
	data: Record<string, unknown>,
): void {
	ctx.eventEmitter?.emit({
		type: "pipeline_stage",
		turn: ctx.currentTurn,
		stage,
		...data,
	});
}

const ingestStage: PipelineStage = {
	name: "ingest",
	execute(ctx: StageContext): void {
		const result = ingest(
			ctx.input.messages,
			ctx.operations,
			ctx.activeOperationId,
			ctx.nextOperationId ?? 1,
			ctx.tuning,
		);
		ctx.operations = result.operations;
		ctx.activeOperationId = result.activeOperationId;
		ctx.nextOperationId = result.nextOperationId;

		if (ctx.verbose) {
			const activeOp = ctx.operations.find((op) => op.id === ctx.activeOperationId);
			const activeTurns = activeOp?.turns.length ?? 0;
			console.error(
				`[pipeline-v1] ingest: ${ctx.operations.length} ops, active=${ctx.activeOperationId}, ` +
					`turns=${activeTurns}`,
			);
			emitPipelineStage(ctx, "ingest", {
				operationCount: ctx.operations.length,
				activeOperationId: ctx.activeOperationId,
				activeOperationTurns: activeTurns,
			});
		}
	},
};

/**
 * Cap on the number of registry entries the commitment-track stage retains.
 * Older `resolved` entries are evicted first so the registry stays bounded on
 * long-running sessions; pending entries are always preserved.
 */
const COMMITMENT_REGISTRY_MAX = 200;

const commitmentTrackStage: PipelineStage = {
	name: "commitment-track",
	execute(ctx: StageContext): void {
		const registry = ctx.commitmentRegistry;
		const known = new Set<string>(registry.map((r) => r.id));

		// Pass 1: register newly seen commitments and emit commitment_added.
		for (const op of ctx.operations) {
			for (const turn of op.turns) {
				const commitments = turn.meta.commitments ?? [];
				for (const c of commitments) {
					if (known.has(c.id)) continue;
					const producedTurn = turn.index + 1;
					const record: CommitmentRecord = {
						id: c.id,
						text: c.text,
						turn: producedTurn,
						operationId: op.id,
						status: "pending",
					};
					registry.push(record);
					known.add(c.id);
					ctx.eventEmitter?.emit({
						type: "commitment_added",
						turn: ctx.currentTurn,
						commitmentId: c.id,
						text: c.text,
						operationId: op.id,
						producedTurn,
					});
				}
			}
		}

		// Pass 2: detect resolutions. A commitment is resolved when an op other than
		// its source has artifacts covering every file mentioned in the commitment text.
		for (const rec of registry) {
			if (rec.status !== "pending") continue;
			const files = extractFilesFromCommitment(rec.text);
			if (files.length === 0) continue;
			for (const op of ctx.operations) {
				if (op.id === rec.operationId) continue;
				if (op.artifacts.length === 0) continue;
				const artifactSet = new Set(op.artifacts);
				if (!files.every((f) => artifactSet.has(f))) continue;
				rec.status = "resolved";
				rec.resolvedBy = {
					operationId: op.id,
					turn: ctx.currentTurn,
					files,
				};
				ctx.eventEmitter?.emit({
					type: "commitment_resolved",
					turn: ctx.currentTurn,
					commitmentId: rec.id,
					resolvedBy: rec.resolvedBy,
				});
				break;
			}
		}

		// Pass 3: cap registry size by evicting oldest resolved entries.
		if (registry.length > COMMITMENT_REGISTRY_MAX) {
			let overflow = registry.length - COMMITMENT_REGISTRY_MAX;
			for (let i = 0; i < registry.length && overflow > 0; ) {
				if (registry[i]?.status === "resolved") {
					registry.splice(i, 1);
					overflow--;
					continue;
				}
				i++;
			}
		}

		if (ctx.verbose) {
			const pending = registry.filter((r) => r.status === "pending").length;
			const resolved = registry.length - pending;
			console.error(
				`[pipeline-v1] commitment-track: ${registry.length} known (${pending} pending, ${resolved} resolved)`,
			);
			emitPipelineStage(ctx, "commitment-track", {
				totalCount: registry.length,
				pendingCount: pending,
				resolvedCount: resolved,
			});
		}
	},
};

const evaluateStage: PipelineStage = {
	name: "evaluate",
	execute(ctx: StageContext): void {
		evaluate(ctx.operations, ctx.tuning);

		if (ctx.verbose) {
			for (const op of ctx.operations) {
				console.error(
					`[pipeline-v1] evaluate: op#${op.id} (${op.type}) score=${op.score.toFixed(3)} status=${op.status}`,
				);
			}
			const topOps = [...ctx.operations]
				.sort((a, b) => b.score - a.score)
				.slice(0, EVALUATE_EVENT_TOP_K)
				.map((op) => ({
					id: op.id,
					type: op.type,
					score: op.score,
					status: op.status,
				}));
			emitPipelineStage(ctx, "evaluate", {
				operationCount: ctx.operations.length,
				operations: topOps,
				topK: EVALUATE_EVENT_TOP_K,
			});
		}
	},
};

const compactStage: PipelineStage = {
	name: "compact",
	execute(ctx: StageContext): void {
		compact(ctx.operations, ctx.activeOperationId, ctx.tuning, ctx.eventEmitter, ctx.currentTurn);

		if (ctx.verbose) {
			const compacted = ctx.operations.filter((op) => op.status === "compacted").length;
			console.error(`[pipeline-v1] compact: ${compacted} ops compacted`);
			emitPipelineStage(ctx, "compact", { compactedCount: compacted });
		}
	},
};

const budgetStage: PipelineStage = {
	name: "budget",
	execute(ctx: StageContext): void {
		const systemTokens = estimateTokens(ctx.input.systemPrompt);
		ctx.budgetUtil = budget(
			ctx.operations,
			systemTokens,
			ctx.windowSize,
			ctx.tuning,
			ctx.eventEmitter,
			ctx.currentTurn,
		);

		if (ctx.verbose) {
			const archived = ctx.operations.filter((op) => op.status === "archived").length;
			console.error(
				`[pipeline-v1] budget: utilization=${(ctx.budgetUtil.utilization * 100).toFixed(1)}%, archived=${archived}`,
			);
			emitPipelineStage(ctx, "budget", {
				utilization: ctx.budgetUtil.utilization,
				archivedCount: archived,
			});
		}
	},
};

const renderStage: PipelineStage = {
	name: "render",
	execute(ctx: StageContext): void {
		if (!ctx.budgetUtil) {
			throw new Error("render stage requires budgetUtil — run the budget stage first");
		}

		const taskMessage = ctx.input.messages[0] as Message;
		const retainedOps = ctx.operations.filter((op) => op.status !== "archived");
		const archivedOps = ctx.operations.filter((op) => op.status === "archived");

		ctx.output = render(
			taskMessage,
			retainedOps,
			archivedOps,
			ctx.input.systemPrompt,
			ctx.operations,
			ctx.activeOperationId,
			ctx.budgetUtil,
		);

		if (ctx.verbose) {
			console.error(
				`[pipeline-v1] render: ${ctx.output.messages.length} messages, ` +
					`${archivedOps.length} archive entries`,
			);
			emitPipelineStage(ctx, "render", {
				messageCount: ctx.output.messages.length,
				archiveEntryCount: archivedOps.length,
			});
		}
	},
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a StageRegistry pre-loaded with the default pipeline stages in
 * canonical order: ingest → commitment-track → evaluate → compact → budget → render.
 *
 * commitment-track runs immediately after ingest so commitment_added events fire
 * before evaluate/compact decisions reshape operations.
 */
export function createDefaultStageRegistry(): StageRegistry {
	return new StageRegistry([
		ingestStage,
		commitmentTrackStage,
		evaluateStage,
		compactStage,
		budgetStage,
		renderStage,
	]);
}
