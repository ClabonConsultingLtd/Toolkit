import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { atomicWrite } from "../src/orchestration.mjs";
import { execute } from "../src/orchestration-cli.mjs";
import { capacity, intakeCommand, intakePath } from "../src/ticket-intake.mjs";

function fixture(t) {
	const cwd = mkdtempSync(join(tmpdir(), "intake-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const input = {
		repository: "example/project",
		baseBranch: "main",
		codexModel: "codex-model",
		count: 3,
	};
	const models = [
		{
			id: "claude-sonnet-5",
			label: "Sonnet 5",
			thinkingOptions: [{ id: "medium" }],
		},
	];
	const api = {
		listReady: () =>
			Array.from({ length: 10 }, (_, i) => ({
				number: i + 1,
				created_at: "2026-01-01",
			})),
		issue: (n) => ({
			number: String(n),
			state: "OPEN",
			labels: ["ready-for-agent"],
			dependencies: [],
			assignees: [],
			recommendation: { model: "Sonnet", effort: "medium" },
		}),
		hasImplementationPr: () => false,
		subTickets: () => [],
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
	intakeCommand("configure", cwd, input);
	intakeCommand("schedule", cwd, { scheduleId: options.schedule.id });
	return { cwd, input, models, api, options, schedule: options.schedule };
}
function update(path, fn) {
	const state = JSON.parse(readFileSync(path, "utf8"));
	fn(state);
	atomicWrite(path, state);
}
test("9am selects N; 10am admits only free slots; review and awaiting-merge count differently", (t) => {
	const f = fixture(t);
	const first = intakeCommand("tick", f.cwd, { models: f.models }, f.options);
	assert.deepEqual(first.tickets, ["1", "2", "3"]);
	update(first.batchFile, (s) => {
		s.tickets[1].status = "implementing";
		s.tickets[2].status = "reviewing";
		s.tickets[3].status = "awaiting_merge";
	});
	const second = intakeCommand(
		"tick",
		f.cwd,
		{ models: f.models },
		{ ...f.options, now: f.options.now + 3600000 },
	);
	assert.deepEqual(second.tickets, ["4"]);
	const summary = capacity(first.batchFile, f.input.repository);
	assert.equal(summary.active, 2);
	assert.equal(summary.queued, 1);
	assert.equal(summary.admissionSlots, 0);
	const third = intakeCommand(
		"tick",
		f.cwd,
		{ models: f.models },
		{ ...f.options, now: f.options.now + 7200000 },
	);
	assert.equal(third.initialized, false);
	assert.equal(third.status, "capacity-full");
	assert.equal(third.reason, "capacity full");
	assert.equal(third.capacity.admissionSlots, 0);
	assert.match(third.skipped[0].reason, /release a slot/);
});
test("bad catalog cannot persist an empty tick; corrected input admits in the same hour", (t) => {
	const f = fixture(t);
	assert.throws(
		() =>
			intakeCommand(
				"tick",
				f.cwd,
				{ models: [{ id: "claude-sonnet-5", thinkingOptionIds: "medium" }] },
				f.options,
			),
		/invalid Paseo Claude model catalog/,
	);
	assert.equal(
		JSON.parse(
			readFileSync(
				intakePath(join(f.cwd, ".toolkit/orchestration/intake-anchor.json")),
				"utf8",
			),
		).lastTick,
		null,
	);
	const admitted = intakeCommand(
		"tick",
		f.cwd,
		{ models: f.models },
		f.options,
	);
	assert.equal(admitted.status, "admitted");
	assert.deepEqual(admitted.tickets, ["1", "2", "3"]);
});
test("same-hour ticks are idempotent even after a slot becomes free", (t) => {
	const f = fixture(t),
		a = intakeCommand("tick", f.cwd, { models: f.models }, f.options);
	assert.match(a.helper.version, /^\d+\.\d+\.\d+$/);
	assert.match(a.helper.source, /orchestration-github\.mjs$/);
	assert.match(a.helper.sourceSha256, /^[a-f0-9]{64}$/);
	assert.deepEqual(intakeCommand("status", f.cwd).lastTick.helper, a.helper);
	update(a.batchFile, (s) => {
		for (const ticket of Object.values(s.tickets))
			ticket.status = "awaiting_merge";
	});
	const again = intakeCommand("tick", f.cwd, { models: f.models }, f.options);
	assert.equal(again.replayed, true);
	assert.equal(again.status, "replayed");
	assert.equal(again.batchFile, a.batchFile);
	assert.equal(again.capacity.admissionSlots, 3);
	assert.deepEqual(again.activeHelper, a.helper);
	const next = intakeCommand(
		"tick",
		f.cwd,
		{ models: f.models },
		{ ...f.options, now: f.options.now + 3600000 },
	);
	assert.deepEqual(next.tickets, ["4", "5", "6"]);
});
test("empty tick retries after a dependency closes, then keeps the admission idempotent", (t) => {
	const f = fixture(t);
	let dependencyClosed = false;
	f.api.listReady = () => [{ number: 2, created_at: "2026-01-02" }];
	f.api.issue = (number) =>
		String(number) === "1"
			? { number: "1", state: dependencyClosed ? "CLOSED" : "OPEN" }
			: {
					...fixtureIssue(2),
					dependencies: ["1"],
				};
	const empty = intakeCommand("tick", f.cwd, { models: f.models }, f.options);
	assert.equal(empty.status, "empty");
	assert.equal(empty.retried, false);
	assert.equal(empty.capacity.admissionSlots, 3);
	assert.deepEqual(empty.skipped, [{ number: "2", reason: "blocked by #1" }]);
	const stillEmpty = intakeCommand(
		"tick",
		f.cwd,
		{ models: f.models },
		f.options,
	);
	assert.equal(stillEmpty.status, "empty");
	assert.equal(stillEmpty.retried, true);
	dependencyClosed = true;
	const admitted = intakeCommand(
		"tick",
		f.cwd,
		{ models: f.models },
		f.options,
	);
	assert.equal(admitted.status, "admitted");
	assert.equal(admitted.retried, true);
	assert.deepEqual(admitted.tickets, ["2"]);
	assert.equal(admitted.capacity.admissionSlots, 2);
	update(admitted.batchFile, (state) => {
		state.tickets[2].status = "awaiting_merge";
	});
	const replay = intakeCommand("tick", f.cwd, { models: f.models }, f.options);
	assert.equal(replay.status, "replayed");
	assert.deepEqual(replay.tickets, ["2"]);
	assert.equal(replay.capacity.admissionSlots, 3);
});
function fixtureIssue(number) {
	return {
		number: String(number),
		state: "OPEN",
		labels: ["ready-for-agent"],
		dependencies: [],
		assignees: [],
		recommendation: { model: "Sonnet", effort: "medium" },
	};
}
test("overlapping tick cannot select while another tick holds the shared lock", (t) => {
	const f = fixture(t);
	let overlap;
	f.api.listReady = () => {
		const request = join(f.cwd, "request.json");
		writeFileSync(request, JSON.stringify({ models: f.models }));
		overlap = spawnSync(
			process.execPath,
			[
				join(import.meta.dirname, "..", "src", "intake-cli.mjs"),
				"tick",
				f.cwd,
				request,
			],
			{ encoding: "utf8" },
		);
		return [{ number: 1, created_at: "2026-01-01" }];
	};
	const admitted = intakeCommand(
		"tick",
		f.cwd,
		{ models: f.models },
		f.options,
	);
	assert.equal(overlap.status, 1);
	assert.match(overlap.stderr, /another batch selection is in progress/);
	assert.deepEqual(admitted.tickets, ["1"]);
	const replay = intakeCommand("tick", f.cwd, { models: f.models }, f.options);
	assert.equal(replay.status, "replayed");
	assert.equal(replay.batchFile, admitted.batchFile);
});
test("reconfigure preserves a chosen schedule cadence", (t) => {
	const f = fixture(t);
	assert.equal(intakeCommand("status", f.cwd).cron, "*/30 8-19 * * *");
	const cadence = intakeCommand("configure", f.cwd, {
		...f.input,
		cron: "*/30 * * * *",
		timezone: "Europe/London",
	});
	assert.equal(cadence.cron, "*/30 * * * *");
	assert.equal(cadence.timezone, "Europe/London");
	const repeated = intakeCommand("configure", f.cwd, f.input);
	assert.equal(repeated.cron, cadence.cron);
	assert.equal(repeated.timezone, cadence.timezone);
	f.schedule.paused = true;
	intakeCommand("pause", f.cwd, { schedule: f.schedule });
	const paused = intakeCommand("configure", f.cwd, f.input);
	assert.equal(paused.paused, true);
	assert.equal(paused.pauseReason, "Paused in Paseo");
	assert.ok(paused.pausedAt);
	assert.throws(
		() =>
			intakeCommand("configure", f.cwd, {
				...f.input,
				cron: " ",
			}),
		/cron must be a nonempty string/,
	);
});
test("tracked repository config updates capacity and exclusions without resetting runtime state", (t) => {
	const f = fixture(t);
	const configPath = join(f.cwd, "toolkit-intake.json");
	const tracked = {
		version: 1,
		...f.input,
		count: 2,
		cron: "0 * * * *",
		timezone: "Europe/London",
		excludeTickets: [1],
		requiredChecks: ["ci", "smoke"],
	};
	writeFileSync(configPath, JSON.stringify(tracked));
	f.schedule.paused = true;
	intakeCommand("pause", f.cwd, { schedule: f.schedule });
	const synced = intakeCommand("sync-config", f.cwd);
	assert.equal(synced.count, 2);
	assert.equal(synced.cron, tracked.cron);
	assert.equal(synced.timezone, tracked.timezone);
	assert.deepEqual(synced.excludeTickets, ["1"]);
	assert.deepEqual(synced.requiredChecks, ["ci", "smoke"]);
	assert.equal(synced.scheduleId, "s1");
	assert.equal(synced.paused, true);
	assert.equal(synced.pauseReason, "Paused in Paseo");
	f.schedule.paused = false;
	const first = intakeCommand("tick", f.cwd, { models: f.models }, f.options);
	assert.deepEqual(first.tickets, ["2", "3"]);
	tracked.count = 3;
	tracked.excludeTickets = [1, 4];
	delete tracked.requiredChecks;
	writeFileSync(configPath, JSON.stringify(tracked));
	const next = intakeCommand(
		"tick",
		f.cwd,
		{ models: f.models },
		{ ...f.options, now: f.options.now + 3600000 },
	);
	assert.equal(next.status, "admitted");
	assert.deepEqual(next.tickets, ["5"]);
	assert.equal(intakeCommand("status", f.cwd).count, 3);
	assert.equal(intakeCommand("status", f.cwd).requiredChecks, undefined);
	assert.equal(
		intakeCommand("status", f.cwd).repositoryConfig,
		"toolkit-intake.json",
	);
	assert.throws(
		() => intakeCommand("configure", f.cwd, f.input),
		/toolkit-intake.json is authoritative/,
	);
});
test("tracked config can initialize a new repository without a request file", (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "intake-config-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	writeFileSync(
		join(cwd, "toolkit-intake.json"),
		JSON.stringify({
			version: 1,
			repository: "example/another-repo",
			baseBranch: "develop",
			codexModel: "gpt-6-sol",
			count: 4,
		}),
	);
	const policy = intakeCommand("configure", cwd);
	assert.equal(policy.repository, "example/another-repo");
	assert.equal(policy.baseBranch, "develop");
	assert.equal(policy.count, 4);
	assert.equal(policy.scheduleId, null);
	assert.equal(policy.paused, false);
});
test("request-based exclusions require canonical issue numbers", (t) => {
	const f = fixture(t);
	assert.throws(
		() =>
			intakeCommand("configure", f.cwd, {
				...f.input,
				excludeTickets: "1",
			}),
		/excludeTickets must contain issue numbers/,
	);
	assert.throws(
		() =>
			intakeCommand(
				"tick",
				f.cwd,
				{ models: f.models, excludeTickets: ["01"] },
				f.options,
			),
		/excludeTickets must contain issue numbers/,
	);
});
test("invalid tracked config and unsafe limit decreases fail without changing policy", (t) => {
	const f = fixture(t);
	const configPath = join(f.cwd, "toolkit-intake.json");
	const tracked = { version: 1, ...f.input, count: 2 };
	writeFileSync(configPath, JSON.stringify({ ...tracked, unexpected: true }));
	assert.throws(
		() => intakeCommand("sync-config", f.cwd),
		/unknown field unexpected/,
	);
	f.schedule.paused = true;
	assert.equal(
		intakeCommand("pause", f.cwd, { schedule: f.schedule }).paused,
		true,
	);
	f.schedule.paused = false;
	assert.equal(
		intakeCommand("resume", f.cwd, { schedule: f.schedule }).paused,
		false,
	);
	assert.equal(
		JSON.parse(
			readFileSync(
				intakePath(join(f.cwd, ".toolkit/orchestration/intake-anchor.json")),
				"utf8",
			),
		).count,
		3,
	);
	writeFileSync(configPath, JSON.stringify(tracked));
	const batch = intakeCommand("tick", f.cwd, { models: f.models }, f.options);
	update(batch.batchFile, (state) => {
		for (const ticket of Object.values(state.tickets))
			ticket.status = "implementing";
	});
	tracked.count = 1;
	writeFileSync(configPath, JSON.stringify(tracked));
	assert.throws(
		() => intakeCommand("sync-config", f.cwd),
		/below current active work/,
	);
	assert.equal(
		JSON.parse(readFileSync(intakePath(batch.batchFile), "utf8")).count,
		2,
	);
});
test("requiredChecks validates names, duplicates, and array type", (t) => {
	const f = fixture(t);
	const configPath = join(f.cwd, "toolkit-intake.json");
	for (const invalid of ["ci", [""], [" ci"], ["ci", "ci"], [7]]) {
		writeFileSync(
			configPath,
			JSON.stringify({ version: 1, ...f.input, requiredChecks: invalid }),
		);
		assert.throws(() => intakeCommand("sync-config", f.cwd), /requiredChecks/);
	}
	rmSync(configPath);
	assert.equal(intakeCommand("status", f.cwd).requiredChecks, undefined);
});
test("capacity-full tick can retry after a slot frees within the hour", (t) => {
	const f = fixture(t);
	intakeCommand("configure", f.cwd, { ...f.input, count: 1 });
	const first = intakeCommand("tick", f.cwd, { models: f.models }, f.options);
	const nextHour = { ...f.options, now: f.options.now + 3600000 };
	const full = intakeCommand("tick", f.cwd, { models: f.models }, nextHour);
	assert.equal(full.status, "capacity-full");
	assert.equal(full.capacity.queued, 1);
	update(first.batchFile, (state) => {
		state.tickets[1].status = "awaiting_merge";
	});
	const admitted = intakeCommand("tick", f.cwd, { models: f.models }, nextHour);
	assert.equal(admitted.status, "admitted");
	assert.equal(admitted.retried, true);
	assert.deepEqual(admitted.tickets, ["2"]);
	assert.equal(admitted.capacity.admissionSlots, 0);
});
test("per-batch reserves cannot exceed the repository limit and can continue after a slot is freed", (t) => {
	const f = fixture(t);
	intakeCommand("configure", f.cwd, { ...f.input, count: 1 });
	const dir = join(f.cwd, ".toolkit", "orchestration"),
		paths = [join(dir, "a.json"), join(dir, "b.json")];
	const tokens = paths.map((path, i) => {
		execute("init", path, {
			...f.input,
			cwd: f.cwd,
			batchId: `batch-${i}`,
			tickets: [i + 1],
		});
		return execute("acquire", path).token;
	});
	execute(
		"reserve",
		paths[0],
		{ token: tokens[0], number: 1, models: f.models },
		f.options,
	);
	assert.throws(
		() =>
			execute(
				"reserve",
				paths[1],
				{ token: tokens[1], number: 2, models: f.models },
				f.options,
			),
		/execution limit/,
	);
	assert.equal(execute("status", paths[1]).tickets[2].status, "queued");
	execute(
		"attach",
		paths[0],
		{ token: tokens[0], number: 1, workspaceId: "w", agentId: "a" },
		f.options,
	);
	execute(
		"block",
		paths[0],
		{ token: tokens[0], number: 1, reason: "needs human", workerStopped: true },
		f.options,
	);
	execute(
		"reserve",
		paths[1],
		{ token: tokens[1], number: 2, models: f.models },
		f.options,
	);
	assert.throws(
		() =>
			execute(
				"resume",
				paths[0],
				{ token: tokens[0], number: 1, evidence: "human resolved" },
				f.options,
			),
		/execution limit/,
	);
});
test("uncertain launches and permission waits consume slots, and lowering a limit cannot hide active work", (t) => {
	const f = fixture(t),
		first = intakeCommand("tick", f.cwd, { models: f.models }, f.options);
	update(first.batchFile, (s) => {
		s.tickets[1] = {
			...s.tickets[1],
			status: "blocked",
			launchUncertain: true,
		};
		s.tickets[2] = { ...s.tickets[2], status: "blocked", workerActive: true };
		s.tickets[3].status = "awaiting_merge";
	});
	assert.equal(capacity(first.batchFile, f.input.repository).active, 2);
	assert.throws(
		() => intakeCommand("configure", f.cwd, { ...f.input, count: 1 }),
		/below current active/,
	);
});
test("empty hours leave intake enabled; pause and resume affect admission, and schedule IDs cannot drift", (t) => {
	const f = fixture(t);
	f.api.listReady = () => [];
	assert.equal(
		intakeCommand("tick", f.cwd, { models: f.models }, f.options).initialized,
		false,
	);
	assert.equal(intakeCommand("status", f.cwd).paused, false);
	intakeCommand("schedule", f.cwd, { scheduleId: "s1" });
	assert.throws(
		() => intakeCommand("schedule", f.cwd, { scheduleId: "s2" }),
		/already/,
	);
	assert.throws(
		() => intakeCommand("pause", f.cwd, { schedule: f.schedule }),
		/pause the Paseo schedule first/,
	);
	f.schedule.paused = true;
	assert.equal(
		intakeCommand("tick", f.cwd, { models: f.models }, f.options).paused,
		true,
	);
	f.schedule.paused = false;
	intakeCommand("tick", f.cwd, { models: f.models }, f.options);
	assert.equal(intakeCommand("status", f.cwd).paused, false);
});
test("live Paseo resume clears a stale policy pause and admits without a helper resume", (t) => {
	const f = fixture(t);
	const policyFile = intakePath(
		join(f.cwd, ".toolkit/orchestration/intake-anchor.json"),
	);
	const policy = intakeCommand("status", f.cwd);
	policy.paused = true;
	policy.pausedAt = "2026-09-20T05:06:00.000Z";
	policy.pauseReason = "old controller pause";
	atomicWrite(policyFile, policy);
	const admitted = intakeCommand(
		"tick",
		f.cwd,
		{ models: f.models, schedule: f.schedule },
		{
			github: f.options.github,
			now: f.options.now,
		},
	);
	assert.equal(admitted.status, "admitted");
	assert.deepEqual(admitted.tickets, ["1", "2", "3"]);
	assert.equal(intakeCommand("status", f.cwd).paused, false);
	assert.equal(intakeCommand("status", f.cwd).pausedAt, undefined);
	assert.equal(intakeCommand("status", f.cwd).pauseReason, undefined);
	assert.equal(
		intakeCommand("tick", f.cwd, { models: f.models }, f.options).status,
		"replayed",
	);
});
test("live Paseo pause overrides a stale active policy; UI resume admits the same hour", (t) => {
	const f = fixture(t);
	f.schedule.paused = true;
	const paused = intakeCommand("tick", f.cwd, { models: f.models }, f.options);
	assert.equal(paused.status, "paused");
	assert.equal(intakeCommand("status", f.cwd).paused, true);
	assert.equal(intakeCommand("status", f.cwd).lastTick, null);
	f.schedule.paused = false;
	const admitted = intakeCommand(
		"tick",
		f.cwd,
		{ models: f.models },
		f.options,
	);
	assert.equal(admitted.status, "admitted");
	assert.deepEqual(admitted.tickets, ["1", "2", "3"]);
	assert.equal(intakeCommand("status", f.cwd).paused, false);
});
test("missing, mismatched, or unreadable schedule state fails before admission", (t) => {
	const f = fixture(t);
	const request = { models: f.models };
	const options = { github: f.options.github, now: f.options.now };
	assert.throws(
		() => intakeCommand("tick", f.cwd, request, options),
		/schedule state is required/,
	);
	for (const schedule of [
		{ ...f.schedule, id: "other" },
		{ ...f.schedule, name: "ticket-intake:other/project" },
		{ ...f.schedule, paused: undefined },
	]) {
		assert.throws(
			() => intakeCommand("tick", f.cwd, { ...request, schedule }, options),
			/schedule ID or name does not match|paused state is unavailable/,
		);
	}
	assert.equal(intakeCommand("status", f.cwd).lastTick, null);
	const policyFile = intakePath(
		join(f.cwd, ".toolkit/orchestration/intake-anchor.json"),
	);
	const policy = intakeCommand("status", f.cwd);
	policy.scheduleId = null;
	atomicWrite(policyFile, policy);
	assert.throws(
		() =>
			intakeCommand(
				"tick",
				f.cwd,
				{ ...request, schedule: f.schedule },
				options,
			),
		/schedule ID is missing/,
	);
	assert.equal(intakeCommand("status", f.cwd).lastTick, null);
});
test("recover batch created before a crash without duplicating the hourly selection", (t) => {
	const f = fixture(t),
		first = intakeCommand("tick", f.cwd, { models: f.models }, f.options);
	const policyFile = intakePath(first.batchFile),
		policy = intakeCommand("status", f.cwd);
	policy.lastTick = null;
	atomicWrite(policyFile, policy);
	const recovered = intakeCommand(
		"tick",
		f.cwd,
		{ models: f.models },
		f.options,
	);
	assert.equal(recovered.recovered, true);
	assert.equal(recovered.status, "recovered");
	assert.equal(recovered.batchFile, first.batchFile);
	assert.deepEqual(recovered.helper, first.helper);
	assert.equal(recovered.capacity.admissionSlots, 0);
	const replay = intakeCommand("tick", f.cwd, { models: f.models }, f.options);
	assert.equal(replay.status, "replayed");
	assert.deepEqual(replay.tickets, first.tickets);
});
test("crash after retry admission recovers the existing batch despite stale empty policy", (t) => {
	const f = fixture(t);
	f.api.listReady = () => [];
	const empty = intakeCommand("tick", f.cwd, { models: f.models }, f.options);
	assert.equal(empty.status, "empty");
	f.api.listReady = () => [{ number: 1, created_at: "2026-01-01" }];
	const first = intakeCommand("tick", f.cwd, { models: f.models }, f.options);
	const policyFile = intakePath(first.batchFile);
	const policy = intakeCommand("status", f.cwd);
	delete policy.activeHelper;
	policy.lastTick = empty;
	delete policy.lastTick.activeHelper;
	atomicWrite(policyFile, policy);
	let selections = 0;
	f.api.listReady = () => {
		selections++;
		return [{ number: 2, created_at: "2026-01-02" }];
	};
	const recovered = intakeCommand(
		"tick",
		f.cwd,
		{ models: f.models },
		f.options,
	);
	assert.equal(recovered.status, "recovered");
	assert.deepEqual(recovered.tickets, ["1"]);
	assert.deepEqual(recovered.helper, first.helper);
	assert.equal(selections, 0);
	assert.equal(
		intakeCommand("tick", f.cwd, { models: f.models }, f.options).status,
		"replayed",
	);
	assert.equal(selections, 0);
});
test("an admitted policy fails closed when its batch disappears or changes identity", (t) => {
	const f = fixture(t);
	const admitted = intakeCommand(
		"tick",
		f.cwd,
		{ models: f.models },
		f.options,
	);
	update(admitted.batchFile, (state) => {
		state.ticketOrder = ["9"];
	});
	assert.throws(
		() => intakeCommand("tick", f.cwd, { models: f.models }, f.options),
		/differs from the recorded admission/,
	);
	rmSync(admitted.batchFile);
	assert.throws(
		() => intakeCommand("tick", f.cwd, { models: f.models }, f.options),
		/admitted intake batch is missing/,
	);
});
test("shared lock blocks both intake and reserve; malformed policy fails closed", (t) => {
	const f = fixture(t),
		dir = join(f.cwd, ".toolkit", "orchestration");
	mkdirSync(join(dir, ".selection.lock"));
	assert.throws(
		() => intakeCommand("tick", f.cwd, { models: f.models }, f.options),
		/in progress/,
	);
	rmSync(join(dir, ".selection.lock"), { recursive: true });
	writeFileSync(intakePath(join(dir, "a.json")), "{}");
	assert.throws(
		() => intakeCommand("tick", f.cwd, { models: f.models }, f.options),
		/invalid intake/,
	);
});
