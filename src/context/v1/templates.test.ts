/**
 * Tests for templates.ts — focusing on pending commitment rendering.
 */

import { describe, expect, it } from "bun:test";
import { renderArchiveEntry, renderCompactSummary } from "./templates.ts";
import type { Commitment, Operation } from "./types.ts";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function asCommitments(texts: string[]): Commitment[] {
	return texts.map((text, i) => ({ id: `c-1-${i + 1}`, text }));
}

function makeOp(
	overrides: Partial<Omit<Operation, "pendingCommitments">> & {
		pendingCommitments?: string[];
	} = {},
): Operation {
	const { pendingCommitments, ...rest } = overrides;
	return {
		id: 1,
		status: "completed",
		type: "mutate",
		turns: [],
		files: new Set<string>(),
		tools: new Set<string>(),
		outcome: "success",
		artifacts: [],
		dependsOn: [],
		score: 0.5,
		summary: null,
		startTurn: 0,
		endTurn: 0,
		...rest,
		...(pendingCommitments !== undefined
			? { pendingCommitments: asCommitments(pendingCommitments) }
			: {}),
	};
}

// ---------------------------------------------------------------------------
// renderCompactSummary — pending commitments
// ---------------------------------------------------------------------------

describe("renderCompactSummary — pending commitments", () => {
	it("includes Pending section when pendingCommitments is non-empty", () => {
		const op = makeOp({ pendingCommitments: ["write tests for foo.ts", "update README"] });
		const summary = renderCompactSummary(op);
		expect(summary).toContain("Pending:");
		expect(summary).toContain("write tests for foo.ts");
		expect(summary).toContain("update README");
	});

	it("does NOT include Pending section when pendingCommitments is empty array", () => {
		const op = makeOp({ pendingCommitments: [] });
		const summary = renderCompactSummary(op);
		expect(summary).not.toContain("Pending:");
	});

	it("does NOT include Pending section when pendingCommitments is absent", () => {
		const op = makeOp();
		const summary = renderCompactSummary(op);
		expect(summary).not.toContain("Pending:");
	});

	it("caps Pending list at 5 items", () => {
		const commitments = ["task1", "task2", "task3", "task4", "task5", "task6", "task7"];
		const op = makeOp({ pendingCommitments: commitments });
		const summary = renderCompactSummary(op);
		// Should contain task5 but not task6 or task7
		expect(summary).toContain("task5");
		expect(summary).not.toContain("task6");
		expect(summary).not.toContain("task7");
	});

	it("Pending line appears after Outcome line", () => {
		const op = makeOp({ outcome: "success", pendingCommitments: ["do something"] });
		const summary = renderCompactSummary(op);
		const outcomeIdx = summary.indexOf("Outcome:");
		const pendingIdx = summary.indexOf("Pending:");
		expect(outcomeIdx).toBeGreaterThan(-1);
		expect(pendingIdx).toBeGreaterThan(outcomeIdx);
	});

	it("separates multiple pending items with semicolons", () => {
		const op = makeOp({ pendingCommitments: ["first task", "second task", "third task"] });
		const summary = renderCompactSummary(op);
		expect(summary).toContain("first task; second task; third task");
	});
});

// ---------------------------------------------------------------------------
// renderArchiveEntry — pending commitments
// ---------------------------------------------------------------------------

describe("renderArchiveEntry — pending commitments", () => {
	it("appends (N pending) when pendingCommitments has items", () => {
		const op = makeOp({ id: 3, outcome: "partial", pendingCommitments: ["task A", "task B"] });
		const entry = renderArchiveEntry(op);
		expect(entry).toContain("(2 pending)");
	});

	it("shows correct count for single pending commitment", () => {
		const op = makeOp({ id: 5, outcome: "success", pendingCommitments: ["one task"] });
		const entry = renderArchiveEntry(op);
		expect(entry).toContain("(1 pending)");
	});

	it("has no pending annotation when pendingCommitments is empty", () => {
		const op = makeOp({ id: 2, outcome: "success", pendingCommitments: [] });
		const entry = renderArchiveEntry(op);
		expect(entry).not.toContain("pending");
	});

	it("has no pending annotation when pendingCommitments is absent", () => {
		const op = makeOp({ id: 4, outcome: "success" });
		const entry = renderArchiveEntry(op);
		expect(entry).not.toContain("pending");
	});

	it("pending annotation appears after outcome bracket", () => {
		const op = makeOp({ id: 1, outcome: "partial", pendingCommitments: ["some task"] });
		const entry = renderArchiveEntry(op);
		const outcomeIdx = entry.indexOf("[partial]");
		const pendingIdx = entry.indexOf("(1 pending)");
		expect(outcomeIdx).toBeGreaterThan(-1);
		expect(pendingIdx).toBeGreaterThan(outcomeIdx);
	});

	it("entry remains a one-liner (no newlines)", () => {
		const op = makeOp({ id: 7, outcome: "success", pendingCommitments: ["task X"] });
		const entry = renderArchiveEntry(op);
		expect(entry).not.toContain("\n");
	});
});
