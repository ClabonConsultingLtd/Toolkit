import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
	fetchPinnedTag,
	hasBlob,
	listTree,
	readBlob,
	resolveTagToSha,
} from "../src/git.mjs";
import {
	createFixtureRepo,
	mkTempDir,
	moveTag,
	writeFile,
} from "../test-helpers/fixture-repo.mjs";

test("resolveTagToSha resolves a lightweight tag to its commit sha", () => {
	const { repoUrl, tag } = createFixtureRepo();
	const sha = resolveTagToSha(repoUrl, tag);
	assert.match(sha, /^[0-9a-f]{40}$/);
});

test("resolveTagToSha throws for an unknown tag", () => {
	const { repoUrl } = createFixtureRepo();
	assert.throws(
		() => resolveTagToSha(repoUrl, "v9.9.9"),
		/could not resolve tag/,
	);
});

test("fetchPinnedTag fetches the tag and returns its sha, listTree/readBlob/hasBlob work against it", () => {
	const { repoUrl, tag, packageName } = createFixtureRepo();
	const cacheDir = join(mkTempDir(), "cache");
	const expected = resolveTagToSha(repoUrl, tag);
	const sha = fetchPinnedTag(cacheDir, repoUrl, tag, expected);
	assert.equal(sha, expected);

	const tree = listTree(cacheDir, sha);
	assert.ok(tree.includes(`packages/${packageName}/README.md`));
	assert.ok(tree.includes(`packages/${packageName}/toolkit-manifest.json`));

	assert.equal(
		hasBlob(cacheDir, sha, `packages/${packageName}/README.md`),
		true,
	);
	assert.equal(
		hasBlob(cacheDir, sha, "packages/does-not-exist/README.md"),
		false,
	);

	const content = readBlob(cacheDir, sha, `packages/${packageName}/README.md`);
	assert.equal(content.toString("utf8"), "# widget\n");
});

test("listTree scoped to a pathspec only walks that subtree", () => {
	const { repoUrl, tag, packageName } = createFixtureRepo();
	const cacheDir = join(mkTempDir(), "cache");
	const sha = fetchPinnedTag(
		cacheDir,
		repoUrl,
		tag,
		resolveTagToSha(repoUrl, tag),
	);
	const scoped = listTree(cacheDir, sha, `packages/${packageName}`);
	assert.ok(
		scoped.every((path) => path.startsWith(`packages/${packageName}/`)),
	);
	assert.ok(scoped.includes(`packages/${packageName}/README.md`));
});

test("fetchPinnedTag re-fetches cleanly after the upstream tag moves, and reports the move rather than an opaque git error", () => {
	const { repoUrl, tag, root, packageName } = createFixtureRepo();
	const cacheDir = join(mkTempDir(), "cache");
	const firstSha = resolveTagToSha(repoUrl, tag);
	fetchPinnedTag(cacheDir, repoUrl, tag, firstSha);

	moveTag(root, tag, (repoRoot) => {
		writeFile(repoRoot, `packages/${packageName}/README.md`, "# widget v2\n");
	});
	const secondSha = resolveTagToSha(repoUrl, tag);
	assert.notEqual(secondSha, firstSha);

	assert.throws(
		() => fetchPinnedTag(cacheDir, repoUrl, tag, firstSha),
		/tag "v0\.1\.0" now points to/,
	);
	const refetched = fetchPinnedTag(cacheDir, repoUrl, tag, secondSha);
	assert.equal(refetched, secondSha);
});

test("fetchPinnedTag rejects a mismatched expected sha", () => {
	const { repoUrl, tag } = createFixtureRepo();
	const cacheDir = join(mkTempDir(), "cache");
	assert.throws(
		() => fetchPinnedTag(cacheDir, repoUrl, tag, "0".repeat(40)),
		/re-run "pin"/,
	);
});
