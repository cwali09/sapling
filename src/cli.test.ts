import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTS_DIR, resolveSystemPrompt, runCommand } from "./cli.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { ConfigError } from "./errors.ts";
import { cleanupTempDir } from "./test-helpers.ts";

describe("runCommand cwd validation", () => {
	it("throws ConfigError with code CONFIG_INVALID_CWD for nonexistent cwd", async () => {
		const config = { ...DEFAULT_CONFIG, cwd: "/nonexistent/path/that/does/not/exist" };

		await expect(runCommand("test", {}, config)).rejects.toThrow(ConfigError);

		try {
			await runCommand("test", {}, config);
		} catch (err) {
			expect(err).toBeInstanceOf(ConfigError);
			expect((err as ConfigError).code).toBe("CONFIG_INVALID_CWD");
			expect((err as ConfigError).message).toContain("/nonexistent/path/that/does/not/exist");
		}
	});
});

describe("runCommand system-prompt-file error handling", () => {
	it("throws ConfigError with code CONFIG_FILE_NOT_FOUND for missing system prompt file", async () => {
		const missingPath = join(import.meta.dir, "__nonexistent_file__.md");
		const opts = { systemPromptFile: missingPath };
		const config = { ...DEFAULT_CONFIG };

		await expect(runCommand("test task", opts, config)).rejects.toThrow(ConfigError);

		try {
			await runCommand("test task", opts, config);
		} catch (err) {
			expect(err).toBeInstanceOf(ConfigError);
			expect((err as ConfigError).code).toBe("CONFIG_FILE_NOT_FOUND");
			expect((err as ConfigError).message).toContain(missingPath);
		}
	});
});

describe("resolveSystemPrompt agent resolution", () => {
	const savedEnv = process.env.SAPLING_AGENT_NAME;

	beforeEach(() => {
		delete process.env.SAPLING_AGENT_NAME;
	});

	afterEach(() => {
		if (savedEnv === undefined) {
			delete process.env.SAPLING_AGENT_NAME;
		} else {
			process.env.SAPLING_AGENT_NAME = savedEnv;
		}
	});

	it("loads agents/builder.md by default (no flag, no env)", async () => {
		const prompt = await resolveSystemPrompt({});
		expect(prompt).toContain("Sapling Builder");
		expect(prompt).toContain("builder-mission");
	});

	it("loads agents/scout.md when --agent-name scout is set", async () => {
		const prompt = await resolveSystemPrompt({ agentName: "scout" });
		expect(prompt).toContain("Sapling Scout");
	});

	it("--system-prompt-file wins over --agent-name", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sapling-prompt-"));
		const customPath = join(dir, "custom-prompt.md");
		const customBody = "CUSTOM SYSTEM PROMPT BODY";
		await writeFile(customPath, customBody, "utf-8");

		try {
			const prompt = await resolveSystemPrompt({
				systemPromptFile: customPath,
				agentName: "scout",
			});
			expect(prompt).toBe(customBody);
		} finally {
			await cleanupTempDir(dir);
		}
	});

	it("loads agents/reviewer.md when SAPLING_AGENT_NAME=reviewer", async () => {
		process.env.SAPLING_AGENT_NAME = "reviewer";
		const prompt = await resolveSystemPrompt({});
		expect(prompt).toContain("Sapling Reviewer");
	});

	it("throws ConfigError with helpful message for missing agent file", async () => {
		await expect(resolveSystemPrompt({ agentName: "nonexistent" })).rejects.toThrow(ConfigError);

		try {
			await resolveSystemPrompt({ agentName: "nonexistent" });
		} catch (err) {
			expect(err).toBeInstanceOf(ConfigError);
			expect((err as ConfigError).code).toBe("CONFIG_FILE_NOT_FOUND");
			const msg = (err as ConfigError).message;
			expect(msg).toContain("nonexistent.md");
			expect(msg).toContain(AGENTS_DIR);
			expect(msg).toContain("Available agents:");
			expect(msg).toContain("builder");
		}
	});
});
