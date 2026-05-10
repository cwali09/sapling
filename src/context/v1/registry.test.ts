/**
 * Tests for StageRegistry — the composable stage container for the v1 pipeline.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { Message } from "../../types.ts";
import { SaplingPipelineV1 } from "./pipeline.ts";
import { createDefaultStageRegistry, StageRegistry } from "./registry.ts";
import type { PipelineInput, PipelineStage, StageContext } from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStage(name: string, fn?: (ctx: StageContext) => void): PipelineStage {
	return {
		name,
		execute: fn ?? ((_ctx) => {}),
	};
}

function makeCtx(overrides?: Partial<StageContext>): StageContext {
	return {
		input: {
			messages: [{ role: "user", content: "task" }],
			systemPrompt: "You are Sapling.",
			turnHint: { turn: 1, tools: [], files: [], hasError: false },
			usage: { inputTokens: 10, outputTokens: 5 },
		},
		windowSize: 200_000,
		verbose: false,
		currentTurn: 1,
		operations: [],
		activeOperationId: null,
		commitmentRegistry: [],
		budgetUtil: null,
		output: null,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe("StageRegistry", () => {
	describe("constructor", () => {
		it("creates an empty registry when no stages provided", () => {
			const reg = new StageRegistry();
			expect(reg.list()).toEqual([]);
		});

		it("accepts an initial list of stages", () => {
			const a = makeStage("a");
			const b = makeStage("b");
			const reg = new StageRegistry([a, b]);
			expect(reg.list()).toHaveLength(2);
		});

		it("initial list is a copy — external mutations do not affect registry", () => {
			const arr = [makeStage("a")];
			const reg = new StageRegistry(arr);
			arr.push(makeStage("b"));
			expect(reg.list()).toHaveLength(1);
		});
	});

	// -------------------------------------------------------------------------
	// register
	// -------------------------------------------------------------------------

	describe("register", () => {
		it("appends a new stage", () => {
			const reg = new StageRegistry();
			reg.register(makeStage("x"));
			expect(reg.list()).toHaveLength(1);
			expect(reg.list()[0]?.name).toBe("x");
		});

		it("replaces existing stage when name matches", () => {
			const original = makeStage("x");
			const replacement = makeStage("x");
			const reg = new StageRegistry([original]);
			reg.register(replacement);
			expect(reg.list()).toHaveLength(1);
			expect(reg.list()[0]).toBe(replacement);
		});

		it("preserves order when appending multiple stages", () => {
			const reg = new StageRegistry();
			reg.register(makeStage("a"));
			reg.register(makeStage("b"));
			reg.register(makeStage("c"));
			expect(reg.list().map((s) => s.name)).toEqual(["a", "b", "c"]);
		});
	});

	// -------------------------------------------------------------------------
	// replace
	// -------------------------------------------------------------------------

	describe("replace", () => {
		it("replaces an existing stage by name", () => {
			const reg = new StageRegistry([makeStage("a"), makeStage("b")]);
			const newB = makeStage("b");
			reg.replace("b", newB);
			expect(reg.list()[1]).toBe(newB);
			expect(reg.list()).toHaveLength(2);
		});

		it("preserves stage order when replacing", () => {
			const reg = new StageRegistry([makeStage("a"), makeStage("b"), makeStage("c")]);
			reg.replace("b", makeStage("b"));
			expect(reg.list().map((s) => s.name)).toEqual(["a", "b", "c"]);
		});

		it("throws when stage name not found", () => {
			const reg = new StageRegistry([makeStage("a")]);
			expect(() => reg.replace("missing", makeStage("missing"))).toThrow(
				"StageRegistry: no stage named 'missing'",
			);
		});
	});

	// -------------------------------------------------------------------------
	// remove
	// -------------------------------------------------------------------------

	describe("remove", () => {
		it("removes an existing stage and returns true", () => {
			const reg = new StageRegistry([makeStage("a"), makeStage("b")]);
			const result = reg.remove("a");
			expect(result).toBe(true);
			expect(reg.list()).toHaveLength(1);
			expect(reg.list()[0]?.name).toBe("b");
		});

		it("returns false when stage not found", () => {
			const reg = new StageRegistry([makeStage("a")]);
			const result = reg.remove("missing");
			expect(result).toBe(false);
			expect(reg.list()).toHaveLength(1);
		});

		it("registry is empty after removing only stage", () => {
			const reg = new StageRegistry([makeStage("a")]);
			reg.remove("a");
			expect(reg.list()).toHaveLength(0);
		});
	});

	// -------------------------------------------------------------------------
	// get / has
	// -------------------------------------------------------------------------

	describe("get", () => {
		it("returns the stage when found", () => {
			const a = makeStage("a");
			const reg = new StageRegistry([a]);
			expect(reg.get("a")).toBe(a);
		});

		it("returns undefined when not found", () => {
			const reg = new StageRegistry();
			expect(reg.get("missing")).toBeUndefined();
		});
	});

	describe("has", () => {
		it("returns true for registered stage", () => {
			const reg = new StageRegistry([makeStage("a")]);
			expect(reg.has("a")).toBe(true);
		});

		it("returns false for missing stage", () => {
			const reg = new StageRegistry();
			expect(reg.has("a")).toBe(false);
		});
	});

	// -------------------------------------------------------------------------
	// list
	// -------------------------------------------------------------------------

	describe("list", () => {
		it("returns a copy — external mutations do not affect the registry", () => {
			const reg = new StageRegistry([makeStage("a")]);
			const snapshot = reg.list();
			snapshot.push(makeStage("b"));
			expect(reg.list()).toHaveLength(1);
		});
	});

	// -------------------------------------------------------------------------
	// run
	// -------------------------------------------------------------------------

	describe("run", () => {
		it("calls each stage in order with the shared context", () => {
			const calls: string[] = [];
			const reg = new StageRegistry([
				makeStage("a", () => calls.push("a")),
				makeStage("b", () => calls.push("b")),
				makeStage("c", () => calls.push("c")),
			]);
			reg.run(makeCtx());
			expect(calls).toEqual(["a", "b", "c"]);
		});

		it("passes the same context object to all stages", () => {
			const seen: StageContext[] = [];
			const reg = new StageRegistry([
				makeStage("a", (ctx) => seen.push(ctx)),
				makeStage("b", (ctx) => seen.push(ctx)),
			]);
			const ctx = makeCtx();
			reg.run(ctx);
			expect(seen[0]).toBe(ctx);
			expect(seen[1]).toBe(ctx);
		});

		it("mutations by earlier stages are visible to later stages", () => {
			const reg = new StageRegistry([
				makeStage("a", (ctx) => {
					ctx.activeOperationId = 42;
				}),
				makeStage("b", (ctx) => {
					expect(ctx.activeOperationId).toBe(42);
				}),
			]);
			reg.run(makeCtx());
		});

		it("runs nothing when registry is empty", () => {
			const reg = new StageRegistry();
			expect(() => reg.run(makeCtx())).not.toThrow();
		});
	});
});

// ---------------------------------------------------------------------------
// createDefaultStageRegistry
// ---------------------------------------------------------------------------

describe("createDefaultStageRegistry", () => {
	it("returns a registry with the default stages in canonical order", () => {
		const reg = createDefaultStageRegistry();
		const names = reg.list().map((s) => s.name);
		expect(names).toEqual([
			"ingest",
			"commitment-track",
			"evaluate",
			"compact",
			"budget",
			"render",
		]);
	});

	it("each call returns an independent instance", () => {
		const r1 = createDefaultStageRegistry();
		const r2 = createDefaultStageRegistry();
		r1.remove("evaluate");
		expect(r2.has("evaluate")).toBe(true);
	});

	it("stages can be replaced after creation", () => {
		const reg = createDefaultStageRegistry();
		const calls: string[] = [];
		reg.replace(
			"evaluate",
			makeStage("evaluate", () => calls.push("custom-evaluate")),
		);
		// The evaluate slot now holds our custom stage
		expect(reg.get("evaluate")?.name).toBe("evaluate");
	});

	it("stages can be removed after creation", () => {
		const reg = createDefaultStageRegistry();
		reg.remove("compact");
		expect(reg.has("compact")).toBe(false);
		expect(reg.list()).toHaveLength(5);
	});
});

// ---------------------------------------------------------------------------
// pipeline_stage events (verbose-gated)
// ---------------------------------------------------------------------------

describe("default stages — pipeline_stage events", () => {
	function makeAssistantMsg(
		tools: Array<{ name: string; path?: string }>,
	): Message & { role: "assistant" } {
		return {
			role: "assistant",
			content: tools.map((t) => ({
				type: "tool_use" as const,
				id: `tu_${t.name}`,
				name: t.name,
				input: t.path ? { path: t.path } : {},
			})),
		};
	}

	function makeUserMsg(toolIds: string[]): Message & { role: "user" } {
		const blocks = toolIds.map((id) => ({
			type: "tool_result" as const,
			tool_use_id: id,
			content: "ok",
		})) as unknown as import("../../types.ts").ContentBlock[];
		return { role: "user", content: blocks };
	}

	const TASK: Message = { role: "user", content: "do work" };

	function makeInput(messages: Message[], turn: number): PipelineInput {
		return {
			messages,
			systemPrompt: "You are Sapling.",
			turnHint: { turn, tools: [], files: [], hasError: false },
			usage: { inputTokens: 10, outputTokens: 5 },
		};
	}

	function makeSink(): {
		events: Array<Record<string, unknown>>;
		emit: (e: Record<string, unknown>) => void;
	} {
		const events: Array<Record<string, unknown>> = [];
		return {
			events,
			emit(e) {
				events.push(e);
			},
		};
	}

	// Silence the verbose stderr lines so test output stays clean.
	let errorSpy: ReturnType<typeof spyOn>;
	beforeEach(() => {
		errorSpy = spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		errorSpy.mockRestore();
	});

	it("emits one pipeline_stage event per stage when verbose=true", () => {
		const sink = makeSink();
		const pipeline = new SaplingPipelineV1({
			windowSize: 200_000,
			verbose: true,
			eventEmitter: sink,
		});

		const a = makeAssistantMsg([{ name: "read", path: "src/foo.ts" }]);
		const u = makeUserMsg(["tu_read"]);
		pipeline.process(makeInput([TASK, a, u], 1));

		const stages = sink.events.filter((e) => e.type === "pipeline_stage").map((e) => e.stage);
		expect(stages).toEqual([
			"ingest",
			"commitment-track",
			"evaluate",
			"compact",
			"budget",
			"render",
		]);
	});

	it("emits zero pipeline_stage events when verbose=false", () => {
		const sink = makeSink();
		const pipeline = new SaplingPipelineV1({
			windowSize: 200_000,
			verbose: false,
			eventEmitter: sink,
		});

		const a = makeAssistantMsg([{ name: "read", path: "src/foo.ts" }]);
		const u = makeUserMsg(["tu_read"]);
		pipeline.process(makeInput([TASK, a, u], 1));

		const stageEvents = sink.events.filter((e) => e.type === "pipeline_stage");
		expect(stageEvents).toHaveLength(0);
	});

	it("stage events carry the originating turn number", () => {
		const sink = makeSink();
		const pipeline = new SaplingPipelineV1({
			windowSize: 200_000,
			verbose: true,
			eventEmitter: sink,
		});

		const a = makeAssistantMsg([{ name: "read" }]);
		const u = makeUserMsg(["tu_read"]);
		pipeline.process(makeInput([TASK, a, u], 9));

		const stageEvents = sink.events.filter((e) => e.type === "pipeline_stage");
		expect(stageEvents.length).toBe(6);
		for (const event of stageEvents) {
			expect(event.turn).toBe(9);
		}
	});

	it("ingest event carries operationCount, activeOperationId, activeOperationTurns", () => {
		const sink = makeSink();
		const pipeline = new SaplingPipelineV1({
			windowSize: 200_000,
			verbose: true,
			eventEmitter: sink,
		});

		const a = makeAssistantMsg([{ name: "read", path: "src/a.ts" }]);
		const u = makeUserMsg(["tu_read"]);
		pipeline.process(makeInput([TASK, a, u], 1));

		const ingestEvent = sink.events.find(
			(e) => e.type === "pipeline_stage" && e.stage === "ingest",
		);
		expect(ingestEvent).toBeDefined();
		expect(typeof ingestEvent?.operationCount).toBe("number");
		expect(ingestEvent?.operationCount).toBeGreaterThan(0);
		expect("activeOperationId" in (ingestEvent as object)).toBe(true);
		expect(typeof ingestEvent?.activeOperationTurns).toBe("number");
	});

	it("evaluate event carries operations array capped at top-K", () => {
		const sink = makeSink();
		const pipeline = new SaplingPipelineV1({
			windowSize: 200_000,
			verbose: true,
			eventEmitter: sink,
		});

		// Build many operations across distinct file scopes to push past top-K.
		const messages: Message[] = [TASK];
		for (let i = 0; i < 15; i++) {
			messages.push(makeAssistantMsg([{ name: "read", path: `src/file${i}.ts` }]));
			messages.push(makeUserMsg([`tu_read`]));
		}
		pipeline.process(makeInput(messages, 1));

		const evalEvent = sink.events.find(
			(e) => e.type === "pipeline_stage" && e.stage === "evaluate",
		);
		expect(evalEvent).toBeDefined();
		expect(typeof evalEvent?.operationCount).toBe("number");
		expect(Array.isArray(evalEvent?.operations)).toBe(true);
		const ops = evalEvent?.operations as Array<{ id: number; score: number }>;
		expect(ops.length).toBeLessThanOrEqual(10);
		// Ops should be sorted by score descending
		for (let i = 1; i < ops.length; i++) {
			expect(ops[i - 1]?.score).toBeGreaterThanOrEqual(ops[i]?.score ?? 0);
		}
	});

	it("compact event carries compactedCount", () => {
		const sink = makeSink();
		const pipeline = new SaplingPipelineV1({
			windowSize: 200_000,
			verbose: true,
			eventEmitter: sink,
		});

		const a = makeAssistantMsg([{ name: "read" }]);
		const u = makeUserMsg(["tu_read"]);
		pipeline.process(makeInput([TASK, a, u], 1));

		const compactEvent = sink.events.find(
			(e) => e.type === "pipeline_stage" && e.stage === "compact",
		);
		expect(compactEvent).toBeDefined();
		expect(typeof compactEvent?.compactedCount).toBe("number");
	});

	it("budget event carries utilization and archivedCount", () => {
		const sink = makeSink();
		const pipeline = new SaplingPipelineV1({
			windowSize: 200_000,
			verbose: true,
			eventEmitter: sink,
		});

		const a = makeAssistantMsg([{ name: "read" }]);
		const u = makeUserMsg(["tu_read"]);
		pipeline.process(makeInput([TASK, a, u], 1));

		const budgetEvent = sink.events.find(
			(e) => e.type === "pipeline_stage" && e.stage === "budget",
		);
		expect(budgetEvent).toBeDefined();
		expect(typeof budgetEvent?.utilization).toBe("number");
		expect(budgetEvent?.utilization).toBeGreaterThanOrEqual(0);
		expect(budgetEvent?.utilization).toBeLessThanOrEqual(1);
		expect(typeof budgetEvent?.archivedCount).toBe("number");
	});

	it("render event carries messageCount and archiveEntryCount", () => {
		const sink = makeSink();
		const pipeline = new SaplingPipelineV1({
			windowSize: 200_000,
			verbose: true,
			eventEmitter: sink,
		});

		const a = makeAssistantMsg([{ name: "read" }]);
		const u = makeUserMsg(["tu_read"]);
		pipeline.process(makeInput([TASK, a, u], 1));

		const renderEvent = sink.events.find(
			(e) => e.type === "pipeline_stage" && e.stage === "render",
		);
		expect(renderEvent).toBeDefined();
		expect(typeof renderEvent?.messageCount).toBe("number");
		expect(renderEvent?.messageCount).toBeGreaterThan(0);
		expect(typeof renderEvent?.archiveEntryCount).toBe("number");
	});

	it("does not throw when verbose=true but no eventEmitter is provided", () => {
		const pipeline = new SaplingPipelineV1({
			windowSize: 200_000,
			verbose: true,
		});

		const a = makeAssistantMsg([{ name: "read" }]);
		const u = makeUserMsg(["tu_read"]);
		expect(() => pipeline.process(makeInput([TASK, a, u], 1))).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// commitment_added / commitment_resolved events
// ---------------------------------------------------------------------------

describe("default stages — commitment events", () => {
	function makeAssistantMsgWithText(
		text: string,
		tools: Array<{ name: string; path?: string }> = [],
	): Message & { role: "assistant" } {
		return {
			role: "assistant",
			content: [
				{ type: "text" as const, text },
				...tools.map((t) => ({
					type: "tool_use" as const,
					id: `tu_${t.name}_${t.path ?? "x"}`,
					name: t.name,
					input: t.path ? { path: t.path } : {},
				})),
			],
		};
	}

	function makeUserToolResult(toolIds: string[]): Message & { role: "user" } {
		const blocks = toolIds.map((id) => ({
			type: "tool_result" as const,
			tool_use_id: id,
			content: "ok",
		})) as unknown as import("../../types.ts").ContentBlock[];
		return { role: "user", content: blocks };
	}

	function makeSink(): {
		events: Array<Record<string, unknown>>;
		emit: (e: Record<string, unknown>) => void;
	} {
		const events: Array<Record<string, unknown>> = [];
		return {
			events,
			emit(e) {
				events.push(e);
			},
		};
	}

	const TASK: Message = { role: "user", content: "do work" };

	function makeInput(messages: Message[], turn: number): PipelineInput {
		return {
			messages,
			systemPrompt: "You are Sapling.",
			turnHint: { turn, tools: [], files: [], hasError: false },
			usage: { inputTokens: 10, outputTokens: 5 },
		};
	}

	it("emits commitment_added once per new commitment with stable c-<turn>-<n> ids", () => {
		const sink = makeSink();
		const pipeline = new SaplingPipelineV1({
			windowSize: 200_000,
			eventEmitter: sink,
		});

		const a = makeAssistantMsgWithText("I'll do this:\n1. Edit src/foo.ts\n2. Edit src/bar.ts", [
			{ name: "read", path: "src/foo.ts" },
		]);
		const u = makeUserToolResult(["tu_read_src/foo.ts"]);
		pipeline.process(makeInput([TASK, a, u], 1));

		const added = sink.events.filter((e) => e.type === "commitment_added");
		expect(added.length).toBeGreaterThanOrEqual(2);
		const ids = added.map((e) => e.commitmentId);
		expect(ids).toContain("c-1-1");
		expect(ids).toContain("c-1-2");
		// Producing turn is 1-based and matches the producing turn index.
		for (const e of added) {
			expect(e.producedTurn).toBe(1);
		}

		// Re-running another turn should not re-emit added events for the same IDs.
		const a2 = makeAssistantMsgWithText("Continuing.", [{ name: "read", path: "src/foo.ts" }]);
		const u2 = makeUserToolResult(["tu_read_src/foo.ts"]);
		pipeline.process(makeInput([TASK, a, u, a2, u2], 2));

		const addedAgain = sink.events.filter(
			(e) =>
				e.type === "commitment_added" && (e.commitmentId === "c-1-1" || e.commitmentId === "c-1-2"),
		);
		expect(addedAgain.length).toBe(2);
	});

	it("emits commitment_resolved with resolvedBy when a later op covers all files", () => {
		const sink = makeSink();
		const pipeline = new SaplingPipelineV1({
			windowSize: 200_000,
			eventEmitter: sink,
		});

		// Turn 1: explore op promises an edit via a numbered list (preserves the full
		// "src/foo.ts" path; future-tense extraction stops at the first period and
		// truncates filenames).
		const a1 = makeAssistantMsgWithText("Plan:\n1. Edit src/foo.ts to add the new field", [
			{ name: "read", path: "src/foo.ts" },
		]);
		const u1 = makeUserToolResult(["tu_read_src/foo.ts"]);
		pipeline.process(makeInput([TASK, a1, u1], 1));

		// Turn 2: assistant pivots to a write op that produces src/foo.ts as an artifact.
		const a2 = makeAssistantMsgWithText("That's done. Now let me actually write those files.", [
			{ name: "write", path: "src/foo.ts" },
		]);
		const u2 = makeUserToolResult(["tu_write_src/foo.ts"]);
		pipeline.process(makeInput([TASK, a1, u1, a2, u2], 2));

		const resolved = sink.events.filter((e) => e.type === "commitment_resolved");
		expect(resolved.length).toBeGreaterThan(0);
		const sample = resolved[0];
		expect(typeof sample?.commitmentId).toBe("string");
		const resolvedBy = sample?.resolvedBy as
			| { operationId: number; turn: number; files: string[] }
			| undefined;
		expect(resolvedBy).toBeDefined();
		expect(typeof resolvedBy?.operationId).toBe("number");
		expect(resolvedBy?.turn).toBe(2);
		expect(resolvedBy?.files).toContain("src/foo.ts");

		// Registry reflects the resolution.
		const registry = pipeline.getCommitmentRegistry();
		const resolvedRecord = registry.find((r) => r.id === sample?.commitmentId);
		expect(resolvedRecord?.status).toBe("resolved");
		expect(resolvedRecord?.resolvedBy?.operationId).toBe(resolvedBy?.operationId);
	});

	it("does not resolve a commitment when only its source op produces the artifact", () => {
		const sink = makeSink();
		const pipeline = new SaplingPipelineV1({
			windowSize: 200_000,
			eventEmitter: sink,
		});

		// Single turn: the same op promises (numbered list) and produces the artifact.
		const a = makeAssistantMsgWithText("Plan:\n1. Edit src/foo.ts now", [
			{ name: "write", path: "src/foo.ts" },
		]);
		const u = makeUserToolResult(["tu_write_src/foo.ts"]);
		pipeline.process(makeInput([TASK, a, u], 1));

		const resolved = sink.events.filter((e) => e.type === "commitment_resolved");
		expect(resolved.length).toBe(0);
	});

	it("getCommitmentRegistry returns pending entries for newly observed commitments", () => {
		const pipeline = new SaplingPipelineV1({ windowSize: 200_000 });
		const a = makeAssistantMsgWithText("I'll do this:\n1. Edit src/foo.ts\n2. Update src/bar.ts", [
			{ name: "read", path: "src/foo.ts" },
		]);
		const u = makeUserToolResult(["tu_read_src/foo.ts"]);
		pipeline.process(makeInput([TASK, a, u], 1));

		const registry = pipeline.getCommitmentRegistry();
		expect(registry.length).toBeGreaterThanOrEqual(2);
		for (const r of registry) {
			expect(r.id).toMatch(/^c-1-\d+$/);
			expect(r.turn).toBe(1);
			expect(typeof r.operationId).toBe("number");
			expect(["pending", "resolved"]).toContain(r.status);
		}
	});
});
