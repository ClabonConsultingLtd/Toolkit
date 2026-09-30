import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { parsePaseoArgs } from "../paseo-setup.mjs";
import {
	intakeConfig,
	MERGE_AUTHORIZATION,
	parseGitHubRemote,
	runPaseoSetup,
	scheduleHandoff,
} from "../src/paseo.mjs";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

// Fake paseo and gh commands that keep their state in one JSON file, so the
// test needs neither a Paseo host nor GitHub.
const FAKE_PASEO = `#!/usr/bin/env node
const fs = require("node:fs");
const file = process.env.FAKE_STATE;
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
state.calls.push(["paseo", ...args]);
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const flag = (name) => args[args.indexOf(name) + 1];
const out = (value) => process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
const [a, b, c] = args;
if (a === "--version") out("0.10.0");
else if (a === "daemon" && c === "get") out({ path: "daemon.mcp.injectIntoAgents", value: state.inject ?? null });
else if (a === "daemon" && c === "set") state.inject = args[4] === "true";
else if (a === "provider") out([{ id: "claude-test-1", thinkingOptionIds: ["low", "medium", "high"], defaultThinkingOptionId: "high" }]);
else if (a === "schedule" && b === "ls") out(state.schedules.map(({ id, name, status }) => ({ id, name, status })));
else if (a === "schedule" && b === "create") {
	const schedule = {
		id: "sch" + (state.schedules.length + 1),
		name: flag("--name"),
		prompt: args.at(-1),
		cron: flag("--cron"),
		timezone: flag("--timezone"),
		provider: flag("--provider"),
		thinking: flag("--thinking"),
		mode: flag("--mode"),
		cwd: flag("--cwd"),
		status: "active",
	};
	state.schedules.push(schedule);
	out(schedule);
} else if (a === "schedule" && b === "pause") state.schedules.find((s) => s.id === c).status = "paused";
else if (a === "schedule" && b === "inspect") out(state.schedules.find((s) => s.id === c));
else if (a === "schedule" && b === "update") state.schedules.find((s) => s.id === c).prompt = flag("--prompt");
else { save(); process.exit(2); }
save();
`;

const FAKE_GH = `#!/usr/bin/env node
const fs = require("node:fs");
const file = process.env.FAKE_STATE;
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
state.calls.push(["gh", ...args]);
fs.writeFileSync(file, JSON.stringify(state));
if (args[0] === "repo") process.stdout.write("main");
else if (args[0] === "api") process.stdout.write(JSON.stringify(state.checks));
`;

function fakes(initial = {}) {
	const bin = mkdtempSync(join(tmpdir(), "paseo-fakes-"));
	for (const [name, body] of [
		["paseo", FAKE_PASEO],
		["gh", FAKE_GH],
		["claude", "#!/bin/sh\necho 1.0.0\n"],
	]) {
		writeFileSync(join(bin, name), body);
		chmodSync(join(bin, name), 0o755);
	}
	const stateFile = join(bin, "state.json");
	writeFileSync(
		stateFile,
		JSON.stringify({
			calls: [],
			schedules: [],
			checks: ["verify"],
			...initial,
		}),
	);
	process.env.PATH = `${bin}:${process.env.PATH}`;
	process.env.FAKE_STATE = stateFile;
	return () => JSON.parse(readFileSync(stateFile, "utf8"));
}

function checkout() {
	const root = mkdtempSync(join(tmpdir(), "paseo-checkout-"));
	cpSync(
		join(repoRoot, "packages", "agent-workflow"),
		join(root, "tools", "agent-workflow"),
		{
			recursive: true,
			filter: (source) => !["node_modules", "test"].includes(basename(source)),
		},
	);
	writeFileSync(join(root, "package-lock.json"), "{}\n");
	const git = (...args) => execFileSync("git", args, { cwd: root });
	git("init", "-q", "-b", "main");
	git("remote", "add", "origin", "https://github.com/owner/repo.git");
	return realpathSync(root);
}

function quietIo() {
	const warnings = [];
	return {
		warnings,
		log() {},
		warn: (message) => warnings.push(message),
		ask: async (_question, _choices, fallback) => fallback,
		confirm: async (_question, fallback) => fallback,
	};
}

const readJson = (root, file) =>
	JSON.parse(readFileSync(join(root, file), "utf8"));

