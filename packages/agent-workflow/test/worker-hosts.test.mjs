import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	normalizeWorkerHosts,
	readRepositoryIntakeConfig,
} from "../src/intake-config.mjs";
import {
	atomicWrite,
	changeTicket,
	disposition,
	newBatch,
} from "../src/orchestration.mjs";
import { execute } from "../src/orchestration-cli.mjs";
import { schedulePrompt } from "../src/schedule-prompt.mjs";
import { capacity, intakeCommand } from "../src/ticket-intake.mjs";
import { approved } from "./approval-fixtures.mjs";

const cloud = {
	id: "cloud",
	paseoHost: "100.64.0.9:6767",
	cwd: "/srv/checkout",
	count: 1,
	excludeLabels: ["needs-asset-host"],
	passwordEnv: "PASEO_CLOUD_PASSWORD",
};
const base = {
	repository: "example/project",
	baseBranch: "main",
	codexModel: "codex-model",
	count: 2,
};
const models = [
	{
		id: "claude-sonnet-5",
		label: "Sonnet 5",
		thinkingOptions: [{ id: "medium" }],
	},
];

function writeConfig(cwd, extra = {}) {
	writeFileSync(
		join(cwd, "toolkit-intake.json"),
		JSON.stringify({ version: 1, ...base, workerHosts: [cloud], ...extra }),
	);
}
// Six ready tickets; the ones in `labelled` carry the label the cloud host
// excludes, so they can only run locally.
function fixture(t, labelled = []) {
	const cwd = mkdtempSync(join(tmpdir(), "worker-hosts-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	writeConfig(cwd);
	const api = {
		listReady: () =>
			Array.from({ length: 6 }, (_, i) => ({
				number: i + 1,
				created_at: "2026-01-01",
			})),
		issue: (n) => ({
			number: String(n),
			state: "OPEN",
			labels: [
				"ready-for-agent",
				...(labelled.includes(String(n)) ? ["needs-asset-host"] : []),
			],
			dependencies: [],
			assignees: [],
			recommendation: { model: "Sonnet", effort: "medium" },
		}),
		hasImplementationPr: () => false,
		subTickets: () => [],
		approval: () => approved(),
		snapshot: (state) =>
			Object.fromEntries(
				Object.keys(state.tickets).map((n) => [n, api.issue(n)]),
			),
	};
	const options = {
		github: () => api,
		now: Date.parse("2026-09-21T09:00:00Z"),
		schedule: {
			id: "s1",
			name: "ticket-intake:example/project",
			paused: false,
		},
	};
	intakeCommand("configure", cwd);
	intakeCommand("schedule", cwd, { scheduleId: "s1" });
	return { cwd, api, options };
}
function update(path, fn) {
	const state = JSON.parse(readFileSync(path, "utf8"));
	fn(state);
	atomicWrite(path, state);
}

test("workerHosts are validated and normalized from the tracked config", (t) => {
	assert.deepEqual(normalizeWorkerHosts(undefined), []);
	assert.deepEqual(
		normalizeWorkerHosts([
			{ id: "a", paseoHost: " h:1 ", cwd: "/x", count: 2 },
		]),
		[{ id: "a", paseoHost: "h:1", cwd: "/x", count: 2, excludeLabels: [] }],
	);
	const bad = (host, pattern) =>
		assert.throws(() => normalizeWorkerHosts([{ ...cloud, ...host }]), pattern);
	bad({ id: "local" }, /id must be a lowercase slug/);
	bad({ id: "Cloud" }, /id must be a lowercase slug/);
	bad({ paseoHost: "h:1?password=x" }, /no query, fragment or whitespace/);
	bad({ paseoHost: "paseo://h#offer" }, /no query, fragment or whitespace/);
	bad({ cwd: "srv/checkout" }, /absolute path on that host/);
	bad({ cwd: "/srv/../etc" }, /absolute path on that host/);
	bad({ count: 0 }, /count must be a positive integer/);
	bad({ passwordEnv: "lower" }, /environment variable name/);
	bad({ excludeLabels: [""] }, /excludeLabels must contain non-empty/);
	bad({ extra: true }, /unknown field extra/);
	assert.throws(
		() => normalizeWorkerHosts([cloud, { ...cloud, paseoHost: "other:1" }]),
		/duplicate workerHosts id cloud/,
	);
	assert.throws(() => normalizeWorkerHosts({}), /must be an array/);
	const cwd = mkdtempSync(join(tmpdir(), "worker-hosts-config-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	writeConfig(cwd);
	assert.deepEqual(readRepositoryIntakeConfig(cwd).workerHosts, [cloud]);
	assert.deepEqual(intakeCommand("configure", cwd).workerHosts, [cloud]);
	writeConfig(cwd, { workerHosts: "cloud" });
	assert.throws(() => intakeCommand("sync-config", cwd), /must be an array/);
});

test("tick fills local slots first, then hosts whose labels allow the ticket", (t) => {
	const f = fixture(t, ["1", "3"]);
	const tick = intakeCommand("tick", f.cwd, { models }, f.options);
	assert.equal(tick.status, "admitted");
	// #1 and #2 take the two local slots; #3 is labelled and the only host
	// left excludes that label; #4 takes the host's one slot.
	assert.deepEqual(tick.tickets, ["1", "2", "4"]);
	assert.deepEqual(tick.placement, { 1: "local", 2: "local", 4: "cloud" });
	assert.deepEqual(tick.skipped, [
		{
			number: "3",
			reason: "no worker host with a free slot accepts its labels",
		},
	]);
	const state = JSON.parse(readFileSync(tick.batchFile, "utf8"));
	assert.equal(state.tickets[4].host, "cloud");
	assert.equal(state.tickets[1].host, undefined);
	assert.deepEqual(tick.capacity.hosts.cloud, {
		limit: 1,
		active: 0,
		queued: 1,
		executionSlots: 1,
		admissionSlots: 0,
	});
	assert.equal(tick.capacity.admissionSlots, 0);

	const { token } = execute("acquire", tick.batchFile);
	const sync = execute("sync", tick.batchFile, { token }, f.options);
	// Batch concurrency (two) covers local tickets only; the host ticket is
	// launchable alongside them.
	assert.deepEqual(sync.launchable, ["1", "2", "4"]);
	assert.deepEqual(
		sync.tickets.find((x) => x.number === "4"),
		{ number: "4", status: "queued", reason: null, host: "cloud" },
	);
	const remote = execute(
		"reserve",
		tick.batchFile,
		{ token, number: "4", models },
		f.options,
	);
	assert.deepEqual(remote.workerHost, {
		id: "cloud",
		paseoHost: "100.64.0.9:6767",
		cwd: "/srv/checkout",
		passwordEnv: "PASEO_CLOUD_PASSWORD",
	});
	assert.equal(remote.host, "cloud");
	const local = execute(
		"reserve",
		tick.batchFile,
		{ token, number: "1", models },
		f.options,
	);
	assert.equal(local.workerHost, null);
	assert.equal(
		capacity(join(f.cwd, ".toolkit/orchestration/x.json"), base.repository)
			.hosts.cloud.executionSlots,
		0,
	);
	assert.deepEqual(
		execute("sync", tick.batchFile, { token }, f.options).launchable,
		["2"],
	);

	// The host is full and local slots are reserved by queued #2, so the
	// next hour admits nothing until the host ticket stops running.
	const nextHour = { ...f.options, now: f.options.now + 3600_000 };
	assert.equal(
		intakeCommand("tick", f.cwd, { models }, nextHour).status,
		"capacity-full",
	);
	update(tick.batchFile, (s) => {
		s.tickets[4].status = "awaiting_merge";
		s.tickets[4].workerActive = false;
		s.tickets[4].launchUncertain = false;
	});
	const later = intakeCommand("tick", f.cwd, { models }, nextHour);
	assert.deepEqual(later.tickets, ["5"]);
	assert.deepEqual(later.placement, { 5: "cloud" });
});

test("host limits are enforced at reserve and when lowering a host's count", (t) => {
	const f = fixture(t);
	const tick = intakeCommand("tick", f.cwd, { models }, f.options);
	assert.deepEqual(tick.placement, { 1: "local", 2: "local", 3: "cloud" });
	// A second queued host ticket, as a stale batch could hold after a config
	// change, must not reserve past the host's limit.
	update(tick.batchFile, (s) => {
		s.ticketOrder.push("4");
		s.tickets[4] = {
			number: "4",
			status: "queued",
			fixCycles: 0,
			host: "cloud",
		};
	});
	const { token } = execute("acquire", tick.batchFile);
	execute("reserve", tick.batchFile, { token, number: "3", models }, f.options);
	assert.throws(
		() =>
			execute(
				"reserve",
				tick.batchFile,
				{ token, number: "4", models },
				f.options,
			),
		/worker host cloud execution limit reached/,
	);
	update(tick.batchFile, (s) => {
		s.tickets[4].status = "implementing";
		s.tickets[4].workerActive = true;
	});
	assert.throws(
		() => intakeCommand("sync-config", f.cwd),
		/worker host cloud is below its current active work/,
	);
	writeConfig(f.cwd, { workerHosts: [{ ...cloud, count: 2 }] });
	assert.equal(intakeCommand("sync-config", f.cwd).workerHosts[0].count, 2);
});

test("reserve refuses a host removed from the config or a newly excluded label", (t) => {
	const f = fixture(t);
	const tick = intakeCommand("tick", f.cwd, { models }, f.options);
	const { token } = execute("acquire", tick.batchFile);
	const issue = f.api.issue;
	f.api.issue = (n) => {
		const item = issue(n);
		if (n === "3") item.labels.push("needs-asset-host");
		return item;
	};
	assert.throws(
		() =>
			execute(
				"reserve",
				tick.batchFile,
				{ token, number: "3", models },
				f.options,
			),
		/worker host cloud excludes label needs-asset-host/,
	);
	f.api.issue = issue;
	writeConfig(f.cwd, { workerHosts: undefined });
	intakeCommand("sync-config", f.cwd);
	assert.throws(
		() =>
			execute(
				"reserve",
				tick.batchFile,
				{ token, number: "3", models },
				f.options,
			),
		/worker host cloud is no longer configured/,
	);
	// Its work is still reported, under the host, with no limit.
	const summary = capacity(
		join(f.cwd, ".toolkit/orchestration/x.json"),
		base.repository,
	);
	assert.deepEqual(summary.hosts.cloud, {
		limit: null,
		active: 0,
		queued: 1,
		executionSlots: null,
		admissionSlots: null,
	});
	assert.equal(summary.queued, 2);
});

test("cleanup for a host ticket returns the remote command, then records the result", (t) => {
	const f = fixture(t);
	writeConfig(f.cwd, { cleanupCommand: "scripts/cleanup.mjs" });
	const tick = intakeCommand("tick", f.cwd, { models }, f.options);
	const { token } = execute("acquire", tick.batchFile);
	execute("reserve", tick.batchFile, { token, number: "3", models }, f.options);
	const cleanup = (extra) =>
		execute("cleanup", tick.batchFile, {
			token,
			number: "3",
			worktreePath: "/home/worker/.paseo/worktrees/x",
			...extra,
		});
	assert.throws(() => cleanup({ worktreePath: "relative" }), /absolute path/);
	assert.deepEqual(cleanup(), {
		ticket: "3",
		ran: false,
		host: "cloud",
		paseoHost: "100.64.0.9:6767",
		command: [
			"node",
			"/srv/checkout/scripts/cleanup.mjs",
			"/home/worker/.paseo/worktrees/x",
			`tickets/${tick.batchFile.match(/intake-\d+/)[0]}/3`,
			"3",
		],
	});
	assert.equal(
		JSON.parse(readFileSync(tick.batchFile, "utf8")).tickets[3].cleanup,
		undefined,
	);
	assert.throws(
		() => cleanup({ remoteResult: { ok: "yes" } }),
		/ok must be a boolean/,
	);
	assert.deepEqual(
		cleanup({ remoteResult: { ok: false, error: " down failed " } }),
		{
			ticket: "3",
			ran: true,
			ok: false,
			host: "cloud",
			error: "down failed",
		},
	);
	const recorded = JSON.parse(readFileSync(tick.batchFile, "utf8")).tickets[3];
	assert.equal(recorded.cleanup.ok, false);
	assert.equal(recorded.cleanup.host, "cloud");
	assert.equal(recorded.status, "implementing");
	assert.deepEqual(cleanup({ remoteResult: { ok: true } }), {
		ticket: "3",
		ran: true,
		ok: true,
		host: "cloud",
	});
});

test("batch disposition caps local tickets by concurrency and leaves host tickets launchable", () => {
	const state = newBatch({
		repository: "example/project",
		batchId: "pilot",
		cwd: "/tmp/project",
		baseBranch: "main",
		codexModel: "codex-model",
		tickets: [7, 8, 9],
		concurrency: 1,
	});
	state.tickets[7].status = "implementing";
	state.tickets[9].host = "cloud";
	const result = disposition(state);
	assert.equal(result.slots, 0);
	assert.deepEqual(result.launchable, ["9"]);
	assert.deepEqual(result.tickets[2], {
		number: "9",
		status: "queued",
		reason: undefined,
		host: "cloud",
	});
	// Resuming a host ticket's worker does not need a local slot.
	Object.assign(state.tickets[9], {
		status: "blocked",
		previousStatus: "reviewing",
		blockKind: "human",
		agentId: "a9",
		workspaceId: "w9",
	});
	assert.equal(
		changeTicket(state, 9, "resume", { evidence: "fixed" }).status,
		"reviewing",
	);
	state.tickets[8].host = undefined;
	Object.assign(state.tickets[8], {
		status: "blocked",
		previousStatus: "reviewing",
		blockKind: "human",
		agentId: "a8",
	});
	assert.throws(
		() => changeTicket(state, 8, "resume", { evidence: "fixed" }),
		/no execution slot to resume/,
	);
});

test("the schedule prompt names worker-host handling only when hosts are configured", (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "worker-hosts-prompt-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	writeFileSync(
		join(cwd, "toolkit-intake.json"),
		JSON.stringify({ version: 1, ...base }),
	);
	assert.doesNotMatch(schedulePrompt(cwd), /Worker hosts/);
	writeConfig(cwd);
	const prompt = schedulePrompt(cwd);
	assert.match(prompt, /^12\. Worker hosts are configured\./m);
	assert.match(prompt, /paseo --host <paseoHost> workspace create/);
	assert.match(
		prompt,
		/Export PASEO_PASSWORD from the variable `passwordEnv` names/,
	);
	assert.match(prompt, /remoteResult/);
	assert.doesNotMatch(prompt, /100\.64\.0\.9|PASEO_CLOUD_PASSWORD/);
});
