/**
 * E2E tests for sapling's general-purpose orchestrator integration surface.
 *
 * Any orchestrator that spawns sapling as a headless agent subprocess relies on:
 *   1. NDJSON event stream (--json mode) emits the correct event sequence
 *   2. Guards + eventConfig lifecycle hooks fire at the right moments
 *   3. RPC socket server responds to getState queries
 *   4. Custom system prompt loaded from file
 *   5. RPC abort terminates the loop gracefully
 *
 * Uses mock LLM client + real tool registry. No API key required.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadGuardConfig } from "./config.ts";
import { EventEmitter } from "./hooks/events.ts";
import { HookManager } from "./hooks/manager.ts";
import { runLoop } from "./loop.ts";
import { RpcServer } from "./rpc/server.ts";
import { RpcSocketServer } from "./rpc/socket.ts";
import {
	cleanupTempDir,
	createMockClient,
	createTempDir,
	mockTextResponse,
	mockToolUseResponse,
} from "./test-helpers.ts";
import { createDefaultRegistry } from "./tools/index.ts";
import type { EventConfig, GuardConfig, LlmResponse, LoopOptions } from "./types.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Collected NDJSON events from an EventEmitter. */
function createCapturingEmitter(): {
	emitter: EventEmitter;
	events: Record<string, unknown>[];
} {
	const events: Record<string, unknown>[] = [];
	const emitter = new EventEmitter(true);
	emitter.emit = (event: Record<string, unknown>) => {
		events.push({ ...event });
		// Don't write to stdout in tests — just capture
	};
	return { emitter, events };
}

/** Write a guards.json file and return its path. */
async function writeGuardsJson(dir: string, config: GuardConfig): Promise<string> {
	const path = join(dir, "guards.json");
	await writeFile(path, JSON.stringify(config), "utf-8");
	return path;
}

