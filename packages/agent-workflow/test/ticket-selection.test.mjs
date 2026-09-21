import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execute } from "../src/orchestration-cli.mjs";
import { github } from "../src/orchestration-github.mjs";
import { selectNext } from "../src/ticket-selection.mjs";

function fixture(t) {
	const dir = mkdtempSync(join(tmpdir(), "ticket-selection-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "batch.json");
	const input = {
		repository: "example/project",
		batchId: "next-batch",
		cwd: dir,
		baseBranch: "main",
		codexModel: "codex-model",
		count: 2,
		models: [
			{
				id: "claude-sonnet-5",
				label: "Sonnet 5",
				thinkingOptions: [{ id: "medium" }],
			},
		],
	};
	const items = Object.fromEntries(
		[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => [
			String(n),
			{
				number: String(n),
				state: "OPEN",
				labels: ["ready-for-agent"],
				dependencies: [],
				assignees: [],
				recommendation: { model: "Sonnet", effort: "medium" },
			},
		]),
	);
	const api = {
		listReady: () =>
			[3, 2, 1].map((n) => ({ number: n, created_at: `2026-01-0${n}` })),
		issue: (n) => structuredClone(items[n]),
		hasImplementationPr: () => false,
	};
	return { dir, path, input, items, api, options: { github: () => api } };
}
test("read-only preview selects oldest first and returns a bounded fixed batch", (t) => {
	const f = fixture(t),
		result = execute("select-next", f.path, f.input, f.options);
	assert.deepEqual(result.tickets, ["1", "2"]);
	assert.equal(result.selectionMode, "fixed");
	assert.deepEqual(readdirSync(f.dir), []);
});
test("eligibility excludes assigned, conflicting labels, open blockers, PRs and unsupported models", (t) => {
	const f = fixture(t);
	f.api.listReady = () =>
		Object.keys(f.items).map((n) => ({ number: n, created_at: "2026-01-01" }));
	f.items[1].assignees = [{ login: "someone" }];
	f.items[2].labels.push("ready-for-human");
	f.items[3].dependencies = ["1"];
	f.api.hasImplementationPr = (n) => n === "4";
	f.items[5].recommendation = null;
	f.items[6].recommendation.effort = "high";
	f.items[7].state = "CLOSED";
	f.items[8].labels = [];
	f.items[9].dependencies = ["7"];
	const result = selectNext(f.path, f.input, f.api);
	assert.deepEqual(result.tickets, ["9", "10"]);
	assert.equal(result.skipped.length, 8);
});
test("existing batches and Paseo-discovered work are excluded including queued and blocked tickets", (t) => {
	const f = fixture(t);
	execute("init", join(f.dir, "existing.json"), {
		...f.input,
		batchId: "existing",
		tickets: [1],
	});
	const result = selectNext(f.path, { ...f.input, excludeTickets: [2] }, f.api);
	assert.deepEqual(result.tickets, ["3"]);
	assert.equal(result.shortfall, 1);
	f.items[3].dependencies = ["1"];
	f.items[1].state = "CLOSED";
	assert.deepEqual(
		selectNext(f.path, { ...f.input, excludeTickets: [2] }, f.api).tickets,
		[],
	);
});
test("init-next persists the selection, never overwrites or replenishes it, and later batches skip it", (t) => {
	const f = fixture(t),
		result = execute("init-next", f.path, f.input, f.options);
	assert.equal(result.initialized, true);
	assert.deepEqual(result.state.ticketOrder, ["1", "2"]);
	assert.equal(result.state.selection.requestedCount, 2);
	assert.throws(
		() => execute("init-next", f.path, f.input, f.options),
		/already exists/,
	);
	const next = execute(
		"init-next",
		join(f.dir, "next.json"),
		{ ...f.input, batchId: "later" },
		f.options,
	);
	assert.deepEqual(next.tickets, ["3"]);
	assert.equal(next.shortfall, 1);
	assert.throws(
		() =>
			execute("init", join(f.dir, "explicit.json"), {
				...f.input,
				batchId: "explicit",
				tickets: [1],
			}),
		/another batch/,
	);
});
test("empty selection creates no batch and tells the skill not to schedule", (t) => {
	const f = fixture(t);
	f.api.listReady = () => [];
	const result = execute("init-next", f.path, f.input, f.options);
	assert.equal(result.initialized, false);
	assert.equal(result.shortfall, 2);
	assert.equal(existsSync(f.path), false);
	assert.deepEqual(readdirSync(f.dir), []);
});
test("selection locks serialize competing initializers", (t) => {
	const f = fixture(t);
	mkdirSync(join(f.dir, ".selection.lock"));
	assert.throws(
		() => execute("init-next", f.path, f.input, f.options),
		/in progress/,
	);
	assert.throws(
		() => execute("init", f.path, { ...f.input, tickets: [1] }),
		/in progress/,
	);
	assert.equal(existsSync(f.path), false);
});
test("invalid requests and transport failures do not initialize state", (t) => {
	const f = fixture(t);
	for (const fields of [
		{ count: 0 },
		{ count: -1 },
		{ count: 1.5 },
		{ count: "2" },
		{ tickets: [1] },
		{ models: [] },
		{ repository: "bad" },
		{ excludeTickets: "1" },
	])
		assert.throws(() =>
			execute("init-next", f.path, { ...f.input, ...fields }, f.options),
		);
	f.api.issue = () => {
		throw new Error("HTTP 403");
	};
	assert.throws(() => execute("init-next", f.path, f.input, f.options), /403/);
	assert.equal(existsSync(f.path), false);
});
test("corrupt existing state fails closed rather than ignoring a possible claim", (t) => {
	const f = fixture(t);
	writeFileSync(join(f.dir, "other.json"), "{broken");
	assert.throws(() => selectNext(f.path, f.input, f.api), /cannot inspect/);
});
test("GitHub discovery paginates, excludes PRs, and detects orchestration implementation references", () => {
	const calls = [];
	let pull = {
		state: "open",
		merged_at: null,
		headRefName: "chore/pin-toolkit-v0.3.1",
	};
	const api = github("example/project", (args) => {
		calls.push(args);
		if (args.at(-1).includes("/issues?"))
			return JSON.stringify([
				[{ number: 1 }, { number: 2, pull_request: {} }],
				[{ number: 3 }],
			]);
		if (args.at(-1).includes("/timeline?"))
			return JSON.stringify([
				[
					{
						event: "cross-referenced",
						source: {
							issue: {
								pull_request: {
									url: "https://api.github.com/repos/example/project/pulls/12",
								},
							},
						},
					},
				],
			]);
		return JSON.stringify(pull);
	});
	assert.deepEqual(
		api.listReady().map((i) => i.number),
		[1, 3],
	);
	assert.ok(calls[0].includes("--paginate"));
	assert.ok(calls[0].includes("--slurp"));
	assert.equal(api.hasImplementationPr(1), false);
	pull.headRefName = "tickets/intake-2026092115/1";
	assert.equal(api.hasImplementationPr(1), true);
	pull = {
		state: "closed",
		merged_at: null,
		headRefName: "tickets/intake-2026092115/1",
	};
	assert.equal(api.hasImplementationPr(1), false);
	pull.merged_at = "2026-01-01";
	assert.equal(api.hasImplementationPr(1), true);
});

test("GitHub fallback accepts the authored None (can start immediately) declaration", () => {
	const api = github("example/project", (args) =>
		args[0] === "api"
			? "[[]]"
			: JSON.stringify({
					number: 14,
					body: "## Blocked by\n\nNone (can start immediately).\n",
					labels: [{ name: "ready-for-agent" }],
					state: "OPEN",
					assignees: [],
				}),
	);
	assert.deepEqual(api.issue(14).dependencies, []);
});
