/**
 * Agent turn loop for Sapling.
 *
 * Implements the core cycle: LLM call → tool dispatch → context management → repeat.
 * Parallel tool execution via Promise.all.
 * Stop conditions: no tool calls, max turns, unrecoverable error.
 * LLM errors use exponential backoff (3 retries).
 */

import { resolveProvider } from "./config.ts";
import { extractTurnHint, SaplingPipelineV1 } from "./context/v1/pipeline.ts";
import type { PipelineState } from "./context/v1/types.ts";
import { ClientError } from "./errors.ts";
import { logger } from "./logging/logger.ts";
import type {
	ContentBlock,
	EcosystemConfig,
	LlmClient,
	LlmRequest,
	LlmResponse,
	LoopOptions,
	LoopResult,
	Message,
	ToolRegistry,
} from "./types.ts";

// ─── Internal Types ───────────────────────────────────────────────────────────

/**
 * A tool_result content block (Anthropic API format).
 * Not in the shared ContentBlock union (which only covers LLM output blocks);
 * tool results are user-turn inputs.
 */
interface ToolResultBlock {
	type: "tool_result";
	tool_use_id: string;
	content: string;
	is_error?: boolean;
}

/**
 * Internal message type that extends Message to allow tool_result content in user turns.
 * Cast to Message[] when passing to LlmClient.process().
 */
type LoopMessage =
	| { role: "user"; content: string | (ContentBlock | ToolResultBlock)[] }
	| { role: "assistant"; content: ContentBlock[] };

// ─── Retry Configuration ──────────────────────────────────────────────────────

const MAX_RETRY_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 1000;

/**
 * Error codes that indicate an unrecoverable failure.
 * These abort the loop immediately without retrying.
 */
const UNRECOVERABLE_CODES = new Set([
	"AUTH_FAILED",
	"CC_AUTH_FAILED",
	"MODEL_NOT_FOUND",
	"INVALID_API_KEY",
	"PERMISSION_DENIED",
	"SDK_AUTH_FAILED",
	"SDK_PERMISSION_DENIED",
	"SDK_MODEL_NOT_FOUND",
	"SDK_NOT_INSTALLED",
	"PI_NOT_FOUND",
]);

// ─── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Call the LLM client with exponential backoff on transient failures.
 * Throws immediately on unrecoverable errors (auth, model not found).
 */
async function callWithRetry(client: LlmClient, request: LlmRequest): Promise<LlmResponse> {
	let lastError: Error | undefined;

	for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
		try {
			return await client.call(request);
		} catch (err) {
			if (err instanceof ClientError && UNRECOVERABLE_CODES.has(err.code)) {
				throw err;
			}
			lastError = err instanceof Error ? err : new Error(String(err));
			if (attempt < MAX_RETRY_ATTEMPTS - 1) {
				const delay = BASE_RETRY_DELAY_MS * 2 ** attempt;
				logger.warn(
					`LLM call failed (attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS}), retrying in ${delay}ms`,
					{ error: lastError.message },
				);
				await new Promise<void>((resolve) => setTimeout(resolve, delay));
			}
		}
	}

	throw lastError ?? new Error("LLM call failed after all retries");
}

/**
 * Extract tool_use blocks from an LLM response's content array.
 */