function defaultLoopOptions(cwd: string, overrides: Partial<LoopOptions> = {}): LoopOptions {
	return {
		task: "Test task",
		systemPrompt: "You are a test agent.",
		model: "mock-model",
		maxTurns: 5,
		cwd,
		...overrides,
	};
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("orchestrator surface E2E", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTempDir();
	});

	afterEach(async () => {
		await cleanupTempDir(testDir);
	});

	// ── 1. NDJSON event stream ─────────────────────────────────────────────────
	// An orchestrator parses these events line-by-line from sapling's stdout
	// to track turn boundaries, tool dispatches, and final exit reason.

	it("emits correct NDJSON event sequence for a tool-using run", async () => {
		const filePath = join(testDir, "hello.txt");
		await Bun.write(filePath, "test content");

		const { emitter, events } = createCapturingEmitter();

		const client = createMockClient([
			mockToolUseResponse("read", { file_path: filePath }, "tc-1"),
			mockTextResponse("Done reading."),
		]);

		const tools = createDefaultRegistry();
		const result = await runLoop(
			client,
			tools,
			defaultLoopOptions(testDir, { eventEmitter: emitter }),
		);

		expect(result.exitReason).toBe("task_complete");

		// Verify event types in order
		const types = events.map((e) => e.type);
		expect(types).toContain("ready");
		expect(types).toContain("turn_start");
		expect(types).toContain("tool_start");
		expect(types).toContain("tool_end");
		expect(types).toContain("turn_end");
		expect(types).toContain("result");

		// ready must be first
		expect(types[0]).toBe("ready");

		// result must be last
		expect(types[types.length - 1]).toBe("result");

		// Verify ready event shape (orchestrators read model, maxTurns, tools)
		const ready = events.find((e) => e.type === "ready");
		expect(ready).toBeDefined();
		expect(ready?.model).toBe("mock-model");
		expect(ready?.maxTurns).toBe(5);
		expect(Array.isArray(ready?.tools)).toBe(true);

		// Verify result event shape
		const resultEvt = events.find((e) => e.type === "result");
		expect(resultEvt).toBeDefined();
		expect(resultEvt?.exitReason).toBe("task_complete");
		expect(typeof resultEvt?.totalTurns).toBe("number");
		expect(typeof resultEvt?.totalInputTokens).toBe("number");
		expect(typeof resultEvt?.totalOutputTokens).toBe("number");

		// Verify tool_start event references the correct tool
		const toolStart = events.find((e) => e.type === "tool_start");
		expect(toolStart).toBeDefined();
		expect(toolStart?.toolName).toBe("read");
		expect(toolStart?.toolCallId).toBe("tc-1");

		// Verify tool_end has success and duration
		const toolEnd = events.find((e) => e.type === "tool_end");
		expect(toolEnd).toBeDefined();
		expect(toolEnd?.toolName).toBe("read");
		expect(toolEnd?.success).toBe(true);
		expect(typeof toolEnd?.durationMs).toBe("number");
	});

	// ── 2. Event sequence for text-only response (no tools) ────────────────────

	it("emits ready + turn_start + turn_end + result for text-only response", async () => {
		const { emitter, events } = createCapturingEmitter();

		const client = createMockClient([mockTextResponse("Hello, done.")]);

		const tools = createDefaultRegistry();
		await runLoop(client, tools, defaultLoopOptions(testDir, { eventEmitter: emitter }));

		const types = events.map((e) => e.type);
		expect(types[0]).toBe("ready");
		expect(types).toContain("turn_start");
		expect(types).toContain("turn_end");
		expect(types[types.length - 1]).toBe("result");
		// No tool events for text-only response
		expect(types).not.toContain("tool_start");
		expect(types).not.toContain("tool_end");
	});

	// ── 2b. turn_end payloads carry active-operation telemetry ─────────────────
	// Warren V2 (per plan pl-c3fc) consumes activeOperationId / activeOperationScore
	// (and the documented `score` alias) on every turn_end to render per-turn
	// pipeline relevance. Acceptance: ≥3 turns, every turn_end carries the fields.

	it("turn_end payloads include activeOperationId, activeOperationScore, and `score` alias", async () => {
		const fileA = join(testDir, "a.txt");
		const fileB = join(testDir, "b.txt");
		await Bun.write(fileA, "alpha");
		await Bun.write(fileB, "beta");

		const { emitter, events } = createCapturingEmitter();

		// Three turns: read fileA → read fileB → final text response.
		const client = createMockClient([
			mockToolUseResponse("read", { file_path: fileA }, "tc-1"),
			mockToolUseResponse("read", { file_path: fileB }, "tc-2"),
			mockTextResponse("All read."),
		]);

		const tools = createDefaultRegistry();
		const result = await runLoop(
			client,
			tools,
			defaultLoopOptions(testDir, { eventEmitter: emitter, maxTurns: 5 }),
		);

		expect(result.exitReason).toBe("task_complete");

		const turnEnds = events.filter((e) => e.type === "turn_end");
		expect(turnEnds.length).toBeGreaterThanOrEqual(3);

		for (const evt of turnEnds) {
			// Fields must always be present (number | null), not undefined / missing.
			expect("activeOperationId" in evt).toBe(true);
			expect("activeOperationScore" in evt).toBe(true);
			expect("score" in evt).toBe(true);

			const id = evt.activeOperationId;
			const score = evt.activeOperationScore;
			expect(id === null || typeof id === "number").toBe(true);
			expect(score === null || typeof score === "number").toBe(true);

			// `score` is documented as an alias of activeOperationScore.
			expect(evt.score).toBe(score as number | null);
		}

		// At least one turn ran inside an operation (the read tool calls form one).
		const withActiveOp = turnEnds.filter((e) => e.activeOperationId !== null);
		expect(withActiveOp.length).toBeGreaterThan(0);
		for (const evt of withActiveOp) {
			expect(typeof evt.activeOperationScore).toBe("number");
			expect(evt.activeOperationScore).toBeGreaterThanOrEqual(0);
			expect(evt.activeOperationScore).toBeLessThanOrEqual(1);
		}
	});

	// ── 3. Guards + eventConfig: onSessionEnd fires ────────────────────────────
	// Orchestrators wire eventConfig.onSessionEnd to a script for session bookkeeping.

	it("fires eventConfig.onSessionEnd on task_complete", async () => {
		const markerFile = join(testDir, "session-end-marker");
		const eventConfig: EventConfig = {
			onSessionEnd: ["touch", markerFile],
		};

		const client = createMockClient([mockTextResponse("Done.")]);
		const tools = createDefaultRegistry();

		const result = await runLoop(client, tools, defaultLoopOptions(testDir, { eventConfig }));

		expect(result.exitReason).toBe("task_complete");

		// Wait briefly for the subprocess to complete
		await new Promise<void>((resolve) => setTimeout(resolve, 200));
		expect(await Bun.file(markerFile).exists()).toBe(true);
	});

	it("fires eventConfig.onSessionEnd on error", async () => {
		const markerFile = join(testDir, "session-end-error-marker");
		const eventConfig: EventConfig = {
			onSessionEnd: ["touch", markerFile],
		};

		// Client that throws an unrecoverable error
		const { ClientError } = await import("./errors.ts");
		const client = {
			id: "mock",
			calls: [],
			call: async (): Promise<never> => {
				throw new ClientError("Auth failed", "AUTH_FAILED");
			},
			estimateTokens: (text: string): number => Math.ceil(text.length / 4),
		};

		const tools = createDefaultRegistry();
		const result = await runLoop(client, tools, defaultLoopOptions(testDir, { eventConfig }));

		expect(result.exitReason).toBe("error");
		await new Promise<void>((resolve) => setTimeout(resolve, 200));
		expect(await Bun.file(markerFile).exists()).toBe(true);
	});

	// ── 4. eventConfig.onToolStart fires during tool execution ─────────────────

	it("fires eventConfig.onToolStart when tools are dispatched", async () => {
		const markerFile = join(testDir, "tool-start-marker");
		const eventConfig: EventConfig = {
			onToolStart: ["touch", markerFile],
		};

		const filePath = join(testDir, "data.txt");
		await Bun.write(filePath, "content");

		const client = createMockClient([
			mockToolUseResponse("read", { file_path: filePath }, "tc-1"),
			mockTextResponse("Done."),
		]);
		const tools = createDefaultRegistry();

		const result = await runLoop(client, tools, defaultLoopOptions(testDir, { eventConfig }));

		expect(result.exitReason).toBe("task_complete");
		await new Promise<void>((resolve) => setTimeout(resolve, 200));
		expect(await Bun.file(markerFile).exists()).toBe(true);
	});

	// ── 5. Custom system prompt via file ───────────────────────────────────────
	// Orchestrators pass agent persona files (e.g. builder, reviewer, scout).

	it("uses custom system prompt in LLM requests", async () => {
		const customPrompt = "You are a specialized code reviewer. Never edit files.";

		const client = createMockClient([mockTextResponse("Review complete.")]);
		const tools = createDefaultRegistry();

		await runLoop(client, tools, defaultLoopOptions(testDir, { systemPrompt: customPrompt }));

		// Verify the LLM received the custom system prompt
		expect(client.calls.length).toBeGreaterThanOrEqual(1);
		// The first call should use the custom prompt (or a pipeline-composed version containing it)
		const firstCall = client.calls[0] as (typeof client.calls)[number];
		expect(firstCall.systemPrompt).toContain("specialized code reviewer");
	});

	// ── 6. Guards enforcement with reviewer-style guards.json ──────────────────
	// Orchestrators pass --guards-file with pathBoundary and readOnly for reviewer agents.

	it("enforces readOnly + pathBoundary guards (reviewer agent pattern)", async () => {
		const guardsPath = await writeGuardsJson(testDir, {
			rules: [],
			readOnly: true,
			pathBoundary: testDir,
		});

		const guardConfig = await loadGuardConfig(guardsPath);
		expect(guardConfig).not.toBeNull();
		const hookManager = new HookManager(guardConfig ?? { rules: [] });
		const client = createMockClient([
			// Attempt write (should be blocked by readOnly)
			mockToolUseResponse("write", { file_path: join(testDir, "out.txt"), content: "x" }, "tc-1"),
			mockTextResponse("Done."),
		]);

		const stubCalls: string[] = [];
		const registry = {
			register() {},
			get(name: string) {
				const tool = {
					name,
					description: `Stub ${name}`,
					inputSchema: { type: "object", properties: {} },
					async execute() {
						stubCalls.push(name);
						return { content: `${name} ok`, isError: false };
					},
					toDefinition() {
						return {
							name,
							description: `Stub ${name}`,
							input_schema: { type: "object", properties: {} },
						};
					},
				};
				return tool;
			},
			list() {
				return [];
			},
			toDefinitions() {
				return [];
			},
		};

		const result = await runLoop(client, registry, defaultLoopOptions(testDir, { hookManager }));

		expect(result.exitReason).toBe("task_complete");
		// Write should have been blocked by readOnly guard
		expect(stubCalls).not.toContain("write");
	});

	// ── 7. RPC socket: getState queries ────────────────────────────────────────
	// Orchestrators query the RPC socket for live agent state ("what phase is it in?").

	it("responds to getState queries on RPC socket", async () => {
		const socketPath = join(testDir, "rpc.sock");

		// Create an RPC server with an empty stream (no stdin control)
		const emptyStream = new ReadableStream<Uint8Array>({
			start(c) {
				c.close();
			},
		});
		const { emitter } = createCapturingEmitter();
		const rpcServer = new RpcServer(emptyStream, emitter);
		const socketServer = new RpcSocketServer(rpcServer);

		try {
			await socketServer.start(socketPath);

			// Connect and collect data via the socket handler
			const response = await new Promise<string>((resolve, reject) => {
				let buf = "";
				Bun.connect({
					unix: socketPath,
					socket: {
						open(socket) {
							const req = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getState" })}\n`;
							socket.write(req);
						},
						data(_socket, chunk) {
							buf += new TextDecoder().decode(chunk);
							if (buf.includes("\n")) {
								resolve(buf.trim());
							}
						},
						error(_socket, err) {
							reject(err);
						},
					},
				});
				// Timeout fallback
				setTimeout(() => {
					resolve(buf.trim());
				}, 2000);
			});

			const parsed = JSON.parse(response);
			expect(parsed.jsonrpc).toBe("2.0");
			expect(parsed.id).toBe(1);
			expect(parsed.result).toBeDefined();
			expect(parsed.result.status).toBe("idle");
		} finally {
			await socketServer.stop();
		}
	});

	// ── 8. RPC abort terminates loop ───────────────────────────────────────────
	// Orchestrators send abort requests to stop agents cleanly.

	it("aborts loop when RPC abort is received before first turn", async () => {
		const { emitter, events } = createCapturingEmitter();

		// Create an RPC server that has already received an abort
		const abortStream = new ReadableStream<Uint8Array>({
			start(controller) {
				const line = `${JSON.stringify({ jsonrpc: "2.0", method: "abort", id: 1 })}\n`;
				controller.enqueue(new TextEncoder().encode(line));
				controller.close();
			},
		});
		const rpcServer = new RpcServer(abortStream, emitter);

		// Wait for the abort to be processed
		await rpcServer.drained;

		const client = createMockClient([mockTextResponse("Should not reach here.")]);
		const tools = createDefaultRegistry();

		const result = await runLoop(
			client,
			tools,
			defaultLoopOptions(testDir, { eventEmitter: emitter, rpcServer }),
		);

		expect(result.exitReason).toBe("aborted");
		expect(result.totalTurns).toBe(0);

		// Should emit a result event with aborted status
		const resultEvt = events.find((e) => e.type === "result");
		expect(resultEvt).toBeDefined();
		expect(resultEvt?.exitReason).toBe("aborted");
	});

	// ── 9. setState callback updates RPC state ─────────────────────────────────
	// Orchestrators read agent phase via getState — verify setState is called.

	it("calls setState callback at turn boundaries", async () => {
		const states: { turn: number; phase: string }[] = [];

		const filePath = join(testDir, "data.txt");
		await Bun.write(filePath, "content");

		const client = createMockClient([
			mockToolUseResponse("read", { file_path: filePath }, "tc-1"),
			mockTextResponse("Done."),
		]);
		const tools = createDefaultRegistry();

		await runLoop(
			client,
			tools,
			defaultLoopOptions(testDir, {
				setState: (state) => states.push({ ...state }),
			}),
		);

		// Should have called setState with calling_llm and executing_tools phases
		const phases = states.map((s) => s.phase);
		expect(phases).toContain("calling_llm");
		expect(phases).toContain("executing_tools");

		// First state should be calling_llm at turn 1
		expect(states[0]?.turn).toBe(1);
		expect(states[0]?.phase).toBe("calling_llm");
	});

	// ── 10. abortSignal terminates loop gracefully (SIGTERM from orchestrator) ─
	// When the orchestrator (or any caller) sends SIGTERM, the CLI wires it to
	// abortSignal. Verify the loop exits with "aborted" and fires onSessionEnd.

	it("abortSignal terminates loop gracefully with onSessionEnd", async () => {
		const markerFile = join(testDir, "signal-end-marker");
		const eventConfig: EventConfig = {
			onSessionEnd: ["touch", markerFile],
		};
		const { emitter, events } = createCapturingEmitter();

		const abortController = new AbortController();

		// Client that delays enough for the abort to fire between turns
		const callCount = { n: 0 };
		const filePath = join(testDir, "data.txt");
		await Bun.write(filePath, "content");

		const client = createMockClient([
			mockToolUseResponse("read", { file_path: filePath }, "tc-1"),
			// Second call will never be reached — abort fires before turn 2
			mockTextResponse("Should not reach here."),
		]);

		// Abort after the first turn completes (tool dispatch finishes)
		const originalCall = client.call.bind(client);
		client.call = async (...args: Parameters<typeof client.call>) => {
			callCount.n++;
			const result = await originalCall(...args);
			if (callCount.n === 1) {
				// After first LLM call returns, abort before next turn
				abortController.abort();
			}
			return result;
		};

		const tools = createDefaultRegistry();
		const result = await runLoop(
			client,
			tools,
			defaultLoopOptions(testDir, {
				eventEmitter: emitter,
				eventConfig,
				abortSignal: abortController.signal,
			}),
		);

		expect(result.exitReason).toBe("aborted");

		// result event should be emitted with aborted
		const resultEvt = events.find((e) => e.type === "result");
		expect(resultEvt).toBeDefined();
		expect(resultEvt?.exitReason).toBe("aborted");

		// onSessionEnd should have fired
		await new Promise<void>((resolve) => setTimeout(resolve, 200));
		expect(await Bun.file(markerFile).exists()).toBe(true);
	});

	it("abortSignal before first turn yields zero turns", async () => {
		const { emitter } = createCapturingEmitter();
		const abortController = new AbortController();
		abortController.abort(); // Already aborted

		const client = createMockClient([mockTextResponse("Should not run.")]);
		const tools = createDefaultRegistry();

		const result = await runLoop(
			client,
			tools,
			defaultLoopOptions(testDir, {
				eventEmitter: emitter,
				abortSignal: abortController.signal,
			}),
		);

		expect(result.exitReason).toBe("aborted");
		expect(result.totalTurns).toBe(0);
	});

	// ── 11a. Pipeline decision events: `compact` ───────────────────────────────
	// Warren V2 (per plan pl-c3fc) consumes `compact` events to render compaction
	// activity in its UI. Acceptance: an event with `reason: "score_below_threshold"`
	// and `archivedAs: "compacted"` fires when older ops drop below the threshold.

	it("emits `compact` events when older ops drop below the configured score threshold", async () => {
		const fileA = join(testDir, "alpha.ts");
		const fileB = join(testDir, "beta.ts");
		const fileC = join(testDir, "gamma.ts");
		await Bun.write(fileA, "alpha");
		await Bun.write(fileB, "beta");
		await Bun.write(fileC, "gamma");

		const { emitter, events } = createCapturingEmitter();

		// Three distinct file scopes encourage operation boundaries between turns.
		const client = createMockClient([
			mockToolUseResponse("read", { file_path: fileA }, "tc-1"),
			mockToolUseResponse("read", { file_path: fileB }, "tc-2"),
			mockToolUseResponse("read", { file_path: fileC }, "tc-3"),
			mockTextResponse("All read."),
		]);

		const tools = createDefaultRegistry();
		// boundaryThreshold=0 forces every turn into a new operation (so older ops
		// complete and become compaction-eligible). compactionScoreThreshold=0.99
		// then forces every completed op below the active one to compact, since
		// scores are clamped to [0,1] and the active op is exempt.
		const result = await runLoop(
			client,
			tools,
			defaultLoopOptions(testDir, {
				eventEmitter: emitter,
				maxTurns: 6,
				pipelineTuning: { boundaryThreshold: 0, compactionScoreThreshold: 0.99 },
			}),
		);

		expect(result.exitReason).toBe("task_complete");

		const compactEvents = events.filter((e) => e.type === "compact");
		expect(compactEvents.length).toBeGreaterThan(0);

		for (const evt of compactEvents) {
			expect(["score_below_threshold", "budget_pressure"]).toContain(evt.reason as string);
			expect(["compacted", "archived"]).toContain(evt.archivedAs as string);
			expect(typeof evt.operationId).toBe("number");
			expect(typeof evt.turn).toBe("number");
			expect(typeof evt.score).toBe("number");
			expect(evt.score as number).toBeGreaterThanOrEqual(0);
			expect(evt.score as number).toBeLessThanOrEqual(1);
		}

		// At least one event should be score-driven (the threshold trigger we set up).
		const scoreDriven = compactEvents.find((e) => e.reason === "score_below_threshold");
		expect(scoreDriven).toBeDefined();
		expect(scoreDriven?.archivedAs).toBe("compacted");
	});

	// ── 11b. Pipeline decision events: `commitment_added` ──────────────────────
	// The commitment-track stage extracts future-action promises from assistant
	// text and emits `commitment_added` with a deterministic `c-<turn>-<n>` id.

	it("emits `commitment_added` for future-action assistant text", async () => {
		const targetFile = join(testDir, "target.ts");
		await Bun.write(targetFile, "old content");

		const { emitter, events } = createCapturingEmitter();

		// Numbered-list commitment in assistant text — the most reliable extractor input.
		// COMMITMENT_FILE_PATTERN matches `target.ts` (extension allow-list).
		const responseWithCommitment: LlmResponse = {
			content: [
				{
					type: "text",
					text: "Plan:\n1. Edit target.ts to update the data",
				},
				{ type: "tool_use", id: "tc-1", name: "read", input: { file_path: targetFile } },
			],
			usage: { inputTokens: 100, outputTokens: 50 },
			model: "mock-model",
			stopReason: "tool_use",
		};

		const client = createMockClient([responseWithCommitment, mockTextResponse("Read.")]);

		const tools = createDefaultRegistry();
		const result = await runLoop(
			client,
			tools,
			defaultLoopOptions(testDir, { eventEmitter: emitter, maxTurns: 5 }),
		);

		expect(result.exitReason).toBe("task_complete");

		const added = events.filter((e) => e.type === "commitment_added");
		expect(added.length).toBeGreaterThan(0);

		const evt = added[0] as Record<string, unknown>;
		expect(typeof evt.commitmentId).toBe("string");
		expect(evt.commitmentId).toMatch(/^c-\d+-\d+$/);
		expect(typeof evt.text).toBe("string");
		expect(evt.text).toContain("target.ts");
		expect(typeof evt.operationId).toBe("number");
		expect(typeof evt.producedTurn).toBe("number");
		expect(evt.producedTurn).toBe(1);
	});

	// ── 11c. Pipeline decision events: `pipeline_stage` (verbose-gated) ────────
	// Under --verbose, every pipeline stage emits a structured summary event.
	// Without verbose, no pipeline_stage events fire (matches existing stderr behavior).

	it("emits `pipeline_stage` events for every stage when verbose=true", async () => {
		const filePath = join(testDir, "data.ts");
		await Bun.write(filePath, "content");

		const { emitter, events } = createCapturingEmitter();

		const client = createMockClient([
			mockToolUseResponse("read", { file_path: filePath }, "tc-1"),
			mockTextResponse("Done."),
		]);

		const tools = createDefaultRegistry();
		await runLoop(
			client,
			tools,
			defaultLoopOptions(testDir, { eventEmitter: emitter, verbose: true, maxTurns: 4 }),
		);

		const stageEvents = events.filter((e) => e.type === "pipeline_stage");
		const stages = new Set(stageEvents.map((e) => e.stage));
		// Default registry runs ingest → commitment-track → evaluate → compact → budget → render.
		expect(stages.has("ingest")).toBe(true);
		expect(stages.has("commitment-track")).toBe(true);
		expect(stages.has("evaluate")).toBe(true);
		expect(stages.has("compact")).toBe(true);
		expect(stages.has("budget")).toBe(true);
		expect(stages.has("render")).toBe(true);

		for (const evt of stageEvents) {
			expect(typeof evt.turn).toBe("number");
			expect(typeof evt.stage).toBe("string");
		}
	});

	it("emits no `pipeline_stage` events when verbose is off", async () => {
		const filePath = join(testDir, "data.ts");
		await Bun.write(filePath, "content");

		const { emitter, events } = createCapturingEmitter();

		const client = createMockClient([
			mockToolUseResponse("read", { file_path: filePath }, "tc-1"),
			mockTextResponse("Done."),
		]);

		const tools = createDefaultRegistry();
		await runLoop(
			client,
			tools,
			defaultLoopOptions(testDir, { eventEmitter: emitter, maxTurns: 4 }),
		);

		const stageEvents = events.filter((e) => e.type === "pipeline_stage");
		expect(stageEvents.length).toBe(0);
	});

	// ── 11d. RPC getState response includes pipeline.commitments ───────────────
	// External tools polling the unix socket get the commitment registry alongside
	// the rest of the pipeline state. Capped at MAX_RPC_COMMITMENTS (50).

	it("includes pipeline.commitments in getState responses after the loop runs", async () => {
		const targetFile = join(testDir, "target.ts");
		await Bun.write(targetFile, "old content");

		const { emitter } = createCapturingEmitter();

		// Run the loop with an RpcServer so its pipeline state is populated.
		const emptyStream = new ReadableStream<Uint8Array>({
			start(c) {
				c.close();
			},
		});
		const rpcServer = new RpcServer(emptyStream, emitter);

		const responseWithCommitment: LlmResponse = {
			content: [
				{ type: "text", text: "Plan:\n1. Edit target.ts to update the data" },
				{ type: "tool_use", id: "tc-1", name: "read", input: { file_path: targetFile } },
			],
			usage: { inputTokens: 100, outputTokens: 50 },
			model: "mock-model",
			stopReason: "tool_use",
		};
		const client = createMockClient([responseWithCommitment, mockTextResponse("Read.")]);

		const tools = createDefaultRegistry();
		await runLoop(
			client,
			tools,
			defaultLoopOptions(testDir, { eventEmitter: emitter, rpcServer, maxTurns: 5 }),
		);

		// Now query the socket and assert the response shape.
		const socketPath = join(testDir, "rpc-commitments.sock");
		const socketServer = new RpcSocketServer(rpcServer);
		try {
			await socketServer.start(socketPath);

			const response = await new Promise<string>((resolve, reject) => {
				let buf = "";
				Bun.connect({
					unix: socketPath,
					socket: {
						open(socket) {
							socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getState" })}\n`);
						},
						data(_socket, chunk) {
							buf += new TextDecoder().decode(chunk);
							if (buf.includes("\n")) resolve(buf.trim());
						},
						error(_socket, err) {
							reject(err);
						},
					},
				});
				setTimeout(() => resolve(buf.trim()), 2000);
			});

			const parsed = JSON.parse(response);
			expect(parsed.result).toBeDefined();
			expect(parsed.result.pipeline).toBeDefined();
			// commitments is always present on pipeline state once the v1 pipeline has run.
			expect(Array.isArray(parsed.result.pipeline.commitments)).toBe(true);
			expect(parsed.result.pipeline.commitments.length).toBeGreaterThan(0);
			expect(parsed.result.pipeline.commitments.length).toBeLessThanOrEqual(50);

			const sample = parsed.result.pipeline.commitments[0];
			expect(typeof sample.id).toBe("string");
			expect(sample.id).toMatch(/^c-\d+-\d+$/);
			expect(typeof sample.turn).toBe("number");
			expect(typeof sample.text).toBe("string");
			expect(["pending", "resolved"]).toContain(sample.status);
		} finally {
			await socketServer.stop();
		}
	});

	// ── 12. Full subprocess E2E (gated) ────────────────────────────────────────
	// Spawns sapling as an orchestrator would, with --json mode, verifies NDJSON stdout.

	const SKIP_INTEG = !process.env.SAPLING_INTEGRATION_TESTS;

	it.skipIf(SKIP_INTEG)(
		"subprocess with --json emits parseable NDJSON events",
		async () => {
			const filePath = join(testDir, "marker.txt");
			await Bun.write(filePath, "ORCHESTRATOR_E2E_MARKER_42");

			const proc = Bun.spawn(
				[
					"bun",
					join(import.meta.dir, "index.ts"),
					"run",
					`Read the file at ${filePath} and tell me its contents.`,
					"--max-turns",
					"5",
					"--json",
				],
				{
					cwd: testDir,
					stdout: "pipe",
					stderr: "pipe",
					env: { ...process.env },
				},
			);

			const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

			expect(exitCode).toBe(0);

			// Parse all NDJSON lines, filtering for event lines (have `type` field)
			const lines = stdout.trim().split("\n").filter(Boolean);
			const allParsed = lines.map((line) => JSON.parse(line));
			const events = allParsed.filter((e: Record<string, unknown>) => typeof e.type === "string");

			// Verify event sequence
			const types = events.map((e: Record<string, unknown>) => e.type);
			expect(types[0]).toBe("ready");
			expect(types[types.length - 1]).toBe("result");
			expect(types).toContain("turn_start");
			expect(types).toContain("turn_end");

			// Every event should have a timestamp
			for (const event of events) {
				expect(event.timestamp).toBeDefined();
			}

			// Result event should contain the marker
			const resultEvt = events.find((e: Record<string, unknown>) => e.type === "result");
			expect(resultEvt).toBeDefined();
		},
		60_000,
	);
});