test("configures a checkout and creates a paused intake schedule", async () => {
	const state = fakes();
	const root = checkout();
	const result = await runPaseoSetup(
		{ target: root, yes: true, triage: true, report: false },
		quietIo(),
	);

	const intake = readJson(root, "toolkit-intake.json");
	assert.equal(intake.repository, "owner/repo");
	assert.equal(intake.baseBranch, "main");
	assert.equal(intake.controllerProvider, "claude/claude-test-1");
	assert.equal(intake.controllerThinkingOptionId, "medium");
	assert.equal(intake.count, 2);
	assert.deepEqual(intake.requiredChecks, ["verify"]);
	assert.equal(intake.schedulePromptAppend, undefined, "no merging by default");

	assert.deepEqual(readJson(root, "paseo.json"), {
		worktree: { setup: "npm ci" },
	});
	const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
	assert.match(gitignore, /^\.claude\/skills\/orchestrate-tickets$/m);
	for (const name of [
		"orchestrate-tickets",
		"triage-tickets",
		"report-tickets",
	]) {
		const link = join(root, ".claude", "skills", name);
		assert.ok(lstatSync(link).isSymbolicLink());
		assert.ok(existsSync(join(link, "scripts")), `${name} resolves`);
	}
	assert.ok(
		existsSync(join(root, ".toolkit/orchestration/.intake/policy.json")),
	);

	const after = state();
	assert.equal(after.inject, true, "Paseo tools enabled");
	assert.deepEqual(
		after.schedules.map(({ name, status }) => [name, status]),
		[
			["ticket-intake:owner/repo", "paused"],
			["triage:owner/repo", "paused"],
		],
	);
	const [intakeSchedule, triageSchedule] = after.schedules;
	assert.equal(intakeSchedule.provider, "claude/claude-test-1");
	assert.equal(intakeSchedule.thinking, "medium");
	assert.equal(intakeSchedule.mode, "bypassPermissions");
	assert.equal(intakeSchedule.cron, "*/30 8-19 * * *");
	assert.equal(intakeSchedule.cwd, root);
	assert.match(
		intakeSchedule.prompt,
		/^Run the ticket intake controller for owner\/repo/,
	);
	assert.match(triageSchedule.prompt, /triage-tickets\/SKILL\.md/);
	assert.equal(
		readJson(root, ".toolkit/orchestration/.intake/policy.json").scheduleId,
		"sch1",
	);
	assert.ok(
		after.calls.some(
			(call) =>
				call[0] === "gh" &&
				call[1] === "label" &&
				call[3] === "ready-for-agent",
		),
	);
	assert.deepEqual(
		result.schedules.map(({ paused }) => paused),
		[true, true],
	);
});

test("a re-run keeps the schedule and refreshes a stale prompt", async () => {
	const state = fakes();
	const root = checkout();
	const options = { target: root, yes: true, triage: false, report: false };
	await runPaseoSetup(options, quietIo());

	// Simulate a Toolkit update that changed the generated prompt.
	const stale = state();
	stale.schedules[0].prompt = "old prompt";
	writeFileSync(process.env.FAKE_STATE, JSON.stringify(stale));

	const again = await runPaseoSetup(options, quietIo());
	const after = state();
	assert.equal(after.schedules.length, 1, "no second schedule");
	assert.match(after.schedules[0].prompt, /^Run the ticket intake controller/);
	assert.deepEqual(again.kept, ["toolkit-intake.json", "paseo.json"]);
	assert.deepEqual(
		again.schedules.map(({ kept }) => kept),
		[true],
	);
});

test("merge authorization and a shared account set the merge fields", async () => {
	fakes();
	const root = checkout();
	await runPaseoSetup(
		{
			target: root,
			yes: true,
			allowMerge: true,
			requiredChecks: ["verify", "lint"],
			count: "3",
			schedules: false,
		},
		quietIo(),
	);
	const intake = readJson(root, "toolkit-intake.json");
	assert.equal(intake.schedulePromptAppend, MERGE_AUTHORIZATION);
	assert.equal(intake.selfAuthoredMerge, "comment-review");
	assert.deepEqual(intake.requiredChecks, ["verify", "lint"]);
	assert.equal(intake.count, 3);
});

test("stops before changing anything when agent-workflow isn't vendored", async () => {
	fakes();
	const root = mkdtempSync(join(tmpdir(), "paseo-empty-"));
	execFileSync("git", ["init", "-q"], { cwd: root });
	await assert.rejects(
		runPaseoSetup({ target: root, yes: true }, quietIo()),
		/Run setup\.mjs first/,
	);
	assert.equal(existsSync(join(root, "toolkit-intake.json")), false);
});

test("rejects a model Paseo doesn't list", async () => {
	fakes();
	await assert.rejects(
		runPaseoSetup(
			{ target: checkout(), yes: true, model: "claude-nope" },
			quietIo(),
		),
		/Paseo has no Claude model claude-nope/,
	);
});

test("helpers", () => {
	assert.equal(parseGitHubRemote("https://github.com/o/r.git"), "o/r");
	assert.equal(parseGitHubRemote("git@github.com:o/r.git"), "o/r");
	assert.equal(parseGitHubRemote("https://gitlab.com/o/r.git"), undefined);
	assert.equal(
		intakeConfig({
			repository: "o/r",
			baseBranch: "main",
			model: "m",
			thinking: "low",
			count: 1,
		}).requiredChecks,
		undefined,
	);
	const handoff = scheduleHandoff(
		[
			{
				name: "ticket-intake:o/r",
				cron: "*/30 8-19 * * *",
				timezone: "UTC",
				provider: "claude/m",
				thinking: "medium",
				mode: "bypassPermissions",
				cwd: "C:\\src\\app",
				promptFile: "C:\\src\\app\\.toolkit\\paseo-setup\\p.md",
				intake: true,
			},
		],
		{
			intakeHelper: "C:\\src\\app\\tools\\intake.mjs",
			checkout: "C:\\src\\app",
		},
	);
	assert.match(handoff, /C:\/src\/app\/\.toolkit\/paseo-setup\/p\.md/);
	assert.match(
		handoff,
		/node "C:\/src\/app\/tools\/intake\.mjs" schedule "C:\/src\/app" -/,
	);
	assert.doesNotMatch(handoff, /\\/);
	assert.deepEqual(
		parsePaseoArgs(["--required-checks", "a, b", "--allow-merge"]),
		{
			requiredChecks: ["a", "b"],
			allowMerge: true,
		},
	);
	assert.deepEqual(
		parsePaseoArgs(["--required-checks", ""]).requiredChecks,
		[],
	);
	assert.throws(() => parsePaseoArgs(["--repository", "nope"]), /owner\/name/);
});
