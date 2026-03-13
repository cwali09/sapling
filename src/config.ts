/**
 * Configuration loader, defaults, and validation for Sapling.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readAuthStore } from "./commands/auth.ts";
import { ConfigError } from "./errors.ts";
import type { GuardConfig, LlmBackend, SaplingConfig } from "./types.ts";

const HOME_CONFIG_PATH = join(homedir(), ".sapling", "config.yaml");

const DEFAULT_CONTEXT_WINDOW = 200_000;

export const DEFAULT_CONFIG: SaplingConfig = {
	model: "MiniMax-M2.5",
	apiBaseUrl: "https://api.minimax.io/anthropic",
	backend: "sdk",
	maxTurns: 200,
	cwd: process.cwd(),
	verbose: false,
	quiet: false,
	json: false,
	contextWindow: DEFAULT_CONTEXT_WINDOW,
};

const VALID_BACKENDS: LlmBackend[] = ["sdk"];

/** Known provider base URLs for Anthropic-compatible APIs. */
const PROVIDER_BASE_URLS: Record<string, string> = {
	anthropic: "https://api.anthropic.com",
	minimax: "https://api.minimax.io/anthropic",
};

/**
 * Resolve which auth provider to use based on the model name.
 * Models starting with "MiniMax" map to the "minimax" provider;
 * everything else maps to "anthropic".
 */
export function resolveProvider(model: string): string {
	if (model.toLowerCase().startsWith("minimax")) return "minimax";
	return "anthropic";
}

/**
 * Resolve a short model alias (e.g. "sonnet", "haiku", "opus") via the
 * ANTHROPIC_DEFAULT_{ALIAS}_MODEL env var. Full model names are returned unchanged.
 */
export function resolveModelAlias(model: string): string {
	const upper = model.toUpperCase();
	const envKey = `ANTHROPIC_DEFAULT_${upper}_MODEL`;
	return process.env[envKey] ?? model;
}

/**
 * Minimal flat YAML parser for .sapling/config.yaml.
 * Handles comment lines (#), blank lines, and key: value pairs.
 * String values may be optionally quoted. Unknown keys are ignored silently.
 */
