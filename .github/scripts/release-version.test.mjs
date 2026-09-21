import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	bump,
	nextVersion,
	parseVersion,
	pendingBump,
	updateChangelog,
	updateVersions,
} from "./release-version.mjs";

test("selects the greatest requested release bump", () => {
	assert.deepEqual(parseVersion("1.2.3"), [1, 2, 3]);
	assert.equal(pendingBump("0.2.0", "0.2.1"), "patch");
	assert.equal(bump("0.2.0", "minor"), "0.3.0");
	assert.equal(nextVersion("0.2.0", "0.2.0", "patch"), "0.2.1");
	assert.equal(nextVersion("0.2.0", "0.2.1", "minor"), "0.3.0");
	assert.equal(nextVersion("0.2.0", "0.3.0", "patch"), "0.3.0");
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "toolkit-release-"));
	for (const directory of [
		"agent-workflow",
		"claude-token-optimisation",
		"toolkit-sync",
		"image-generation",
		"image-to-3d",
	])
		mkdirSync(join(root, "packages", directory), { recursive: true });
	for (const relative of [
		"agent-workflow",
		"claude-token-optimisation",
		"toolkit-sync",
	])
		writeFileSync(
			join(root, "packages", relative, "package.json"),
			'{"version":"0.2.0"}\n',
		);
	for (const relative of ["image-generation", "image-to-3d"])
		writeFileSync(
			join(root, "packages", relative, "pyproject.toml"),
			'[project]\nversion = "0.2.0"\n',
		);
	writeFileSync(
		join(root, "packages/image-generation/uv.lock"),
		'[[package]]\nname = "toolkit-image-generation"\nversion = "0.2.0"\n',
	);
	writeFileSync(
		join(root, "packages/image-to-3d/uv.lock"),
		'[[package]]\nname = "toolkit-image-to-3d"\nversion = "0.2.0"\n',
	);
	writeFileSync(
		join(root, "CHANGELOG.md"),
		"# Changelog\n\n## 0.2.0 - 2026-09-20\n\n- Existing entry.\n",
	);
	return root;
}

test("updates lockstep versions and aggregates release PRs", () => {
	const root = fixture();
	updateVersions(root, "0.2.1");
	updateChangelog(root, "0.2.1", "0.2.0", 20, "First change", "2026-09-21");
	updateChangelog(root, "0.2.1", "0.2.1", 21, "Second change", "2026-09-21");
	for (const relative of [
		"packages/agent-workflow/package.json",
		"packages/claude-token-optimisation/package.json",
		"packages/toolkit-sync/package.json",
		"packages/image-generation/pyproject.toml",
		"packages/image-to-3d/pyproject.toml",
		"packages/image-generation/uv.lock",
		"packages/image-to-3d/uv.lock",
	])
		assert.match(readFileSync(join(root, relative), "utf8"), /0\.2\.1/);
	const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
	assert.match(changelog, /## 0\.2\.1 - 2026-09-21/);
	assert.equal((changelog.match(/#21: Second change/g) ?? []).length, 1);
});
