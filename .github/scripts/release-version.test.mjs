import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	addReleaseSection,
	bump,
	candidateBump,
	parseVersion,
	prepareRelease,
	releaseBump,
	releaseCandidate,
} from "./release-version.mjs";

test("selects the greatest requested release bump", () => {
	assert.deepEqual(parseVersion("1.2.3"), [1, 2, 3]);
	assert.equal(bump("0.2.0", "patch"), "0.2.1");
	assert.equal(bump("0.2.0", "minor"), "0.3.0");
	assert.equal(bump("0.2.9", "major"), "1.0.0");
	assert.equal(releaseBump([{ name: "bug" }]), null);
	assert.equal(releaseBump([{ name: "release:patch" }]), "patch");
	assert.equal(
		releaseBump([{ name: "release:minor" }, { name: "release:patch" }]),
		"minor",
	);
	assert.equal(candidateBump([{ bump: "patch" }]), "patch");
	assert.equal(
		candidateBump([{ bump: "patch" }, { bump: "minor" }, { bump: "patch" }]),
		"minor",
	);
	assert.equal(candidateBump([{ bump: "minor" }, { bump: "major" }]), "major");
});

function pr(number, bump, mergedAt, title = `Change ${number}`) {
	return {
		number,
		title,
		labels: bump ? [{ name: `release:${bump}` }] : [{ name: "docs" }],
		mergeCommit: { oid: `sha${number}` },
		mergedAt,
	};
}

// Three labelled PRs merged within seconds, as when runs were cancelled.
const burst = [
	pr(22, "patch", "2026-09-21T10:00:40Z"),
	pr(20, "patch", "2026-09-21T10:00:00Z"),
	pr(21, "minor", "2026-09-21T10:00:20Z"),
];

test("builds the candidate from every labelled PR since the last release", () => {
	const candidate = releaseCandidate(
		[
			...burst,
			pr(23, null, "2026-09-21T10:01:00Z"),
			pr(19, "major", "2026-09-20T09:00:00Z"),
		],
		["sha20", "sha21", "sha22", "sha23"],
		"# Changelog\n",
	);
	assert.deepEqual(
		candidate.map((entry) => entry.number),
		[22, 21, 20],
		"newest first; unlabelled and already-tagged PRs excluded",
	);
	assert.equal(candidateBump(candidate), "minor");
});

test("skips PRs the changelog already lists", () => {
	const candidate = releaseCandidate(
		burst,
		["sha20", "sha21", "sha22"],
		"# Changelog\n\n## 0.3.0 - 2026-09-21\n\n- #21: Change 21\n",
	);
	assert.deepEqual(
		candidate.map((entry) => entry.number),
		[22, 20],
	);
});

test("adds a new section without touching released ones", () => {
	const changelog = "# Changelog\n\n## 0.2.0 - 2026-09-20\n\n- #19: Released\n";
	assert.equal(
		addReleaseSection(changelog, "0.2.1", "2026-09-21", [
			{ number: 21, title: "Second" },
			{ number: 20, title: "First" },
		]),
		"# Changelog\n\n## 0.2.1 - 2026-09-21\n\n- #21: Second\n- #20: First\n\n## 0.2.0 - 2026-09-20\n\n- #19: Released\n",
	);
	assert.equal(
		addReleaseSection("# Changelog\n", "0.1.0", "2026-09-21", [
			{ number: 1, title: "First" },
		]),
		"# Changelog\n\n## 0.1.0 - 2026-09-21\n\n- #1: First\n",
	);
	assert.throws(
		() => addReleaseSection(changelog, "0.2.0", "2026-09-21", []),
		/already has a 0\.2\.0 section/,
	);
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "toolkit-release-"));
	for (const directory of [
		"agent-workflow",
		"claude-token-optimisation",
		"toolkit-sync",
		"setup-wizard",
		"image-generation",
		"image-to-3d",
	])
		mkdirSync(join(root, "packages", directory), { recursive: true });
	for (const relative of [
		"agent-workflow",
		"claude-token-optimisation",
		"toolkit-sync",
		"setup-wizard",
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

test("rebuilds the candidate once, and a rerun adds nothing", () => {
	const root = fixture();
	const commits = ["sha20", "sha21", "sha22"];
	assert.equal(prepareRelease(root, burst, commits, "2026-09-21"), "0.3.0");
	for (const relative of [
		"packages/agent-workflow/package.json",
		"packages/claude-token-optimisation/package.json",
		"packages/toolkit-sync/package.json",
		"packages/setup-wizard/package.json",
		"packages/image-generation/pyproject.toml",
		"packages/image-to-3d/pyproject.toml",
		"packages/image-generation/uv.lock",
		"packages/image-to-3d/uv.lock",
	])
		assert.match(readFileSync(join(root, relative), "utf8"), /0\.3\.0/);
	const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
	assert.equal(
		changelog,
		"# Changelog\n\n## 0.3.0 - 2026-09-21\n\n- #22: Change 22\n- #21: Change 21\n- #20: Change 20\n\n## 0.2.0 - 2026-09-20\n\n- Existing entry.\n",
	);
	const rebuilt = fixture();
	prepareRelease(rebuilt, [...burst].reverse(), commits, "2026-09-21");
	assert.equal(readFileSync(join(rebuilt, "CHANGELOG.md"), "utf8"), changelog);
	assert.equal(prepareRelease(root, burst, commits, "2026-09-22"), null);
	assert.equal(readFileSync(join(root, "CHANGELOG.md"), "utf8"), changelog);
});

test("does nothing when no labelled PR is waiting", () => {
	const root = fixture();
	assert.equal(
		prepareRelease(
			root,
			[pr(23, null, "2026-09-21T10:01:00Z")],
			["sha23"],
			"2026-09-21",
		),
		null,
	);
	assert.match(
		readFileSync(join(root, "packages/agent-workflow/package.json"), "utf8"),
		/0\.2\.0/,
	);
});