export function parseYamlConfig(raw: string): Partial<SaplingConfig> {
	const result: Partial<SaplingConfig> = {};
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const colonIdx = trimmed.indexOf(":");
		if (colonIdx < 0) continue;
		const key = trimmed.slice(0, colonIdx).trim();
		const rawVal = trimmed.slice(colonIdx + 1).trim();
		// Strip surrounding quotes from string values
		const val = rawVal.replace(/^["']|["']$/g, "");
		switch (key) {
			case "model":
				if (val) result.model = val;
				break;
			case "backend":
				if (VALID_BACKENDS.includes(val as LlmBackend)) result.backend = val as LlmBackend;
				break;
			case "max_turns": {
				const n = parseInt(val, 10);
				if (!Number.isNaN(n)) result.maxTurns = n;
				break;
			}
			case "context_window": {
				const n = parseInt(val, 10);
				if (!Number.isNaN(n)) result.contextWindow = n;
				break;
			}
			case "api_base_url":
				if (val) result.apiBaseUrl = val;
				break;
			case "api_key":
				if (val) result.apiKey = val;
				break;
			default:
				// Silently ignore unknown keys (e.g. project, context_pipeline)
				break;
		}
	}
	return result;
}

/**
 * Walk up the directory tree from startDir looking for a directory that contains
 * .sapling/config.yaml. Returns the .sapling/ directory path if found, null otherwise.
 */
export function findProjectConfigDir(startDir: string): string | null {
	let current = resolve(startDir);
	while (true) {
		const candidate = join(current, ".sapling", "config.yaml");
		if (existsSync(candidate)) {
			return join(current, ".sapling");
		}
		const parent = dirname(current);
		if (parent === current) return null; // reached filesystem root
		current = parent;
	}
}

/**
 * Read and parse a YAML config file. Returns empty object if file doesn't exist.
 * Throws ConfigError if the file exists but cannot be read or parsed.
 */
export async function loadYamlConfigFile(filePath: string): Promise<Partial<SaplingConfig>> {
	if (!existsSync(filePath)) return {};
	let raw: string;
	try {
		raw = await readFile(filePath, "utf-8");
	} catch (_err) {
		throw new ConfigError(`Failed to read config file: ${filePath}`, "CONFIG_FILE_NOT_FOUND");
	}
	return parseYamlConfig(raw);
}

export function validateConfig(config: Partial<SaplingConfig>): SaplingConfig {
	const merged: SaplingConfig = { ...DEFAULT_CONFIG, ...config };
	merged.model = resolveModelAlias(merged.model);

	// Auto-resolve base URL when the model's provider doesn't match the current base URL.
	// This prevents e.g. --model sonnet from routing to MiniMax's endpoint.
	if (!config.apiBaseUrl) {
		const provider = resolveProvider(merged.model);
		const expectedBaseUrl = PROVIDER_BASE_URLS[provider];
		if (expectedBaseUrl && merged.apiBaseUrl !== expectedBaseUrl) {
			merged.apiBaseUrl = expectedBaseUrl;
		}
	}

	if (Number.isNaN(merged.maxTurns) || !Number.isFinite(merged.maxTurns) || merged.maxTurns < 1) {
		throw new ConfigError(
			`maxTurns must be >= 1, got ${merged.maxTurns}`,
			"CONFIG_INVALID_MAX_TURNS",
		);
	}

	if (!VALID_BACKENDS.includes(merged.backend)) {
		throw new ConfigError(
			`backend must be one of [${VALID_BACKENDS.join(", ")}], got "${merged.backend}"`,
			"CONFIG_INVALID_BACKEND",
		);
	}

	if (
		Number.isNaN(merged.contextWindow) ||
		!Number.isFinite(merged.contextWindow) ||
		merged.contextWindow < 1000
	) {
		throw new ConfigError(
			`contextWindow must be >= 1000, got ${merged.contextWindow}`,
			"CONFIG_INVALID_CONTEXT_WINDOW",
		);
	}

	return merged;
}

/**
 * Load guard config from a JSON file.
 * Returns null if file does not exist (standalone mode — no error).
 * Throws ConfigError if file exists but is invalid JSON or missing required fields.
 */
export async function loadGuardConfig(filePath: string): Promise<GuardConfig | null> {
	const resolved = resolve(filePath);
	if (!existsSync(resolved)) {
		return null;
	}
	let raw: string;
	try {
		raw = await readFile(resolved, "utf-8");
	} catch (_err) {
		throw new ConfigError(`Failed to read guards file: ${resolved}`, "CONFIG_FILE_NOT_FOUND");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new ConfigError(`Guards file is not valid JSON: ${resolved}`, "CONFIG_INVALID_GUARDS");
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("rules" in parsed) ||
		!Array.isArray((parsed as Record<string, unknown>).rules)
	) {
		throw new ConfigError(
			`Guards file must have a "rules" array: ${resolved}`,
			"CONFIG_INVALID_GUARDS",
		);
	}
	return parsed as GuardConfig;
}

/**
 * Load config from YAML files, environment variables, and auth store, merging with provided
 * overrides. Precedence (highest to lowest):
 *   CLI flags (overrides) > project .sapling/config.yaml > env vars > ~/.sapling/config.yaml > defaults
 */
export async function loadConfig(overrides: Partial<SaplingConfig> = {}): Promise<SaplingConfig> {
	// Home-level config (~/.sapling/config.yaml) — lowest file-based precedence
	const fromHome = await loadYamlConfigFile(HOME_CONFIG_PATH);

	// Env vars — override home config
	const fromEnv: Partial<SaplingConfig> = {};

	const envModel = process.env.SAPLING_MODEL;
	if (envModel) fromEnv.model = envModel;

	const envBackend = process.env.SAPLING_BACKEND;
	if (envBackend && VALID_BACKENDS.includes(envBackend as LlmBackend)) {
		fromEnv.backend = envBackend as LlmBackend;
	}

	const envMaxTurns = process.env.SAPLING_MAX_TURNS;
	if (envMaxTurns) {
		const n = parseInt(envMaxTurns, 10);
		if (!Number.isNaN(n)) fromEnv.maxTurns = n;
	}

	const envContextWindow = process.env.SAPLING_CONTEXT_WINDOW;
	if (envContextWindow) {
		const n = parseInt(envContextWindow, 10);
		if (!Number.isNaN(n)) fromEnv.contextWindow = n;
	}

	const envBaseUrl = process.env.ANTHROPIC_BASE_URL;
	if (envBaseUrl) fromEnv.apiBaseUrl = envBaseUrl;

	// ANTHROPIC_API_KEY is the canonical env var; ANTHROPIC_AUTH_TOKEN is a fallback alias.
	const envApiKey = process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN;
	if (envApiKey) fromEnv.apiKey = envApiKey;

	// Project-level config (.sapling/config.yaml) — overrides env vars
	const startDir = overrides.cwd ?? process.cwd();
	const projectConfigDir = findProjectConfigDir(startDir);
	const fromProject = projectConfigDir
		? await loadYamlConfigFile(join(projectConfigDir, "config.yaml"))
		: {};

	// Fall back to auth store when no source provides credentials.
	const mergedForAuth = { ...fromHome, ...fromEnv, ...fromProject, ...overrides };
	if (!mergedForAuth.apiKey) {
		const model = mergedForAuth.model ?? DEFAULT_CONFIG.model;
		const provider = resolveProvider(model);
		const store = await readAuthStore();
		const creds = store.providers[provider];
		if (creds) {
			fromEnv.apiKey = creds.apiKey;
			if (!mergedForAuth.apiBaseUrl) {
				fromEnv.apiBaseUrl = creds.baseUrl ?? PROVIDER_BASE_URLS[provider];
			}
		}
	}

	return validateConfig({ ...fromHome, ...fromEnv, ...fromProject, ...overrides });
}
