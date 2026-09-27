import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = (name) =>
	readFileSync(new URL(`../workflows/${name}`, import.meta.url), "utf8");

test("Prepare release configures local Git identity before committing a candidate", () => {
	const text = workflow("prepare-release.yml");
	const identityStep = text.indexOf("- name: Configure Git identity");
	const localName = text.indexOf(
		'git config --local user.name "github-actions[bot]"',
	);
	const localEmail = text.indexOf(
		'git config --local user.email "41898282+github-actions[bot]@users.noreply.github.com"',
	);
	const commit = text.indexOf("git commit");

	assert.notEqual(identityStep, -1, "workflow has a dedicated identity step");
	assert.ok(localName > identityStep && localName < commit);
	assert.ok(localEmail > identityStep && localEmail < commit);
});

test("Prepare release rebuilds the candidate from main on every merge", () => {
	const text = workflow("prepare-release.yml");
	assert.match(
		text,
		/if: github\.event\.pull_request\.merged == true && github\.event\.pull_request\.base\.ref == 'main'\n/,
	);
	assert.match(text, /git checkout -B release\/next\n/);
	assert.match(text, /node \.github\/scripts\/release-version\.mjs\)"/);
	assert.doesNotMatch(text, /git rebase/);
});

// GitHub keeps one pending run per concurrency group and cancels the older
// one, so a run whose job is skipped must never share the group.
test("release workflows only queue runs that do work", () => {
	const groups = ["prepare-release.yml", "publish-release.yml"].map(
		(name) => /^ {2}group: (.*)$/m.exec(workflow(name))[1],
	);
	assert.match(
		groups[0],
		/^\$\{\{ github\.event\.pull_request\.merged && github\.event\.pull_request\.base\.ref == 'main' && 'toolkit-prepare-release' \|\| format\('toolkit-prepare-release-\{0\}', github\.run_id\) \}\}$/,
	);
	assert.match(
		groups[1],
		/^\$\{\{ github\.event\.pull_request\.merged && github\.event\.pull_request\.head\.ref == 'release\/next' && 'toolkit-publish-release' \|\| format\('toolkit-publish-release-\{0\}', github\.run_id\) \}\}$/,
	);
});

test("Publish release tags the release PR's merge commit", () => {
	assert.match(
		workflow("publish-release.yml"),
		/ref: \$\{\{ github\.event\.pull_request\.merge_commit_sha \}\}/,
	);
});
