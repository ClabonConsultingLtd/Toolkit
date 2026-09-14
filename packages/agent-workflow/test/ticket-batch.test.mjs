import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBatch } from "../src/ticket-batch.mjs";

function setup() {
	const root = mkdtempSync(join(tmpdir(), "ticket-batch-"));
	writeFileSync(join(root, "config.json"), '{"readyStatus":"ready","command":"agent"}');
	writeFileSync(join(root, "one.md"), "**Status:** ready\n");
	writeFileSync(join(root, "two.md"), "**Status:** done\n");
	writeFileSync(join(root, "manifest.json"), '{"ticketConfig":"config.json","tickets":["one.md","two.md"]}');
	return root;
}

test("dry run does not launch or write state", () => {
	const root = setup();
	runBatch({ manifestPath: join(root, "manifest.json"), dryRun: true });
	assert.equal(existsSync(join(root, ".toolkit", "ticket-batch-state.json")), false);
});

test("completed launch records state and continues serially", () => {
	const root = setup();
	const state = runBatch({
		manifestPath: join(root, "manifest.json"),
		dryRun: false,
		launcher: () => { writeFileSync(join(root, "one.md"), "**Status:** done\n"); return { status: 0 }; },
	});
	assert.equal(state.tickets["one.md"].status, "complete");
	assert.equal(state.tickets["two.md"].status, "complete");
	assert.equal(JSON.parse(readFileSync(join(root, ".toolkit", "ticket-batch-state.json"), "utf8")).tickets["one.md"].status, "complete");
});
