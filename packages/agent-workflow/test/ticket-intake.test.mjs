import assert from "node:assert/strict";
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
		snapshot: (state) =>
			Object.fromEntries(
				Object.keys(state.tickets).map((n) => [n, api.issue(n)]),
			),
	};
	const options = {
		github: () => api,
		now: Date.parse("2026-09-21T09:00:00Z"),
	};
	intakeCommand("configure", cwd, input);
	return { cwd, input, models, api, options };
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
	assert.equal(third.reason, "capacity full");
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
	assert.equal(again.batchFile, a.batchFile);
	assert.deepEqual(again.activeHelper, a.helper);
	const next = intakeCommand(
		"tick",
		f.cwd,
		{ models: f.models },
		{ ...f.options, now: f.options.now + 3600000 },
	);
	assert.deepEqual(next.tickets, ["4", "5", "6"]);
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
	intakeCommand("pause", f.cwd);
	assert.equal(
		intakeCommand("tick", f.cwd, { models: f.models }, f.options).paused,
		true,
	);
	intakeCommand("resume", f.cwd);
	assert.equal(intakeCommand("status", f.cwd).paused, false);
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
	assert.equal(recovered.batchFile, first.batchFile);
	assert.deepEqual(recovered.helper, first.helper);
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
