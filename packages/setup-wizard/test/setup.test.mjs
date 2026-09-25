import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { parseArgs } from "../setup.mjs";
import { runSetup } from "../src/wizard.mjs";

const TAG = "v9.9.9";
const repoRoot = join(import.meta.dirname, "..", "..", "..");

function git(cwd, args) {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

// A tagged Toolkit-shaped repository built from this working tree, so the
// test exercises the current packages without network access or real tags.
function fixtureToolkit() {
	const root = mkdtempSync(join(tmpdir(), "setup-toolkit-"));
	for (const name of [
		"toolkit-sync",
		"agent-workflow",
		"claude-token-optimisation",
		"setup-wizard",
	])
		cpSync(join(repoRoot, "packages", name), join(root, "packages", name), {
			recursive: true,
			filter: (source) => basename(source) !== "node_modules",
		});
	git(root, ["init", "-q", "-b", "main"]);
	git(root, ["add", "-A"]);
	git(root, [
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.com",
		"commit",
		"-q",
		"-m",
		"fixture",
	]);
	git(root, ["tag", TAG]);
	return root;
}

function consumer() {
	const root = mkdtempSync(join(tmpdir(), "setup-consumer-"));
	git(root, ["init", "-q", "-b", "main"]);
	writeFileSync(
		join(root, "package.json"),
		'{\n  "name": "app",\n  "scripts": { "test": "node --test" }\n}\n',
	);
	writeFileSync(join(root, "AGENTS.md"), "# App\n");
	return root;
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

test("sets up a repository for both trackers and is idempotent", async () => {
	const toolkit = fixtureToolkit();
	const target = consumer();
	const options = {
		target,
		toolkitRoot: toolkit,
		repo: toolkit,
		tag: TAG,
		tracker: "both",
		yes: true,
		skills: false,
		labels: false,
	};

	const result = await runSetup(options, quietIo());
	assert.equal(result.tracker, "both");
	assert.equal(
		git(target, ["branch", "--show-current"]).trim(),
		"chore/toolkit-setup",
	);

	const pins = readJson(target, "toolkit-pins.json");
	assert.deepEqual(Object.keys(pins).sort(), [
		"agent-workflow",
		"claude-token-optimisation",
	]);
	assert.equal(pins["agent-workflow"].dest, "tools/agent-workflow");
	assert.ok(existsSync(join(target, "tools/toolkit-sync/cli.mjs")));
	assert.equal(
		readFileSync(join(target, "tools/toolkit-sync/cli.mjs"), "utf8"),
		readFileSync(join(repoRoot, "packages/toolkit-sync/src/cli.mjs"), "utf8"),
	);
	assert.ok(
		existsSync(join(target, ".claude/skills/toolkit-upgrade/SKILL.md")),
	);
	assert.ok(existsSync(join(target, ".claude/hooks/guard-large-read.mjs")));
	assert.equal(
		existsSync(
			join(target, ".claude/settings.toolkit-token-optimisation.json"),
		),
		false,
	);

	const settings = readJson(target, ".claude/settings.json");
	assert.equal(settings.hooks.PreToolUse.length, 2);
	assert.ok(settings.permissions.allow.includes("Bash(npm test:*)"));
	assert.ok(settings.permissions.allow.includes("Bash(gh issue edit:*)"));

	assert.match(
		readFileSync(join(target, "AGENTS.md"), "utf8"),
		/^# App\n\n## Context use\n/,
	);
	assert.match(
		readFileSync(join(target, ".gitignore"), "utf8"),
		/^\.toolkit\/$/m,
	);
	assert.match(
		readFileSync(join(target, ".gitattributes"), "utf8"),
		/^tools\/\*\* -text$/m,
	);
	assert.equal(
		readJson(target, "ticket-config.json").provider,
		"local-markdown",
	);
	assert.equal(
		readJson(target, "ticket-config.github.json").provider,
		"github",
	);
	assert.ok(existsSync(join(target, "scripts/claude-ticket.mjs")));

	const pkg = readJson(target, "package.json");
	assert.equal(pkg.name, "app");
	assert.equal(
		pkg.scripts["implement-ticket"],
		"node tools/agent-workflow/src/ticket-launch.mjs --config ticket-config.json",
	);
	assert.equal(
		pkg.scripts["implement-issue"],
		"node tools/agent-workflow/src/ticket-launch.mjs --config ticket-config.github.json",
	);
	assert.equal(
		pkg.scripts["implement-batch"],
		"node tools/agent-workflow/src/ticket-batch.mjs",
	);
	assert.match(
		readFileSync(join(target, "package.json"), "utf8"),
		/^ {2}"name"/m,
		"keeps indentation",
	);

	// The generated aliases drive the vendored runner.
	mkdirSync(join(target, ".scratch/demo/issues"), { recursive: true });
	writeFileSync(
		join(target, ".scratch/demo/issues/01-demo.md"),
		"# 01\n\n**Status:** ready-for-agent\n",
	);
	writeFileSync(
		join(target, ".scratch/demo/batch.json"),
		'{ "ticketConfig": "../../ticket-config.json", "tickets": ["issues/01-demo.md"] }\n',
	);
	const batch = spawnSync(
		process.execPath,
		[
			"tools/agent-workflow/src/ticket-batch.mjs",
			".scratch/demo/batch.json",
			"--dry-run",
		],
		{
			cwd: target,
			encoding: "utf8",
		},
	);
	assert.equal(batch.status, 0, batch.stderr);
	assert.match(batch.stdout, /WOULD LAUNCH: issues\/01-demo\.md/);

	// A second run changes nothing the user owns.
	const before = [
		"AGENTS.md",
		".claude/settings.json",
		"package.json",
		".gitignore",
	].map((file) => readFileSync(join(target, file), "utf8"));
	const again = await runSetup(options, quietIo());
	assert.deepEqual(again.kept, []);
	assert.deepEqual(
		["AGENTS.md", ".claude/settings.json", "package.json", ".gitignore"].map(
			(file) => readFileSync(join(target, file), "utf8"),
		),
		before,
	);
});

test("local tracker omits GitHub configuration and warns about CLAUDE.md", async () => {
	const toolkit = fixtureToolkit();
	const target = consumer();
	writeFileSync(join(target, "CLAUDE.md"), "# Old\n");
	const io = quietIo();
	await runSetup(
		{
			target,
			toolkitRoot: toolkit,
			repo: toolkit,
			tag: TAG,
			tracker: "local",
			yes: true,
			skills: false,
			branch: false,
		},
		io,
	);
	assert.equal(git(target, ["branch", "--show-current"]).trim(), "main");
	assert.equal(existsSync(join(target, "ticket-config.github.json")), false);
	assert.equal(
		readJson(target, "package.json").scripts["implement-issue"],
		undefined,
	);
	assert.ok(
		!readJson(target, ".claude/settings.json").permissions.allow.some((rule) =>
			rule.includes("gh issue"),
		),
	);
	assert.ok(
		io.warnings.some((message) => message.includes("CLAUDE.md exists")),
	);
});

test("rejects a tag the Toolkit clone does not have", async () => {
	const toolkit = fixtureToolkit();
	await assert.rejects(
		runSetup(
			{
				target: consumer(),
				toolkitRoot: toolkit,
				tag: "v0.0.1",
				tracker: "local",
				yes: true,
			},
			quietIo(),
		),
		/tag v0\.0\.1 is not in the Toolkit clone/,
	);
});

test("parseArgs reads options and rejects unknown ones", () => {
	assert.deepEqual(
		parseArgs(["app", "--tracker", "github", "--yes", "--no-skills"]),
		{
			target: "app",
			tracker: "github",
			yes: true,
			skills: false,
		},
	);
	assert.throws(
		() => parseArgs(["--tracker", "jira"]),
		/--tracker must be one of/,
	);
	assert.throws(() => parseArgs(["--tag"]), /--tag needs a value/);
	assert.throws(() => parseArgs(["--bogus"]), /unknown option/);
});
