import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fallbackDependencies } from "../src/orchestration-github.mjs";
import { selectNext } from "../src/ticket-selection.mjs";

test("accepts Markdown list declarations and local issue URLs", () => {
	assert.deepEqual(
		fallbackDependencies(
			"## Blocked by\n\n- None (can start immediately)",
			"owner/repo",
		),
		[],
	);
	assert.deepEqual(
		fallbackDependencies("## Blocked by\n\n- #7\n- #8", "owner/repo"),
		["7", "8"],
	);
	assert.deepEqual(
		fallbackDependencies(
			"## Blocked by\n\n- https://github.com/owner/repo/issues/7",
			"owner/repo",
		),
		["7"],
	);
	assert.throws(
		() =>
			fallbackDependencies(
				"## Blocked by\n\n- https://github.com/other/repo/issues/7",
				"owner/repo",
			),
		/cross-repository/,
	);
});

test("skips malformed candidate metadata and continues selection", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "intake-regression-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const invalid = new Error("Issue #1 has an invalid Blocked by declaration");
	invalid.code = "INVALID_DEPENDENCY_DECLARATION";
	const api = {
		listReady: () => [
			{ number: 1, created_at: "2026-01-01" },
			{ number: 2, created_at: "2026-01-02" },
		],
		issue: (number) => {
			if (String(number) === "1") throw invalid;
			return {
				number: "2",
				state: "OPEN",
				labels: ["ready-for-agent"],
				dependencies: [],
				assignees: [],
				recommendation: { model: "Sonnet", effort: "medium" },
			};
		},
		hasImplementationPr: () => false,
	};
	const result = selectNext(
		join(dir, "batch.json"),
		{
			repository: "owner/repo",
			batchId: "next",
			cwd: dir,
			baseBranch: "main",
			codexModel: "codex",
			count: 1,
			models: [
				{
					id: "claude-sonnet-5",
					label: "Sonnet 5",
					thinkingOptions: [{ id: "medium" }],
				},
			],
		},
		api,
	);
	assert.deepEqual(result.tickets, ["2"]);
	assert.equal(result.skipped[0].reason, "invalid dependency declaration");
});
