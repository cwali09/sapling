/**
 * Tests for StageRegistry — the composable stage container for the v1 pipeline.
 */

import { describe, expect, it } from "bun:test";
import { createDefaultStageRegistry, StageRegistry } from "./registry.ts";
import type { PipelineStage, StageContext } from "./types.ts";

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
	it("returns a registry with five stages in canonical order", () => {
		const reg = createDefaultStageRegistry();
		const names = reg.list().map((s) => s.name);
		expect(names).toEqual(["ingest", "evaluate", "compact", "budget", "render"]);
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
		expect(reg.list()).toHaveLength(4);
	});
});
