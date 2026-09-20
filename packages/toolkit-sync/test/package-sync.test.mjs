import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fetchPinnedTag, resolveTagToSha } from "../src/git.mjs";
import {
	diffPackage,
	removeStaleFiles,
	resolveManifestedFiles,
	syncPackage,
} from "../src/package-sync.mjs";
import { createFixtureRepo, mkTempDir } from "../test-helpers/fixture-repo.mjs";

function setUpCache() {
	const { repoUrl, tag, packageName } = createFixtureRepo();
	const cacheDir = join(mkTempDir(), "cache");
	const sha = resolveTagToSha(repoUrl, tag);
	fetchPinnedTag(cacheDir, repoUrl, tag, sha);
	return { cacheDir, sha, packageName, tag, repoUrl };
}

test("resolveManifestedFiles only returns files matched by the package's manifest", () => {
	const { cacheDir, sha, packageName } = setUpCache();
	const files = resolveManifestedFiles(cacheDir, sha, packageName);
	assert.deepEqual(files.sort(), ["README.md", "src/index.mjs"]);
});

test("resolveManifestedFiles throws for a package with no manifest", () => {
	const { cacheDir, sha } = setUpCache();
	assert.throws(
		() => resolveManifestedFiles(cacheDir, sha, "nope"),
		/no such vendorable package/,
	);
});

test("diffPackage reports no drift for a fresh sync", () => {
	const { cacheDir, sha, packageName } = setUpCache();
	const destDir = mkTempDir();
	syncPackage(cacheDir, sha, packageName, destDir);
	const { diverged } = diffPackage(cacheDir, sha, packageName, destDir);
	assert.deepEqual(diverged, []);
});

test("diffPackage reports a missing local file", () => {
	const { cacheDir, sha, packageName } = setUpCache();
	const destDir = mkTempDir();
	const { diverged } = diffPackage(cacheDir, sha, packageName, destDir);
	assert.deepEqual(
		diverged.sort((a, b) => a.path.localeCompare(b.path)),
		[
			{ path: "README.md", status: "missing-local" },
			{ path: "src/index.mjs", status: "missing-local" },
		],
	);
});

test("diffPackage reports a locally modified file", () => {
	const { cacheDir, sha, packageName } = setUpCache();
	const destDir = mkTempDir();
	syncPackage(cacheDir, sha, packageName, destDir);
	writeFileSync(join(destDir, "README.md"), "# locally edited\n");
	const { diverged } = diffPackage(cacheDir, sha, packageName, destDir);
	assert.deepEqual(diverged, [{ path: "README.md", status: "modified" }]);
});

test("syncPackage copies only manifested files, excluding test files not in the manifest", () => {
	const { cacheDir, sha, packageName } = setUpCache();
	const destDir = mkTempDir();
	const files = syncPackage(cacheDir, sha, packageName, destDir);
	assert.deepEqual(files.sort(), ["README.md", "src/index.mjs"]);
	assert.equal(
		readFileSync(join(destDir, "src/index.mjs"), "utf8"),
		"export const value = 1;\n",
	);
});

test("removeStaleFiles deletes a file the current manifest no longer lists", () => {
	const { cacheDir, sha, packageName } = setUpCache();
	const destDir = mkTempDir();
	syncPackage(cacheDir, sha, packageName, destDir);
	assert.equal(existsSync(join(destDir, "src/index.mjs")), true);

	const removed = removeStaleFiles(
		destDir,
		["README.md", "src/index.mjs"],
		["README.md"],
	);
	assert.deepEqual(removed, ["src/index.mjs"]);
	assert.equal(existsSync(join(destDir, "src/index.mjs")), false);
	assert.equal(existsSync(join(destDir, "README.md")), true);
});

test("removeStaleFiles is a no-op when nothing was previously synced", () => {
	const destDir = mkTempDir();
	const removed = removeStaleFiles(destDir, undefined, ["README.md"]);
	assert.deepEqual(removed, []);
});
