import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/ticket-launch.mjs", import.meta.url));
test("dry run validates configured status", () => {
	const root = mkdtempSync(join(tmpdir(), "ticket-")),
		ticket = join(root, "a.md"),
		config = join(root, "config.json");
	writeFileSync(ticket, "**Status:** ready\n");
	writeFileSync(config, '{"readyStatus":"ready","command":"agent"}');
	const r = spawnSync(
		process.execPath,
		[cli, ticket, "--config", config, "--dry-run"],
		{ encoding: "utf8" },
	);
	assert.equal(r.status, 0);
	assert.match(r.stdout, /agent/);
});

test("ticket path with shell metacharacters reaches the command as one argument, unexecuted", () => {
	const root = mkdtempSync(join(tmpdir(), "ticket-")),
		ticketDir = join(root, "tickets with space"),
		pwnedMarker = join(root, "pwned"),
		recorder = join(root, "recorder.mjs"),
		argvFile = join(root, "argv.json"),
		config = join(root, "config.json");
	mkdirSync(ticketDir, { recursive: true });
	const ticket = join(ticketDir, "$(touch pwned).md");
	writeFileSync(ticket, "**Status:** ready\n");
	writeFileSync(
		recorder,
		`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\n`,
	);
	writeFileSync(
		config,
		JSON.stringify({
			readyStatus: "ready",
			command: `${process.execPath} ${recorder}`,
		}),
	);
	const r = spawnSync(process.execPath, [cli, ticket, "--config", config], {
		encoding: "utf8",
		cwd: root,
	});
	assert.equal(r.status, 0, r.stderr);
	assert.equal(existsSync(pwnedMarker), false);
	const received = JSON.parse(readFileSync(argvFile, "utf8"));
	assert.deepEqual(received, [ticket]);
});

test("a configured command with its own flags still receives the ticket as a separate argument", () => {
	const root = mkdtempSync(join(tmpdir(), "ticket-")),
		ticket = join(root, "a.md"),
		recorder = join(root, "recorder.mjs"),
		argvFile = join(root, "argv.json"),
		config = join(root, "config.json");
	writeFileSync(ticket, "**Status:** ready\n");
	writeFileSync(
		recorder,
		`import { writeFileSync as w } from "node:fs";\nw(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\n`,
	);
	writeFileSync(
		config,
		JSON.stringify({
			readyStatus: "ready",
			command: `${process.execPath} ${recorder} --flag`,
		}),
	);
	const r = spawnSync(process.execPath, [cli, ticket, "--config", config], {
		encoding: "utf8",
		cwd: root,
	});
	assert.equal(r.status, 0, r.stderr);
	const received = JSON.parse(readFileSync(argvFile, "utf8"));
	assert.deepEqual(received, ["--flag", ticket]);
});

test("launching the configured command emits no DEP0190 warning", () => {
	const root = mkdtempSync(join(tmpdir(), "ticket-")),
		ticket = join(root, "a.md"),
		recorder = join(root, "recorder.mjs"),
		config = join(root, "config.json");
	writeFileSync(ticket, "**Status:** ready\n");
	writeFileSync(recorder, "process.exit(0);\n");
	writeFileSync(
		config,
		JSON.stringify({
			readyStatus: "ready",
			command: `${process.execPath} ${recorder}`,
		}),
	);
	const r = spawnSync(process.execPath, [cli, ticket, "--config", config], {
		encoding: "utf8",
	});
	assert.doesNotMatch(r.stderr, /DEP0190/);
});
