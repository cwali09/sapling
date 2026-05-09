/**
 * CLI run command handler for Sapling.
 *
 * Exports runCommand() which wires together the LLM client, tool registry,
 * and context manager, then calls runLoop().
 */

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AnthropicClient } from "./client/index.ts";
import { loadGuardConfig } from "./config.ts";
import { ConfigError } from "./errors.ts";
import { EventEmitter } from "./hooks/events.ts";
import { HookManager } from "./hooks/manager.ts";
import { runLoop } from "./loop.ts";
import { RpcServer } from "./rpc/server.ts";
import { RpcSocketServer } from "./rpc/socket.ts";
import { createDefaultRegistry } from "./tools/index.ts";
import type {
	EcosystemConfig,
	EventConfig,
	LlmClient,
	LoopOptions,
	RunOptions,
	SaplingConfig,
} from "./types.ts";

// ─── Agent Prompt Resolution ──────────────────────────────────────────────────

export const AGENTS_DIR = resolve(import.meta.dir, "..", "agents");
const DEFAULT_AGENT_NAME = "builder";

async function listAvailableAgents(): Promise<string[]> {
	try {
		const entries = await readdir(AGENTS_DIR);
		return entries
			.filter((f) => f.endsWith(".md"))
			.map((f) => f.slice(0, -3))
			.sort();
	} catch {
		return [];
	}
}

async function loadAgentPrompt(agentName: string): Promise<string> {
	const filePath = join(AGENTS_DIR, `${agentName}.md`);
	try {
		return await readFile(filePath, "utf-8");
	} catch (err) {
		if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
			const available = await listAvailableAgents();
			const availableMsg =
				available.length > 0 ? ` Available agents: ${available.join(", ")}.` : "";
			throw new ConfigError(
				`Agent prompt file not found: ${filePath}.${availableMsg}`,
				"CONFIG_FILE_NOT_FOUND",
			);
		}
		throw err;
	}
}

/**
 * Resolve the system prompt using the precedence:
 *   1. opts.systemPromptFile (explicit file path)
 *   2. opts.agentName (CLI flag)
 *   3. SAPLING_AGENT_NAME env var
 *   4. default agent ("builder")
 *
 * Exported so tests can verify resolution without spinning up the agent loop.
 */
export async function resolveSystemPrompt(opts: RunOptions): Promise<string> {
	if (opts.systemPromptFile) {
		const filePath = resolve(opts.systemPromptFile);
		try {
			return await readFile(filePath, "utf-8");
		} catch (err) {
			if (
				err instanceof Error &&
				"code" in err &&
				(err as NodeJS.ErrnoException).code === "ENOENT"
			) {
				throw new ConfigError(`System prompt file not found: ${filePath}`, "CONFIG_FILE_NOT_FOUND");
			}
			throw err;
		}
	}
	const agentName = opts.agentName ?? process.env.SAPLING_AGENT_NAME ?? DEFAULT_AGENT_NAME;
	return loadAgentPrompt(agentName);
}

// ─── Internal Factories ───────────────────────────────────────────────────────

function createClient(config: SaplingConfig): LlmClient {
	return new AnthropicClient({
		model: config.model,
		baseURL: config.apiBaseUrl,
		apiKey: config.apiKey,
	});
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Execute a task using the Sapling agent loop.
 *
 * This is the handler for the `sapling run <prompt>` CLI command.
 * It sets up the LLM client, tool registry, and context manager,
 * then delegates to runLoop().
 *
 * @param prompt - The task description from the CLI
 * @param opts   - Parsed CLI options
 * @param config - Loaded and validated Sapling configuration
 * @returns The loop result (exit reason, turn count, token counts)
 */
export async function runCommand(
	prompt: string,
	opts: RunOptions,
	config: SaplingConfig,
): Promise<ReturnType<typeof runLoop>> {
	// Validate cwd exists (sapling-3810)
	if (!existsSync(config.cwd)) {
		throw new ConfigError(`Working directory not found: ${config.cwd}`, "CONFIG_INVALID_CWD");
	}

	const systemPrompt = await resolveSystemPrompt(opts);

	// Load guard config if guards file provided (standalone mode if file not found)
	let hookManager: HookManager | null = null;
	let eventConfig: EventConfig | undefined;
	if (config.guardsFile) {
		const guardConfig = await loadGuardConfig(config.guardsFile);
		if (guardConfig) {
			hookManager = new HookManager(guardConfig);
			eventConfig = guardConfig.eventConfig;
		}
	}

	const client = createClient(config);
	const tools = createDefaultRegistry();

	if (opts.dryRun) {
		for (const tool of tools.list()) {
			tool.dryRun = true;
		}
	}

	const eventEmitter = new EventEmitter(config.json);

	// RPC mode: open stdin as a control channel for mid-task steering.
	// Also create an RpcServer for state tracking when --rpc-socket is provided
	// without --mode rpc (uses an empty stream — no stdin control channel).
	let rpcServer: RpcServer | undefined;
	if (opts.rpcMode) {
		rpcServer = new RpcServer(Bun.stdin.stream() as ReadableStream<Uint8Array>, eventEmitter);
	} else if (opts.rpcSocket) {
		const emptyStream = new ReadableStream<Uint8Array>({
			start(c) {
				c.close();
			},
		});
		rpcServer = new RpcServer(emptyStream, eventEmitter);
	}

	// Socket server: lets an orchestrator (or any external tool) query live agent state.
	let socketServer: RpcSocketServer | undefined;
	if (opts.rpcSocket && rpcServer) {
		socketServer = new RpcSocketServer(rpcServer);
		await socketServer.start(opts.rpcSocket);
	}

	// Wire SIGTERM/SIGINT to AbortController for graceful shutdown.
	const abortController = new AbortController();
	const onSignal = () => abortController.abort();
	process.on("SIGTERM", onSignal);
	process.on("SIGINT", onSignal);

	// Ecosystem integration: load from CLI options or SAPLING_* environment variables.
	// Priority: CLI options > SAPLING_* env vars.
	const ecosystemAgentName = opts.agentName ?? process.env.SAPLING_AGENT_NAME;
	const ecosystemTaskId = opts.taskId ?? process.env.SAPLING_TASK_ID;
	const ecosystemMetricsPath = opts.metricsPath ?? process.env.SAPLING_METRICS_PATH;

	const ecosystemConfig: EcosystemConfig | undefined =
		ecosystemAgentName && ecosystemTaskId
			? {
					agentName: ecosystemAgentName,
					taskId: ecosystemTaskId,
					metricsPath: ecosystemMetricsPath,
				}
			: undefined;

	const loopOptions: LoopOptions = {
		task: prompt,
		systemPrompt,
		model: config.model,
		maxTurns: config.maxTurns,
		cwd: config.cwd,
		hookManager: hookManager ?? undefined,
		eventEmitter,
		rpcServer,
		eventConfig,
		contextWindowSize: config.contextWindow,
		abortSignal: abortController.signal,
		ecosystemConfig,
		pipelineTuning: config.pipelineTuning,
	};

	try {
		return await runLoop(client, tools, loopOptions);
	} finally {
		process.removeListener("SIGTERM", onSignal);
		process.removeListener("SIGINT", onSignal);
		await socketServer?.stop();
	}
}