function extractToolCalls(content: ContentBlock[]): Extract<ContentBlock, { type: "tool_use" }>[] {
	return content.filter(
		(b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
	);
}

/**
 * Extract file paths modified by a tool call, for inclusion in tool_end events.
 * - write/edit: extracts file_path from input args
 * - bash: returns empty array (files cannot be reliably inferred from command)
 * - other tools: returns undefined (field omitted from event)
 */
function extractFilesModified(
	toolName: string,
	input: Record<string, unknown>,
): string[] | undefined {
	if (toolName === "write" || toolName === "edit") {
		const fp = input.file_path;
		return typeof fp === "string" ? [fp] : [];
	}
	if (toolName === "bash") return [];
	return undefined;
}

/**
 * Resolve the active operation's id and current evaluator score from a pipeline state.
 * Returns null/null when there is no state yet, no active operation, or the active
 * operation cannot be located (which would only happen if state is internally inconsistent).
 */
function deriveActiveOpInfo(state: PipelineState | null): {
	activeOperationId: number | null;
	activeOperationScore: number | null;
} {
	if (!state || state.activeOperationId === null) {
		return { activeOperationId: null, activeOperationScore: null };
	}
	const op = state.operations.find((o) => o.id === state.activeOperationId);
	return {
		activeOperationId: state.activeOperationId,
		activeOperationScore: op ? op.score : null,
	};
}

// ─── Lifecycle Hook Helpers ───────────────────────────────────────────────────

/**
 * Await the onSessionEnd hook if configured.
 * Must be awaited (unlike tool events) — orchestrators rely on this for
 * critical session bookkeeping (token metrics, state transitions, etc.).
 */
async function fireSessionEnd(argv: string[] | undefined): Promise<void> {
	if (!argv) return;
	const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" });
	await proc.exited;
}

// ─── Ecosystem Integration Helpers ─────────────────────────────────────────────

/**
 * Write per-turn metrics to the ecosystem metrics file.
 * Called after each turn completes.
 */
async function writeTurnMetrics(
	ecosystem: EcosystemConfig,
	turn: number,
	inputTokens: number,
	outputTokens: number,
): Promise<void> {
	try {
		const metricsPath = ecosystem.metricsPath ?? ".sapling/metrics.json";
		// Read existing metrics or initialize
		let metrics: Record<string, unknown> = {};
		try {
			const existing = Bun.file(metricsPath);
			if (await existing.exists()) {
				metrics = JSON.parse(await existing.text());
			}
		} catch {
			// Start fresh if file doesn't exist or is invalid
		}

		// Update turn metrics
		metrics[`turn_${turn}`] = {
			inputTokens,
			outputTokens,
			timestamp: new Date().toISOString(),
		};

		// Write back
		await Bun.write(metricsPath, JSON.stringify(metrics, null, 2));
	} catch {
		// Silently fail - metrics are best-effort
	}
}

/**
 * Write the final metrics _exit block on loop termination.
 *
 * Orchestrators consume the result via the metrics file, the NDJSON `result`
 * event on stdout, or the process exit code — sapling does not push.
 */
async function writeFinalMetrics(
	ecosystem: EcosystemConfig | undefined,
	exitReason: string,
	totalTurns: number,
	metrics: {
		totalInputTokens: number;
		totalOutputTokens: number;
		totalCacheReadTokens: number;
		totalCacheCreationTokens: number;
	},
): Promise<void> {
	if (!ecosystem) return;

	try {
		const metricsPath = ecosystem.metricsPath ?? ".sapling/metrics.json";
		let existingMetrics: Record<string, unknown> = {};
		try {
			const file = Bun.file(metricsPath);
			if (await file.exists()) {
				existingMetrics = JSON.parse(await file.text());
			}
		} catch {
			// Ignore read errors
		}

		const finalMetrics = {
			...existingMetrics,
			_exit: {
				exitReason,
				totalTurns,
				totalInputTokens: metrics.totalInputTokens,
				totalOutputTokens: metrics.totalOutputTokens,
				totalCacheReadTokens: metrics.totalCacheReadTokens,
				totalCacheCreationTokens: metrics.totalCacheCreationTokens,
				timestamp: new Date().toISOString(),
			},
		};

		await Bun.write(metricsPath, JSON.stringify(finalMetrics, null, 2));
	} catch {
		// Silently fail - exit handling is best-effort
	}
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run the agent turn loop.
 *
 * Drives the LLM call → tool dispatch → context management cycle until one of:
 * - The LLM returns a response with no tool calls (task complete)
 * - The max turn limit is reached
 * - An unrecoverable error occurs
 *
 * @param client  - LLM backend (CC subprocess or Anthropic SDK)
 * @param tools   - Registry of available tools
 * @param options - Loop configuration
 */
export async function runLoop(
	client: LlmClient,
	tools: ToolRegistry,
	options: LoopOptions,
): Promise<LoopResult> {
	const maxTurns = options.maxTurns ?? 200;
	let totalTurns = 0;
	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let totalCacheReadTokens = 0;
	let totalCacheCreationTokens = 0;
	// Track unique files modified across all turns for progress events
	const modifiedFiles = new Set<string>();

	const toolDefs = tools.toDefinitions();

	// Seed the conversation with the task description
	const messages: LoopMessage[] = [{ role: "user", content: options.task }];

	// v1 pipeline — created once, stateful across turns
	// Base system prompt is kept immutable; pipeline returns a composed version each turn
	const pipeline = new SaplingPipelineV1({
		windowSize: options.contextWindowSize ?? 200_000,
		verbose: options.verbose ?? false,
		tuning: options.pipelineTuning,
		eventEmitter: options.eventEmitter,
	});
	// Track the pipeline-managed system prompt (updated each turn by the v1 pipeline)
	let currentSystemPrompt = options.systemPrompt;

	logger.info(`Starting agent loop`, {
		model: options.model,
		maxTurns,
		tools: toolDefs.map((t) => t.name),
	});

	options.eventEmitter?.emit({
		type: "ready",
		model: options.model,
		maxTurns,
		tools: toolDefs.map((t) => t.name),
	});

	while (totalTurns < maxTurns) {
		// ── Abort check — before starting a new turn ─────────────────────────
		// Triggered by RPC abort request or external signal (SIGTERM from orchestrator).
		if (options.rpcServer?.isAbortRequested() || options.abortSignal?.aborted) {
			const source = options.abortSignal?.aborted ? "signal" : "RPC request";
			logger.info(`Agent loop aborted by ${source}`);
			options.eventEmitter?.emit({
				type: "result",
				exitReason: "aborted",
				totalTurns,
				totalInputTokens,
				totalOutputTokens,
			});
			await fireSessionEnd(options.eventConfig?.onSessionEnd);
			// Ecosystem exit: write final metrics on abort
			await writeFinalMetrics(options.ecosystemConfig, "aborted", totalTurns, {
				totalInputTokens,
				totalOutputTokens,
				totalCacheReadTokens,
				totalCacheCreationTokens,
			});
			return {
				exitReason: "aborted",
				totalTurns,
				totalInputTokens,
				totalOutputTokens,
				totalCacheReadTokens,
				totalCacheCreationTokens,
			};
		}

		totalTurns++;
		options.eventEmitter?.emit({ type: "turn_start", turn: totalTurns });

		// ── Step 1: Build LLM request ─────────────────────────────────────────
		const request: LlmRequest = {
			// Use the pipeline-managed system prompt (updated by v1 pipeline each turn)
			systemPrompt: currentSystemPrompt,
			messages: messages as Message[],
			tools: toolDefs,
			model: options.model,
		};

		options.setState?.({ turn: totalTurns, phase: "calling_llm" });

		// ── Step 2: Call LLM with retry ───────────────────────────────────────
		let response: LlmResponse;
		try {
			response = await callWithRetry(client, request);
		} catch (err) {
			const rawMessage = err instanceof Error ? err.message : String(err);
			const code = err instanceof ClientError ? err.code : "UNKNOWN";
			const message =
				code === "SDK_AUTH_FAILED"
					? `${rawMessage} [hint: model "${options.model}" uses the ${resolveProvider(options.model)} provider — run 'sp auth set ${resolveProvider(options.model)} --key <key>' or 'sp doctor' to diagnose]`
					: rawMessage;
			logger.error(`Agent loop aborted: ${message}`);
			options.eventEmitter?.emit({ type: "error", message, classification: code });
			options.eventEmitter?.emit({
				type: "result",
				exitReason: "error",
				totalTurns,
				totalInputTokens,
				totalOutputTokens,
			});
			await fireSessionEnd(options.eventConfig?.onSessionEnd);
			// Ecosystem exit: write final metrics on error
			await writeFinalMetrics(options.ecosystemConfig, "error", totalTurns, {
				totalInputTokens,
				totalOutputTokens,
				totalCacheReadTokens,
				totalCacheCreationTokens,
			});
			return {
				exitReason: "error",
				totalTurns,
				totalInputTokens,
				totalOutputTokens,
				totalCacheReadTokens,
				totalCacheCreationTokens,
				error: message,
			};
		}

		// ── Step 3: Record token usage ────────────────────────────────────────
		totalInputTokens += response.usage.inputTokens;
		totalOutputTokens += response.usage.outputTokens;
		totalCacheReadTokens += response.usage.cacheReadTokens ?? 0;
		totalCacheCreationTokens += response.usage.cacheCreationTokens ?? 0;

		// ── Step 4: Append assistant response ─────────────────────────────────
		messages.push({ role: "assistant", content: response.content });

		// ── Step 5: Check stop condition — no tool calls ──────────────────────
		const toolCalls = extractToolCalls(response.content);
		if (toolCalls.length === 0) {
			// Extract final text from the response
			const finalText = response.content
				.filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
				.map((b) => b.text)
				.join("\n");

			logger.info(`Task complete after ${totalTurns} turn(s)`, {
				inputTokens: totalInputTokens,
				outputTokens: totalOutputTokens,
			});
			// Use last pipeline state for utilization + active operation info
			const finalState = pipeline.getState();
			const contextUtilization = finalState?.utilization ?? 0;
			const { activeOperationId, activeOperationScore } = deriveActiveOpInfo(finalState);
			options.eventEmitter?.emit({
				type: "turn_end",
				turn: totalTurns,
				inputTokens: totalInputTokens,
				outputTokens: totalOutputTokens,
				cacheReadTokens: response.usage.cacheReadTokens ?? 0,
				cacheWriteTokens: response.usage.cacheCreationTokens ?? 0,
				model: response.model,
				contextUtilization,
				activeOperationId,
				activeOperationScore,
				score: activeOperationScore,
			});
			options.eventEmitter?.emit({
				type: "result",
				exitReason: "task_complete",
				totalTurns,
				totalInputTokens,
				totalOutputTokens,
			});
			await fireSessionEnd(options.eventConfig?.onSessionEnd);
			// Ecosystem exit: write final metrics on task completion
			await writeFinalMetrics(options.ecosystemConfig, "task_complete", totalTurns, {
				totalInputTokens,
				totalOutputTokens,
				totalCacheReadTokens,
				totalCacheCreationTokens,
			});
			return {
				exitReason: "task_complete",
				totalTurns,
				totalInputTokens,
				totalOutputTokens,
				totalCacheReadTokens,
				totalCacheCreationTokens,
				responseText: finalText || undefined,
			};
		}

		logger.debug(`Turn ${totalTurns}: dispatching ${toolCalls.length} tool call(s)`, {
			tools: toolCalls.map((c) => c.name),
		});

		// ── Step 6: Execute tools in parallel ─────────────────────────────────
		// Fire onToolStart heartbeat — fire-and-forget (orchestrator lastActivity hook)
		if (options.eventConfig?.onToolStart) {
			Bun.spawn(options.eventConfig.onToolStart, { stdout: "ignore", stderr: "ignore" });
		}

		options.setState?.({ turn: totalTurns, phase: "executing_tools" });

		const toolResultBlocks: ToolResultBlock[] = await Promise.all(
			toolCalls.map(async (call): Promise<ToolResultBlock> => {
				// Emit tool_start event before dispatching
				const argsSummary = JSON.stringify(call.input).slice(0, 200);
				options.eventEmitter?.emit({
					type: "tool_start",
					turn: totalTurns,
					toolName: call.name,
					toolCallId: call.id,
					argsSummary,
				});
				const toolStartTime = Date.now();

				let toolResult: ToolResultBlock;
				const tool = tools.get(call.name);
				if (!tool) {
					logger.warn(`Unknown tool requested: ${call.name}`);
					toolResult = {
						type: "tool_result",
						tool_use_id: call.id,
						content: `Tool not found: "${call.name}". Available tools: ${tools
							.list()
							.map((t) => t.name)
							.join(", ")}`,
						is_error: true,
					};
				} else if (options.hookManager && !options.hookManager.preToolCall(call.name, call.input)) {
					// Pre-tool-call hook — block if guard returns false
					toolResult = {
						type: "tool_result",
						tool_use_id: call.id,
						content: `Tool call blocked by guard: "${call.name}"`,
						is_error: true,
					};
				} else {
					try {
						const result = await tool.execute(call.input, options.cwd);

						// Post-tool-call hook
						options.hookManager?.postToolCall(call.name, result.content);

						logger.debug(`Tool ${call.name} completed`, {
							isError: result.isError,
							tokens: result.metadata?.tokensEstimate,
						});
						toolResult = {
							type: "tool_result",
							tool_use_id: call.id,
							content: result.content,
							...(result.isError ? { is_error: true } : {}),
						};
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						logger.warn(`Tool ${call.name} threw: ${msg}`);
						toolResult = {
							type: "tool_result",
							tool_use_id: call.id,
							content: `Tool execution error: ${msg}`,
							is_error: true,
						};
					}
				}

				// Emit tool_end event after completion
				const filesModified = extractFilesModified(call.name, call.input);
				if (filesModified) {
					for (const f of filesModified) modifiedFiles.add(f);
				}
				const isError = toolResult.is_error ?? false;
				const errorMessage = isError ? toolResult.content.slice(0, 200) : undefined;
				const outputSummary = !isError ? toolResult.content.slice(0, 200) : undefined;
				options.eventEmitter?.emit({
					type: "tool_end",
					turn: totalTurns,
					toolName: call.name,
					toolCallId: call.id,
					success: !isError,
					durationMs: Date.now() - toolStartTime,
					filesModified,
					...(errorMessage ? { errorMessage } : {}),
					...(outputSummary ? { outputSummary } : {}),
				});

				return toolResult;
			}),
		);

		// Fire onToolEnd heartbeat — fire-and-forget (orchestrator lastActivity hook)
		if (options.eventConfig?.onToolEnd) {
			Bun.spawn(options.eventConfig.onToolEnd, { stdout: "ignore", stderr: "ignore" });
		}

		// ── Step 7: Append tool results as user message ───────────────────────
		messages.push({ role: "user", content: toolResultBlocks });

		// ── Step 7b: Inject queued RPC steer/followUp requests ───────────────
		// Per decision mx-195088: steer appended to current turn's tool results.
		// followUp injected as a standalone user message.
		if (options.rpcServer) {
			let rpcReq = options.rpcServer.dequeue();
			while (rpcReq) {
				if (rpcReq.method === "steer") {
					const lastMsg = messages[messages.length - 1];
					if (lastMsg?.role === "user" && Array.isArray(lastMsg.content)) {
						(lastMsg.content as Array<ContentBlock | ToolResultBlock>).push({
							type: "text",
							text: `[STEER] ${rpcReq.params.content}`,
						});
					}
				} else if (rpcReq.method === "followUp") {
					messages.push({ role: "user", content: rpcReq.params.content });
				}
				logger.debug(`RPC ${rpcReq.method} injected into turn ${totalTurns}`);
				rpcReq = options.rpcServer.dequeue();
			}
		}

		// ── Step 8: Run v1 pipeline ─────────────────────────────────────────────
		const turnHint = extractTurnHint(messages as Message[], totalTurns);
		const pipelineResult = pipeline.process({
			messages: messages as Message[],
			systemPrompt: options.systemPrompt, // always pass the base prompt
			turnHint,
			usage: response.usage,
		});
		messages.splice(0, messages.length, ...(pipelineResult.messages as LoopMessage[]));
		currentSystemPrompt = pipelineResult.systemPrompt;
		const contextUtilization = pipelineResult.state.utilization;
		const { activeOperationId, activeOperationScore } = deriveActiveOpInfo(pipelineResult.state);

		// Update RPC server with pipeline state for getState responses
		const rpcState = pipeline.getRpcState() ?? undefined;
		if (options.rpcServer && "setPipelineState" in options.rpcServer) {
			(options.rpcServer as { setPipelineState: (s: typeof rpcState) => void }).setPipelineState(
				rpcState,
			);
		}

		options.setState?.({ turn: totalTurns, phase: "idle" });

		// Emit turn_end with cumulative token counts, context utilization ratio,
		// and the active operation's id + score (alias `score`) at end-of-turn.
		options.eventEmitter?.emit({
			type: "turn_end",
			turn: totalTurns,
			inputTokens: totalInputTokens,
			outputTokens: totalOutputTokens,
			cacheReadTokens: response.usage.cacheReadTokens ?? 0,
			cacheWriteTokens: response.usage.cacheCreationTokens ?? 0,
			model: response.model,
			contextUtilization,
			activeOperationId,
			activeOperationScore,
			score: activeOperationScore,
		});

		// ── Step 9: Per-turn metrics for orchestrator consumers ────────────────
		if (options.ecosystemConfig) {
			await writeTurnMetrics(
				options.ecosystemConfig,
				totalTurns,
				totalInputTokens,
				totalOutputTokens,
			);
		}

		// Auto-progress: emit at every 10% milestone or every 10 turns
		const prevMilestone = Math.floor(((totalTurns - 1) / maxTurns) * 10);
		const currMilestone = Math.floor((totalTurns / maxTurns) * 10);
		if (currMilestone > prevMilestone || totalTurns % 10 === 0) {
			const percent = Math.round((totalTurns / maxTurns) * 100);
			options.eventEmitter?.emit({
				type: "progress",
				percent,
				subtask: `Turn ${totalTurns} of ${maxTurns}`,
				filesChanged: modifiedFiles.size,
			});
		}
	}

	// Max turns exhausted
	logger.warn(`Agent loop stopped: max turns (${maxTurns}) reached`, {
		inputTokens: totalInputTokens,
		outputTokens: totalOutputTokens,
	});
	options.eventEmitter?.emit({
		type: "result",
		exitReason: "max_turns",
		totalTurns,
		totalInputTokens,
		totalOutputTokens,
	});
	await fireSessionEnd(options.eventConfig?.onSessionEnd);
	// Ecosystem exit: write final metrics on max turns
	await writeFinalMetrics(options.ecosystemConfig, "max_turns", totalTurns, {
		totalInputTokens,
		totalOutputTokens,
		totalCacheReadTokens,
		totalCacheCreationTokens,
	});
	return {
		exitReason: "max_turns",
		totalTurns,
		totalInputTokens,
		totalOutputTokens,
		totalCacheReadTokens,
		totalCacheCreationTokens,
	};
}
