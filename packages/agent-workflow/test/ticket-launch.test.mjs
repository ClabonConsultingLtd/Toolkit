import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
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
