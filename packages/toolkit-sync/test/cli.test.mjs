import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	createFixtureRepo,
	mkTempDir,
	moveTag,
	writeFile,
} from "../test-helpers/fixture-repo.mjs";

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

function run(args) {
	return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

test("pin resolves the tag, records it, and rejects an unknown package", () => {
	const { repoUrl, tag, packageName } = createFixtureRepo();
	const cwd = mkTempDir();

	const pinned = run([
		"pin",
		packageName,
		tag,
		"--repo",
		repoUrl,
		"--cwd",
		cwd,
	]);
	assert.equal(pinned.status, 0, pinned.stderr);
	const pins = JSON.parse(readFileSync(join(cwd, "toolkit-pins.json"), "utf8"));
	assert.equal(pins[packageName].tag, tag);
	assert.match(pins[packageName].sha, /^[0-9a-f]{40}$/);

	const unknown = run(["pin", "nope", tag, "--repo", repoUrl, "--cwd", cwd]);
	assert.notEqual(unknown.status, 0);
	assert.match(unknown.stderr, /no such vendorable package/);
});

test("check reports up to date, then diverged after a local edit", () => {
	const { repoUrl, tag, packageName } = createFixtureRepo();
	const cwd = mkTempDir();
	run(["pin", packageName, tag, "--repo", repoUrl, "--cwd", cwd]);
	run(["sync", packageName, "--repo", repoUrl, "--cwd", cwd]);

	const clean = run(["check", "--repo", repoUrl, "--cwd", cwd]);
	assert.equal(clean.status, 0, clean.stderr);
	assert.match(clean.stdout, /up to date/);

	writeFileSync(join(cwd, packageName, "README.md"), "# edited locally\n");
	const diverged = run(["check", "--repo", repoUrl, "--cwd", cwd]);
	assert.equal(diverged.status, 1);
	assert.match(diverged.stdout, /diverged/);
	assert.match(diverged.stdout, /modified: README.md/);
});

test("sync refuses to overwrite diverged files unless --force is passed", () => {
	const { repoUrl, tag, packageName } = createFixtureRepo();
	const cwd = mkTempDir();
	run(["pin", packageName, tag, "--repo", repoUrl, "--cwd", cwd]);
	run(["sync", packageName, "--repo", repoUrl, "--cwd", cwd]);
	writeFileSync(
		join(cwd, packageName, "README.md"),
		"# my local improvement\n",
	);

	const blocked = run(["sync", packageName, "--repo", repoUrl, "--cwd", cwd]);
	assert.equal(blocked.status, 1);
	assert.match(blocked.stdout, /refusing to overwrite/);
	assert.equal(
		readFileSync(join(cwd, packageName, "README.md"), "utf8"),
		"# my local improvement\n",
	);

	const forced = run([
		"sync",
		packageName,
		"--repo",
		repoUrl,
		"--cwd",
		cwd,
		"--force",
	]);
	assert.equal(forced.status, 0, forced.stderr);
	assert.equal(
		readFileSync(join(cwd, packageName, "README.md"), "utf8"),
		"# widget\n",
	);
});

test("sync removes a local file dropped from the manifest upstream", () => {
	const { repoUrl, tag, root, packageName } = createFixtureRepo();
	const cwd = mkTempDir();
	run(["pin", packageName, tag, "--repo", repoUrl, "--cwd", cwd]);
	run(["sync", packageName, "--repo", repoUrl, "--cwd", cwd]);
	assert.equal(existsSync(join(cwd, packageName, "src/index.mjs")), true);

	moveTag(root, tag, (repoRoot) => {
		writeFile(
			repoRoot,
			`packages/${packageName}/toolkit-manifest.json`,
			`${JSON.stringify({ include: ["README.md"] }, null, "\t")}\n`,
		);
	});
	run(["pin", packageName, tag, "--repo", repoUrl, "--cwd", cwd]);
	const synced = run(["sync", packageName, "--repo", repoUrl, "--cwd", cwd]);

	assert.equal(synced.status, 0, synced.stderr);
	assert.match(synced.stdout, /removed 1 stale file/);
	assert.equal(existsSync(join(cwd, packageName, "src/index.mjs")), false);
	assert.equal(existsSync(join(cwd, packageName, "README.md")), true);
});

test("sync with no package argument syncs every pinned package", () => {
	const first = createFixtureRepo({ packageName: "widget-a", tag: "v0.1.0" });
	const cwd = mkTempDir();
	run([
		"pin",
		first.packageName,
		first.tag,
		"--repo",
		first.repoUrl,
		"--cwd",
		cwd,
	]);

	const all = run(["sync", "--repo", first.repoUrl, "--cwd", cwd]);
	assert.equal(all.status, 0, all.stderr);
	assert.equal(
		readFileSync(join(cwd, "widget-a", "README.md"), "utf8"),
		"# widget\n",
	);
});
