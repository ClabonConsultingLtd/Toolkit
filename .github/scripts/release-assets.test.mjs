import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	archiveName,
	assetPaths,
	changelogNotes,
	publishRelease,
	releaseCommand,
	sbomName,
} from "./release-assets.mjs";

const changelog =
	"# Changelog\n\n## 0.3.0 - 2026-09-21\n\n- #22: Second\n- #20: First\n\n## 0.2.0 - 2026-09-20\n\n- #19: Released\n";

test("extracts the notes for a version, and only that version", () => {
	assert.equal(
		changelogNotes(changelog, "0.3.0"),
		"- #22: Second\n- #20: First",
	);
	assert.equal(changelogNotes(changelog, "0.2.0"), "- #19: Released");
	assert.throws(
		() => changelogNotes(changelog, "9.9.9"),
		/no section for 9\.9\.9/,
	);
});

test("names assets after the tag", () => {
	assert.equal(archiveName("v0.3.0"), "toolkit-v0.3.0.tar.gz");
	assert.equal(sbomName("v0.3.0"), "toolkit-v0.3.0.cdx.json");
	assert.deepEqual(assetPaths("v0.3.0"), [
		"toolkit-v0.3.0.tar.gz",
		"SHA256SUMS",
		"toolkit-v0.3.0.cdx.json",
	]);
});

test("creates the release the first time, and clobber-uploads on a rerun", () => {
	const assets = assetPaths("v0.3.0");
	assert.deepEqual(
		releaseCommand({
			tag: "v0.3.0",
			exists: false,
			notesFile: "/tmp/notes.md",
			assetPaths: assets,
		}),
		[
			"release",
			"create",
			"v0.3.0",
			...assets,
			"--title",
			"v0.3.0",
			"--notes-file",
			"/tmp/notes.md",
		],
	);
	assert.deepEqual(
		releaseCommand({
			tag: "v0.3.0",
			exists: true,
			notesFile: "/tmp/notes.md",
			assetPaths: assets,
		}),
		["release", "upload", "v0.3.0", ...assets, "--clobber"],
	);
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "toolkit-release-assets-"));
	writeFileSync(join(root, "CHANGELOG.md"), changelog);
	return root;
}

test("publishing is idempotent: a rerun uploads instead of duplicating the release", () => {
	const root = fixture();
	let released = false;
	const calls = [];
	const run = (command, ...args) => {
		calls.push([command, ...args]);
		if (args[0] === "release" && args[1] === "view") {
			if (!released) throw new Error("release not found");
			return;
		}
		if (args[0] === "release" && args[1] === "create") released = true;
	};

	publishRelease(root, "v0.3.0", run);
	publishRelease(root, "v0.3.0", run);

	assert.deepEqual(
		calls.map(([, , verb]) => verb),
		["view", "create", "view", "upload"],
		"the second run finds the release and uploads instead of creating another",
	);
	const notesFile = calls[1].at(-1);
	assert.equal(
		readFileSync(notesFile, "utf8"),
		"- #22: Second\n- #20: First\n",
	);
});
