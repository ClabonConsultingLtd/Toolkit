import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { readPins, setPin, setSyncedFiles } from "../src/pin-file.mjs";
import { mkTempDir } from "../test-helpers/fixture-repo.mjs";

test("readPins returns an empty object when no pin file exists", () => {
	const pinFilePath = join(mkTempDir(), "toolkit-pins.json");
	assert.deepEqual(readPins(pinFilePath), {});
});

test("setPin writes and merges pin entries, sorted by package name", () => {
	const pinFilePath = join(mkTempDir(), "toolkit-pins.json");
	setPin(pinFilePath, "widget", "v0.2.0", "b".repeat(40));
	setPin(pinFilePath, "agent-workflow", "v0.1.0", "a".repeat(40));

	const pins = readPins(pinFilePath);
	assert.deepEqual(pins, {
		"agent-workflow": { tag: "v0.1.0", sha: "a".repeat(40) },
		widget: { tag: "v0.2.0", sha: "b".repeat(40) },
	});
	assert.deepEqual(Object.keys(JSON.parse(readFileSync(pinFilePath, "utf8"))), [
		"agent-workflow",
		"widget",
	]);
});

test("setPin records dest and keeps dest and baseline across re-pins", () => {
	const pinFilePath = join(mkTempDir(), "toolkit-pins.json");
	setPin(pinFilePath, "widget", "v0.1.0", "a".repeat(40), {
		dest: "tools/widget",
	});
	setSyncedFiles(pinFilePath, "widget", ["README.md"], {
		sha: "a".repeat(40),
		hashes: { "README.md": "f".repeat(64) },
	});
	setPin(pinFilePath, "widget", "v0.2.0", "b".repeat(40));
	assert.deepEqual(readPins(pinFilePath), {
		widget: {
			tag: "v0.2.0",
			sha: "b".repeat(40),
			dest: "tools/widget",
			syncedSha: "a".repeat(40),
			syncedFiles: ["README.md"],
			syncedHashes: { "README.md": "f".repeat(64) },
		},
	});
});

test("setPin overwrites an existing package's pin", () => {
	const pinFilePath = join(mkTempDir(), "toolkit-pins.json");
	setPin(pinFilePath, "widget", "v0.1.0", "a".repeat(40));
	setPin(pinFilePath, "widget", "v0.2.0", "b".repeat(40));
	assert.deepEqual(readPins(pinFilePath), {
		widget: { tag: "v0.2.0", sha: "b".repeat(40) },
	});
});
