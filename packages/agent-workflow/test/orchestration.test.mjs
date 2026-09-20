import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	acquire,
	assertLease,
	changeTicket,
	checkCycles,
	disposition,
	newBatch,
	reconcile,
	renew,
} from "../src/orchestration.mjs";
import { execute } from "../src/orchestration-cli.mjs";
import {
	fallbackDependencies,
	github,
	recommendation,
	resolveRuntime,
} from "../src/orchestration-github.mjs";

const manifest = () => ({
	repository: "example/project",
	batchId: "pilot",
	cwd: "/tmp/project",
	baseBranch: "main",
	codexModel: "test-codex",
	tickets: [7, 8, 9],
});
const runtime = { provider: "claude/test", thinkingOptionId: "medium" };
const models = [
	{
		id: "claude-sonnet-5",
		label: "Sonnet 5",
		thinkingOptions: [{ id: "medium" }, { id: "high" }],
	},
];
const issue = (n, deps = []) => ({
	number: String(n),
	state: "OPEN",
	labels: ["ready-for-agent"],
	dependencies: deps.map(String),
	recommendation: { model: "Sonnet", effort: "medium" },
});
const snapshot = () => ({
	7: issue(7, [2]),
	8: issue(8, [7]),
	9: issue(9, [2]),
	2: { ...issue(2), state: "CLOSED" },
});
function worker(s, n) {
	changeTicket(s, n, "reserve", runtime);
	changeTicket(s, n, "attach", { workspaceId: `w${n}`, agentId: `a${n}` });
}
function pull() {
	return {
		number: 17,
		state: "OPEN",
		mergedAt: null,
		baseRefName: "main",
		headRefName: "tickets/pilot/7",
		headRefOid: "abc",
		headRepository: { name: "project" },
		headRepositoryOwner: { login: "example" },
		statusCheckRollup: [],
	};
}
function fixture(t) {
	const dir = mkdtempSync(join(tmpdir(), "orchestration-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "state.json");
	execute("init", path, manifest());
	const { token } = execute("acquire", path);
	return { path, token };
}
test("validates batch identity, ticket uniqueness and concurrency", () => {
	for (const change of [
		{ repository: "bad" },
		{ batchId: "../bad" },
		{ tickets: [7, "#7"] },
		{ tickets: [";rm"] },
		{ concurrency: 4 },
		{ tickets: [] },
	])
		assert.throws(() => newBatch({ ...manifest(), ...change }));
	assert.equal(newBatch(manifest()).concurrency, 3);
});
test("renewable lease fences previous owner after expiry", () => {
	const s = newBatch(manifest()),
		first = acquire(s, 0);
	assert.equal(acquire(s, 1).acquired, false);
	renew(s, first.token, 100);
	assert.equal(acquire(s, 600050).acquired, false);
	const second = acquire(s, 600101);
	assert.equal(second.acquired, true);
	assert.throws(() => assertLease(s, first.token, 600102));
	assertLease(s, second.token, 600102);
});
test("dependency order and external blockers do not expand selection", () => {
	const s = newBatch(manifest()),
		issues = snapshot();
	assert.deepEqual(reconcile(s, issues).launchable, ["7", "9"]);
	s.tickets[7].status = "awaiting_merge";
	assert.equal(reconcile(s, issues).launchable.includes("8"), false);
	s.tickets[7].status = "completed";
	assert.equal(reconcile(s, issues).launchable.includes("8"), true);
	assert.throws(
		() => checkCycles({ 7: issue(7, [8]), 8: issue(8, [7]) }),
		/cycle/,
	);
	const waiting = newBatch(manifest());
	issues[2].state = "OPEN";
	assert.deepEqual(reconcile(waiting, issues).launchable, []);
	assert.equal(Object.keys(waiting.tickets).length, 3);
});
test("reservations prevent duplicates and cap execution while awaiting merge frees slots", () => {
	const s = newBatch({ ...manifest(), tickets: [7, 8, 9, 10] });
	for (const n of [7, 8, 9]) worker(s, n);
	assert.throws(() => worker(s, 10), /slot/);
	assert.throws(() => worker(s, 7), /invalid/);
	changeTicket(s, 7, "review", { evidence: "tests and diff" });
	s.tickets[7].pr = 17;
	changeTicket(s, 7, "ready", {
		evidence: "review complete",
		reviewedHead: "abc",
	});
	worker(s, 10);
});
test("two fixes then human block; permission waits keep their execution slot", () => {
	const s = newBatch(manifest());
	worker(s, 7);
	for (let i = 0; i < 2; i++) {
		changeTicket(s, 7, "review", { evidence: "result" });
		assert.equal(
			changeTicket(s, 7, "fix", { reason: "test failure" }).status,
			"implementing",
		);
	}
	changeTicket(s, 7, "review", { evidence: "result" });
	assert.equal(
		changeTicket(s, 7, "fix", { reason: "still wrong" }).status,
		"blocked",
	);
	assert.throws(
		() => changeTicket(s, 7, "resume", { evidence: "retry" }),
		/resetFixCycles/,
	);
	worker(s, 9);
	changeTicket(s, 9, "block", { reason: "permission" });
	assert.equal(s.tickets[9].workerActive, true);
});
test("uncertain launches require reconciliation before resume", () => {
	const s = newBatch(manifest());
	changeTicket(s, 7, "reserve", runtime);
	changeTicket(s, 7, "block", { reason: "interrupted" });
	assert.throws(
		() => changeTicket(s, 7, "resume", { evidence: "short agent list empty" }),
		/uncertain/,
	);
	changeTicket(s, 7, "attach", { workspaceId: "w", agentId: "a" });
	changeTicket(s, 7, "resume", { evidence: "matched launchKey" });
	assert.equal(s.tickets[7].status, "implementing");
	assert.throws(
		() => changeTicket(s, 7, "attach", { agentId: "other" }),
		/already/,
	);
});
test("schedule pauses for human blocked chains, waits for merges, stops when complete", () => {
	const s = newBatch(manifest());
	reconcile(s, snapshot());
	for (const n of [7, 9])
		changeTicket(s, n, "block", { reason: "clarify", workerStopped: true });
	s.tickets[8].dependencies = ["7"];
	assert.equal(disposition(s).pauseSchedule, true);
	s.tickets[7].status = "awaiting_merge";
	assert.equal(disposition(s).pauseSchedule, false);
	for (const t of Object.values(s.tickets)) t.status = "completed";
	assert.equal(disposition(s).pauseSchedule, true);
});
test("closed ready issue cannot launch", () => {
	const s = newBatch(manifest()),
		issues = snapshot();
	issues[7].state = "CLOSED";
	assert.equal(reconcile(s, issues).launchable.includes("7"), false);
	assert.equal(s.tickets[7].blockKind, "human");
});
test("body dependencies and recommendations parse real ticket formats", () => {
	assert.deepEqual(fallbackDependencies("Blocked by: #2, #3"), ["2", "3"]);
	assert.deepEqual(fallbackDependencies("## Blocked by\n\n#7 (CSV export)\n"), [
		"7",
	]);
	assert.deepEqual(
		fallbackDependencies("## Blocked by\n\n#7\n\n## Notes\n#99"),
		["7"],
	);
	assert.deepEqual(recommendation("- **Claude:** `Sonnet / medium`"), {
		model: "Sonnet",
		effort: "medium",
	});
	assert.throws(() => fallbackDependencies("Blocked by: something"), /parse/);
});
test("model resolver respects exact names and advertised effort", () => {
	assert.deepEqual(
		resolveRuntime({ model: "Sonnet", effort: "medium" }, models),
		{ provider: "claude/claude-sonnet-5", thinkingOptionId: "medium" },
	);
	assert.throws(
		() => resolveRuntime({ model: "Sonnet", effort: "max" }, models),
		/unsupported/,
	);
	assert.throws(
		() =>
			resolveRuntime({ model: "claude-sonnet-4-6", effort: "medium" }, models),
		/unsupported/,
	);
});
test("dependency errors fail closed except unsupported endpoint; empty native edges fall back", () => {
	const data = {
		number: 7,
		body: "## Blocked by\n\n#2",
		labels: [],
		state: "OPEN",
	};
	assert.deepEqual(
		github("example/project", (a) =>
			a[0] === "api" ? "[[]]" : JSON.stringify(data),
		).issue(7).dependencies,
		["2"],
	);
	for (const code of [403, 404]) {
		const api = github("example/project", (a) => {
			if (a[0] === "api") throw new Error(`HTTP ${code}`);
			return JSON.stringify(data);
		});
		if (code === 403) assert.throws(() => api.issue(7), /403/);
		else assert.deepEqual(api.issue(7).dependencies, ["2"]);
	}
});
test("completion requires matching merged PR and retries partial label/closure writes", () => {
	const s = newBatch(manifest());
	worker(s, 7);
	const t = s.tickets[7];
	t.pr = 17;
	const pr = pull(),
		item = { body: "", labels: [{ name: "ready-for-agent" }], state: "OPEN" };
	let closes = 0,
		fail = true;
	const api = github("example/project", (a) => {
		if (a[0] === "pr") return JSON.stringify(pr);
		if (a[0] === "label") return "";
		if (a[1] === "view") return JSON.stringify(item);
		if (a[1] === "edit") {
			item.labels = [{ name: "done" }];
			return "";
		}
		if (a[1] === "close") {
			if (fail) {
				fail = false;
				throw new Error("network interrupted");
			}
			item.state = "CLOSED";
			closes++;
			return "";
		}
		throw new Error("unexpected call");
	});
	assert.throws(() => api.finalize(s, t), /not merged/);
	assert.equal(item.state, "OPEN");
	pr.state = "MERGED";
	pr.mergedAt = "2026-09-20";
	assert.throws(() => api.finalize(s, t), /interrupted/);
	assert.notEqual(t.status, "completed");
	api.finalize(s, t);
	api.finalize(s, t);
	assert.equal(closes, 1);
	assert.equal(t.status, "completed");
	assert.deepEqual(item.labels, [{ name: "done" }]);
	pr.headRefName = "wrong";
	assert.throws(() => api.finalize(s, t), /does not match/);
});
test("CLI persists reservations across restarts and rejects competing lease owners", (t) => {
	const { path, token } = fixture(t),
		options = { github: () => ({ snapshot, pr: pull }) };
	assert.equal(execute("acquire", path).acquired, false);
	execute("sync", path, { token }, options);
	execute("reserve", path, { token, number: 7, models }, options);
	assert.equal(execute("status", path).tickets[7].launchUncertain, true);
	assert.throws(
		() => execute("reserve", path, { token, number: 7, models }, options),
		/invalid/,
	);
	assert.throws(
		() =>
			execute(
				"attach",
				path,
				{ token: "wrong", number: 7, workspaceId: "x" },
				options,
			),
		/lease/,
	);
	execute("release", path, { token }, options);
	assert.equal(execute("acquire", path).acquired, true);
});
test("CLI does not complete open PR; rejects failing checks and invalidates changed heads", (t) => {
	const { path, token } = fixture(t),
		pr = pull(),
		options = {
			github: () => ({
				snapshot,
				pr: () => pr,
				finalize: () => {
					throw new Error("must not finalize");
				},
			}),
		};
	execute("reserve", path, { token, number: 7, models }, options);
	execute(
		"attach",
		path,
		{ token, number: 7, workspaceId: "w", agentId: "a" },
		options,
	);
	execute("link-pr", path, { token, number: 7, pr: 17 }, options);
	execute("review", path, { token, number: 7, evidence: "tests" }, options);
	pr.statusCheckRollup = [{ status: "IN_PROGRESS" }];
	assert.throws(
		() =>
			execute(
				"ready",
				path,
				{ token, number: 7, evidence: "diff", reviewedHead: "abc" },
				options,
			),
		/pending/,
	);
	pr.statusCheckRollup = [];
	execute(
		"ready",
		path,
		{ token, number: 7, evidence: "diff", reviewedHead: "abc" },
		options,
	);
	execute("sync", path, { token }, options);
	assert.equal(execute("status", path).tickets[7].status, "awaiting_merge");
	pr.headRefOid = "new";
	execute("sync", path, { token }, options);
	assert.equal(execute("status", path).tickets[7].status, "blocked");
	pr.state = "CLOSED";
	execute("sync", path, { token }, options);
	assert.match(execute("status", path).tickets[7].reason, /without merge/);
});
test("abandoned filesystem mutex is never silently stolen", (t) => {
	const { path } = fixture(t);
	mkdirSync(`${path}.mutex`);
	assert.throws(() => execute("acquire", path), /state busy/);
});

test("manifest priority order is preserved", () => {
	const s = newBatch({ ...manifest(), tickets: [9, 7, 8] });
	assert.deepEqual(disposition(s).launchable, ["9", "7", "8"]);
});
test("explicit recovery cannot exceed execution limit", () => {
	const s = newBatch({ ...manifest(), tickets: [7, 8, 9, 10] });
	worker(s, 7);
	changeTicket(s, 7, "block", { reason: "stopped", workerStopped: true });
	for (const n of [8, 9, 10]) worker(s, n);
	assert.throws(
		() => changeTicket(s, 7, "resume", { evidence: "permission resolved" }),
		/slot/,
	);
});
test("completion releases dependent ticket on same sync and schedule identity cannot change", (t) => {
	const { path, token } = fixture(t),
		issues = snapshot(),
		pr = pull();
	const options = {
		github: () => ({
			snapshot: () => issues,
			pr: () => pr,
			finalize: (_s, ticket) => {
				ticket.status = "completed";
				ticket.workerActive = false;
			},
		}),
	};
	execute("reserve", path, { token, number: 7, models }, options);
	execute(
		"attach",
		path,
		{ token, number: 7, workspaceId: "w", agentId: "a" },
		options,
	);
	execute("link-pr", path, { token, number: 7, pr: 17 }, options);
	pr.state = "MERGED";
	pr.mergedAt = "2026-09-20";
	issues[7].state = "CLOSED";
	assert.ok(execute("sync", path, { token }, options).launchable.includes("8"));
	execute("schedule", path, { token, scheduleId: "s1" }, options);
	assert.throws(
		() => execute("schedule", path, { token, scheduleId: "s2" }, options),
		/already/,
	);
});
