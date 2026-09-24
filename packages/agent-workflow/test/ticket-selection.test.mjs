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
		subTickets: () => [],
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
test("accepts Paseo thinking option IDs without rejecting eligible tickets", (t) => {
	const f = fixture(t);
	f.input.models = f.input.models.map(({ thinkingOptions, ...model }) => ({
		...model,
		thinkingOptionIds: thinkingOptions.map(({ id }) => id),
	}));
	assert.deepEqual(selectNext(f.path, f.input, f.api).tickets, ["1", "2"]);
});
test("rejects a malformed model catalog before reading tickets", (t) => {
	const f = fixture(t);
	f.input.models = [{ id: "claude-sonnet-5", label: "Sonnet 5" }];
	f.api.listReady = () => {
		throw new Error("GitHub should not be read");
	};
	assert.throws(
		() => selectNext(f.path, f.input, f.api),
		/invalid Paseo Claude model catalog: models\[0\].thinkingOptions/,
	);
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
test("parent specs are skipped in favour of their sub-tickets", (t) => {
	const f = fixture(t);
	f.api.subTickets = (n) => (n === "1" ? ["2", "3"] : []);
	const result = selectNext(f.path, f.input, f.api);
	assert.deepEqual(result.tickets, ["2", "3"]);
	assert.deepEqual(result.skipped, [
		{
			number: "1",
			reason: "parent spec with sub-tickets",
			subTickets: ["2", "3"],
		},
	]);
});
function parentApi(issues, subIssues = {}) {
	const calls = [];
	const api = github("example/project", (args) => {
		calls.push(args);
		const path = args.at(-1);
		if (path.includes("/issues?state=all"))
			return issues.map((item) => JSON.stringify(item)).join("\n");
		const native = /\/issues\/(\d+)\/sub_issues/.exec(path);
		if (native) return JSON.stringify([subIssues[native[1]] ?? []]);
		throw new Error(`unexpected gh call: ${args.join(" ")}`);
	});
	return { api, calls };
}
test("sub-tickets come from Parent sections and native sub-issues, fetched once", () => {
	const { api, calls } = parentApi(
		[
			{ number: 20, body: "Phase spec", sub_issues_summary: { total: 0 } },
			{ number: 21, state: "closed", body: "## Parent\n\n#20 (Phase)\n" },
			{
				number: 22,
				body: "**Parent:** https://github.com/example/project/issues/20",
			},
			{
				number: 23,
				body: "## Parent\n\nhttps://github.com/other/repo/issues/20",
			},
			{ number: 24, body: "## Parent\n\n#24" },
			{ number: 25, pull_request: {}, body: "## Parent\n\n#20" },
			{ number: 30, body: "Native parent", sub_issues_summary: { total: 1 } },
		],
		{ 30: [{ number: 31 }] },
	);
	assert.deepEqual(api.subTickets(20), ["21", "22"]);
	assert.deepEqual(api.subTickets("#30"), ["31"]);
	assert.deepEqual(api.subTickets(24), []);
	assert.equal(
		calls.filter((a) => a.at(-1).includes("/issues?state=all")).length,
		1,
	);
});
test("sub-ticket lookup fails closed rather than admitting a possible parent", () => {
	const api = github("example/project", () => {
		throw new Error("HTTP 502");
	});
	assert.throws(() => api.subTickets(20), /issue #20.*sub-tickets.*HTTP 502/);
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
function restSelection(t, pulls, failPull = false) {
	const f = fixture(t);
	const calls = [];
	const api = github("example/project", (args) => {
		calls.push(args);
		const path = args.at(-1);
		if (path.includes("/issues?state=all")) return "";
		if (path.includes("/issues?"))
			return JSON.stringify([[{ number: 49, created_at: "2026-01-01" }]]);
		if (args[0] === "issue" && args[1] === "view" && args[2] === "49")
			return JSON.stringify({
				number: 49,
				body: "**Claude:** `Sonnet / medium`",
				labels: [{ name: "ready-for-agent" }],
				state: "OPEN",
				assignees: [],
			});
		if (path.includes("/dependencies/blocked_by")) return "[[]]";
		if (path.includes("/timeline?"))
			return JSON.stringify([
				pulls.map((pull) => ({
					event: "cross-referenced",
					source: {
						issue: {
							pull_request: {
								url: `https://api.github.com/repos/example/project/pulls/${pull.number}`,
							},
						},
					},
				})),
			]);
		const number = Number(path.split("/").at(-1));
		const pull = pulls.find((item) => item.number === number);
		if (pull && failPull) throw new Error("HTTP 403");
		if (pull) return JSON.stringify(pull);
		throw new Error(`unexpected gh call: ${args.join(" ")}`);
	});
	return {
		...f,
		api,
		calls,
		select: () => selectNext(f.path, { ...f.input, count: 1 }, api),
	};
}
function restPull(branch, overrides = {}) {
	return {
		number: 76,
		state: "open",
		merged_at: null,
		html_url: "https://github.com/example/project/pull/76",
		head: { ref: branch, repo: { full_name: "example/project" } },
		base: { ref: "main", repo: { full_name: "example/project" } },
		...overrides,
	};
}
test("REST timeline mention of #49 by the #48 implementation PR does not exclude #49", (t) => {
	const f = restSelection(t, [restPull("tickets/intake-2026092115/48")]);
	assert.deepEqual(f.select().tickets, ["49"]);
	assert.ok(
		f.calls.some(
			(args) => args.includes("--paginate") && args.includes("--slurp"),
		),
	);
});
test("selection excludes open and merged same-repository ticket PRs with exact evidence", (t) => {
	for (const overrides of [
		{},
		{ state: "closed", merged_at: "2026-09-22T12:00:00Z" },
	]) {
		const f = restSelection(t, [
			restPull("tickets/intake-2026092115/48"),
			restPull("tickets/intake-2026092115/49", { number: 77, ...overrides }),
		]);
		const result = f.select();
		assert.deepEqual(result.tickets, []);
		assert.deepEqual(result.skipped, [
			{
				number: "49",
				reason: "existing open or merged implementation PR",
				pr: {
					number: 77,
					url: "https://github.com/example/project/pull/77",
					evidence: "same-repository head.ref tickets/intake-2026092115/49",
				},
			},
		]);
	}
});
test("selection admits after a closed unmerged PR and ignores a matching branch from a fork", (t) => {
	const closed = restSelection(t, [
		restPull("tickets/intake-2026092115/49", { state: "closed" }),
	]);
	assert.deepEqual(closed.select().tickets, ["49"]);
	const fork = restSelection(t, [
		restPull("tickets/intake-2026092115/49", {
			head: {
				ref: "tickets/intake-2026092115/49",
				repo: { full_name: "elsewhere/fork" },
			},
		}),
	]);
	assert.deepEqual(fork.select().tickets, ["49"]);
});
test("selection fails closed on ambiguous REST PR identity and GitHub errors", (t) => {
	const malformed = restSelection(t, [
		restPull("tickets/intake-2026092115/49", {
			head: { repo: { full_name: "example/project" } },
		}),
	]);
	assert.throws(() => malformed.select(), /issue #49.*head.ref.*pull\/76/);
	const invalid = restSelection(t, [
		restPull("tickets/intake-2026092115/49", { state: "unknown" }),
	]);
	assert.throws(
		() => invalid.select(),
		/issue #49.*state or identity.*pull\/76/,
	);
	const mismatched = restSelection(t, [
		restPull("tickets/intake-2026092115/49", {
			base: { ref: "main", repo: { full_name: "elsewhere/project" } },
		}),
	]);
	assert.throws(
		() => mismatched.select(),
		/issue #49.*repository mismatch.*pull\/76/,
	);
	const failure = restSelection(
		t,
		[restPull("tickets/intake-2026092115/49")],
		true,
	);
	assert.throws(() => failure.select(), /issue #49.*pull\/76.*HTTP 403/);
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
