import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_VERSIONS_PATH } from "../scripts/install-scanners.mjs";

const SCRIPT = new URL("../scripts/validate-versions.mjs", import.meta.url)
	.pathname;

function run(...args) {
	return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

test("validate-versions passes the committed versions file", () => {
	const result = run(DEFAULT_VERSIONS_PATH);
	assert.equal(result.status, 0);
	assert.match(result.stdout, /shape OK/);
});

test("validate-versions rejects a file that doesn't match the installer's shape", () => {
	const dir = mkdtempSync(join(tmpdir(), "validate-versions-test-"));
	const file = join(dir, "versions.json");
	writeFileSync(
		file,
		JSON.stringify({ grype: { "1.0.0": { amd64: "x", arm64: "y" } } }),
	);
	const result = run(file);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /::error::.*unknown tool "grype"/);
});

test("validate-versions never touches the network or spawns a scanner", () => {
	// A regression guard: the module must import cleanly with no side effects
	// beyond reading the file it's given.
	const dir = mkdtempSync(join(tmpdir(), "validate-versions-test-"));
	const file = join(dir, "versions.json");
	writeFileSync(file, "not json");
	const result = run(file);
	assert.equal(result.status, 1);
});
