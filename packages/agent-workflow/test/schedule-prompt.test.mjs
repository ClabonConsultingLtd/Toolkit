import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readRepositoryIntakeConfig } from "../src/intake-config.mjs";
import {
	comparePrompt,
	driftSummary,
	livePrompt,
	schedulePaths,
	schedulePrompt,
	scheduleSummary,
} from "../src/schedule-prompt.mjs";
import { intakeCommand } from "../src/ticket-intake.mjs";

const cli = join(import.meta.dirname, "..", "src", "intake-cli.mjs");
const base = {
	version: 1,
	repository: "example/project",
	baseBranch: "main",
	codexModel: "codex-model",
	count: 2,
};

function checkout(t, config = base) {
	const cwd = mkdtempSync(join(tmpdir(), "schedule-prompt-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	if (config)
		writeFileSync(join(cwd, "toolkit-intake.json"), JSON.stringify(config));
	return cwd;
}

function run(args, input) {
	return spawnSync(process.execPath, [cli, ...args], {
		encoding: "utf8",
		input,
	});
}

test("canonical prompt names absolute paths and required instructions deterministically", (t) => {
	const cwd = checkout(t);
	const prompt = schedulePrompt(cwd);
	const paths = schedulePaths(cwd);
	assert.equal(prompt, schedulePrompt(cwd));
	for (const path of Object.values(paths)) {
		assert.ok(path.startsWith("/"), path);
		assert.ok(prompt.includes(path), path);
	}
	assert.match(paths.skill, /orchestrate-tickets\/SKILL\.md$/);
	assert.match(prompt, /ticket-intake:example\/project/);
	assert.match(prompt, /sync-config/);
	assert.match(prompt, /schedule-summary/);
	assert.match(prompt, /not run history/);
	assert.match(prompt, /do not rewrite this prompt yourself/);
	assert.match(prompt, /codex sandbox true/);
	assert.match(prompt, /does not authorize `full-access` for Codex workers/);
	assert.match(prompt, /merge-ready/);
	assert.doesNotMatch(prompt, /Repository additions/);
	assert.doesNotMatch(prompt, /\d{4}-\d{2}-\d{2}/);
	writeFileSync(
		join(cwd, "toolkit-intake.json"),
		JSON.stringify({ ...base, count: 5, cron: "0 * * * *" }),
	);
	assert.equal(
		schedulePrompt(cwd),
		prompt,
		"runtime settings stay out of the prompt",
	);
});

test("config authorizes worker full-access and appends repository instructions", (t) => {
	const cwd = checkout(t, {
		...base,
		codexWorkerFullAccess: true,
		schedulePromptAppend: [
			"Approve and merge verified PRs.",
			"Repair metadata.",
		],
	});
	const prompt = schedulePrompt(cwd);
	assert.match(prompt, /authorizes `full-access` for Codex workers only when/);
	assert.ok(
		prompt.endsWith(
			"Repository additions:\nApprove and merge verified PRs.\nRepair metadata.\n",
		),
	);
	const single = checkout(t, { ...base, schedulePromptAppend: "One line." });
	assert.ok(
		schedulePrompt(single).endsWith("Repository additions:\nOne line.\n"),
	);
});

test("selfAuthoredMerge adds the comment-review rule only when set", (t) => {
	const cwd = checkout(t, base);
	const plain = schedulePrompt(cwd);
	assert.doesNotMatch(plain, /PR comment naming the reviewed head SHA/);
	writeFileSync(
		join(cwd, "toolkit-intake.json"),
		JSON.stringify({ ...base, selfAuthoredMerge: "comment-review" }),
	);
	const opted = schedulePrompt(cwd);
	assert.match(
		opted,
		/refuses the approval only because the controller's account opened the PR, post the independent review as a PR comment naming the reviewed head SHA/,
	);
	assert.match(opted, /never use `--admin`/);
	assert.equal(
		opted.replace(
			/ When GitHub refuses the approval[^\n]*? stays awaiting a human\./,
			"",
		),
		plain,
		"only step 9 changes",
	);
});

test("new config fields are validated", (t) => {
	for (const [field, value] of [
		["schedulePromptAppend", ""],
		["schedulePromptAppend", []],
		["schedulePromptAppend", ["ok", " "]],
		["schedulePromptAppend", 3],
		["codexWorkerFullAccess", "yes"],
		["selfAuthoredMerge", true],
		["selfAuthoredMerge", "approve"],
	]) {
		const cwd = checkout(t, { ...base, [field]: value });
		assert.throws(() => readRepositoryIntakeConfig(cwd), new RegExp(field));
	}
});

test("the example config validates", (t) => {
	const cwd = checkout(t, null);
	copyFileSync(
		join(import.meta.dirname, "..", "examples", "toolkit-intake.json"),
		join(cwd, "toolkit-intake.json"),
	);
	assert.equal(readRepositoryIntakeConfig(cwd).codexWorkerFullAccess, false);
	assert.match(schedulePrompt(cwd), /does not authorize `full-access`/);
});

test("prompt falls back to saved policy and requires some configuration", (t) => {
	const empty = checkout(t, null);
	assert.throws(() => schedulePrompt(empty), /configured intake policy/);
	const { version, ...request } = base;
	intakeCommand("configure", empty, request);
	assert.match(schedulePrompt(empty), /ticket-intake:example\/project/);
});

test("comparison ignores line endings and trailing whitespace but reports drift", () => {
	const expected = "a\nb\nc\n";
	assert.equal(comparePrompt(expected, "a  \r\nb\r\nc").matches, true);
	const drift = comparePrompt(expected, "a\nkeep auto-review\nc\n");
	assert.deepEqual(drift, {
		matches: false,
		missingCount: 1,
		unexpectedCount: 1,
		missing: ["b"],
		unexpected: ["keep auto-review"],
	});
	assert.equal(
		driftSummary(drift),
		"schedule prompt drift:\n  1 expected line(s) missing\n  - b\n  1 unexpected line(s)\n  + keep auto-review",
	);
	assert.equal(comparePrompt(expected, "c\nb\na").reordered, true);
	const many = comparePrompt("x", "1\n2\n3\n4\n5\n6\n7");
	assert.equal(many.unexpectedCount, 7);
	assert.equal(many.unexpected.length, 5);
	assert.match(driftSummary(many), /\+ \.\.\.$/);
});

test("live prompt input accepts raw text or Paseo schedule JSON", () => {
	assert.equal(livePrompt("plain prompt"), "plain prompt");
	assert.equal(livePrompt(JSON.stringify({ prompt: "p" })), "p");
	assert.equal(livePrompt(JSON.stringify({ schedule: { prompt: "q" } })), "q");
	assert.throws(() => livePrompt(JSON.stringify({ id: "x" })), /no prompt/);
});

test("schedule summary projects needed fields and drops run history", (t) => {
	const cwd = checkout(t);
	const expected = schedulePrompt(cwd);
	const schedule = {
		id: "s1",
		name: "ticket-intake:example/project",
		prompt: expected,
		cadence: { type: "cron", expression: "*/30 8-19 * * *", timezone: "UTC" },
		target: {
			type: "new-agent",
			config: {
				provider: "codex",
				model: "gpt-6-sol",
				thinkingOptionId: "medium",
				modeId: "full-access",
				cwd,
			},
		},
		status: "active",
		nextRunAt: "2026-01-01T09:30:00.000Z",
		runs: Array.from({ length: 80 }, (_, i) => ({ id: i, output: "long" })),
	};
	const summary = scheduleSummary(schedule, expected);
	assert.deepEqual(summary, {
		id: "s1",
		name: "ticket-intake:example/project",
		status: "active",
		paused: false,
		cron: "*/30 8-19 * * *",
		timezone: "UTC",
		provider: "codex",
		model: "gpt-6-sol",
		thinkingOptionId: "medium",
		mode: "full-access",
		cwd,
		nextRunAt: "2026-01-01T09:30:00.000Z",
		promptMatches: true,
	});
	const paused = scheduleSummary(
		{ schedule: { ...schedule, status: "paused", prompt: "old prompt" } },
		expected,
	);
	assert.equal(paused.paused, true);
	assert.equal(paused.promptMatches, false);
	assert.match(paused.promptDrift, /\+ old prompt/);
	assert.equal(scheduleSummary({ id: "s1" }).paused, null);
	assert.equal(scheduleSummary({ id: "s1" }, expected).promptMatches, null);

	const result = run(["schedule-summary", cwd, "-"], JSON.stringify(schedule));
	assert.equal(result.status, 0, result.stderr);
	const output = JSON.parse(result.stdout);
	assert.equal(output.promptMatches, true);
	assert.equal("runs" in output, false);
	assert.equal("prompt" in output, false);
});

test("CLI prints the prompt and --check exits non-zero on drift", (t) => {
	const cwd = checkout(t);
	const printed = run(["schedule-prompt", cwd]);
	assert.equal(printed.status, 0, printed.stderr);
	assert.equal(printed.stdout, schedulePrompt(cwd));

	const same = run(["schedule-prompt", cwd, "--check", "-"], printed.stdout);
	assert.equal(same.status, 0, same.stderr);
	assert.match(same.stdout, /schedule prompt matches/);

	const file = join(cwd, "live.json");
	writeFileSync(
		file,
		JSON.stringify({
			prompt: printed.stdout.replace("do not rewrite", "rewrite"),
		}),
	);
	const drift = run(["schedule-prompt", cwd, "--check", file]);
	assert.equal(drift.status, 1);
	assert.match(drift.stderr, /schedule prompt drift/);
	assert.match(drift.stderr, /1 expected line\(s\) missing/);
	assert.match(
		drift.stderr,
		/regenerate with: node \/.*intake\.mjs schedule-prompt/,
	);

	const bad = run(["schedule-prompt", cwd, "--bogus"]);
	assert.equal(bad.status, 1);
	assert.match(bad.stderr, /usage: intake schedule-prompt/);
});
