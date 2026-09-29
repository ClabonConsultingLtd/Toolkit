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
	assert.match(
		/^ {2}group: (.*)$/m.exec(workflow("prepare-release.yml"))[1],
		/^\$\{\{ github\.event\.pull_request\.merged && github\.event\.pull_request\.base\.ref == 'main' && 'toolkit-prepare-release' \|\| format\('toolkit-prepare-release-\{0\}', github\.run_id\) \}\}$/,
	);
	// Publishing runs on every push to main, so only the release job joins
	// its group; a skipped job never does.
	const publish = workflow("publish-release.yml");
	assert.doesNotMatch(publish, /^concurrency:/m);
	assert.match(
		publish,
		/ {2}tag:\n {4}needs: detect\n {4}if: needs\.detect\.outputs\.release == 'true'\n[\s\S]* {4}concurrency:\n {6}group: toolkit-publish-release\n/,
	);
});

test("Publish release signs in the release environment only after a release merge to main", () => {
	const text = workflow("publish-release.yml");
	assert.match(text, /^on:\n {2}push:\n {4}branches: \[main\]\n\n/m);
	assert.doesNotMatch(text, /pull_request/);
	assert.equal(text.match(/environment:/g).length, 1);
	assert.equal(text.match(/secrets\./g).length, 1);
	const tagJob = text.slice(text.indexOf("\n  tag:\n"));
	assert.match(tagJob, /^ {4}environment: release$/m);
	assert.match(
		tagJob,
		/RELEASE_TAG_SIGNING_KEY: \$\{\{ secrets\.RELEASE_TAG_SIGNING_KEY \}\}/,
	);
	assert.match(text, /run: node \.github\/scripts\/release-merge\.mjs/);
	assert.match(tagJob, /ref: \$\{\{ github\.sha \}\}/);
});

test("Publish release keeps the key in a 0600 file it always deletes, and verifies before pushing", () => {
	const text = workflow("publish-release.yml");
	const at = (needle) => {
		const index = text.indexOf(needle);
		assert.notEqual(index, -1, needle);
		return index;
	};
	assert.match(
		text,
		/\(umask 077 && printf '%s\\n' "\$RELEASE_TAG_SIGNING_KEY" > "\$key_file"\)/,
	);
	assert.match(text, /trap 'rm -f "\$key_file"' EXIT/);
	assert.match(
		text,
		/- name: Delete the signing key\n {8}if: always\(\)\n {8}run: rm -f "\$RUNNER_TEMP\/release-tag-signing-key"\n/,
	);
	const sign = at("git -c gpg.format=ssh -c user.signingkey=");
	const cleanup = at("- name: Delete the signing key");
	const verify = at("verify-tag");
	const push = at('git push origin "refs/tags/$TAG"');
	assert.ok(sign < cleanup && cleanup < verify && verify < push);
	assert.match(
		text,
		/git -c gpg\.format=ssh -c gpg\.ssh\.allowedSignersFile=packages\/toolkit-sync\/allowed_signers verify-tag "\$TAG"/,
	);
	assert.ok(push < at("actions/attest-build-provenance@"));
	assert.ok(push < at("run: node .github/scripts/release-assets.mjs"));
});
