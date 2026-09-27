import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const srcDir = fileURLToPath(new URL("../src", import.meta.url));

function copyIntoSpacedDirectory() {
	const root = mkdtempSync(join(tmpdir(), "run-as-script-"));
	const spaced = join(root, "has space");
	cpSync(srcDir, spaced, { recursive: true });
	return spaced;
}

test("handoff runs as a script from a directory whose path contains a space", () => {
	const spaced = copyIntoSpacedDirectory();
	const result = spawnSync(process.execPath, [join(spaced, "handoff.mjs")], {
		encoding: "utf8",
	});
	// A previously-matched exit(0)-silent-no-op would report status 0 and no
	// usage error; this proves main() actually ran.
	assert.equal(result.status, 1);
	assert.match(result.stderr, /usage: node handoff\.mjs/);
});

test("ticket-batch runs as a script from a directory whose path contains a space", () => {
	const spaced = copyIntoSpacedDirectory();
	const result = spawnSync(
		process.execPath,
		[join(spaced, "ticket-batch.mjs")],
		{
			encoding: "utf8",
		},
	);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /usage: node ticket-batch\.mjs/);
});

test("the hand-built file:// comparison breaks for a space and for a Windows drive letter", () => {
	const spacedPath = "/tmp/has space/handoff.mjs";
	const naiveUrl = `file://${spacedPath.replaceAll("\\", "/")}`;
	// pathToFileURL percent-encodes the space; the naive template does not,
	// so the two never compare equal even though they name the same file.
	assert.notEqual(naiveUrl, pathToFileURL(spacedPath).href);

	// On Windows, resolve() yields e.g. "C:\Users\a\handoff.mjs" and Node
	// reports import.meta.url as "file:///C:/Users/a/handoff.mjs" (three
	// slashes). The naive template only ever produces two, so it can never
	// match regardless of the path's contents.
	const windowsPath = "C:\\Users\\a\\handoff.mjs";
	const naiveWindowsUrl = `file://${windowsPath.replaceAll("\\", "/")}`;
	assert.equal(naiveWindowsUrl, "file://C:/Users/a/handoff.mjs");
	assert.notEqual(naiveWindowsUrl, "file:///C:/Users/a/handoff.mjs");
});
