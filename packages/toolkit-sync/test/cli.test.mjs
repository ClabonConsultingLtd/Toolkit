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
	assert.match(diverged.stdout, /local-edit: README.md/);
});

test("--help, -h and help print usage and exit 0; no args exits 1 without a stack trace", () => {
	for (const args of [["--help"], ["-h"], ["help"], ["sync", "--help"]]) {
		const result = run(args);
		assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
		assert.match(result.stdout, /usage: toolkit-sync/);
	}
	const none = run([]);
	assert.equal(none.status, 1);
	assert.match(none.stderr, /usage: toolkit-sync/);
	assert.doesNotMatch(none.stderr, /\n\s+at /);
	const unknown = run(["frobnicate"]);
	assert.equal(unknown.status, 1);
	assert.match(unknown.stderr, /unknown command "frobnicate"/);
});

test("pin --dest records a repo-relative dest that check and sync use by default", () => {
	const { repoUrl, tag, packageName } = createFixtureRepo();
	const cwd = mkTempDir();
	const dest = join(cwd, "tools", packageName);
	const pinned = run([
		"pin",
		packageName,
		tag,
		"--dest",
		dest,
		"--repo",
		repoUrl,
		"--cwd",
		cwd,
	]);
	assert.equal(pinned.status, 0, pinned.stderr);
	const pins = JSON.parse(readFileSync(join(cwd, "toolkit-pins.json"), "utf8"));
	assert.equal(pins[packageName].dest, `tools/${packageName}`);

	const synced = run(["sync", "--repo", repoUrl, "--cwd", cwd]);
	assert.equal(synced.status, 0, synced.stderr);
	assert.equal(readFileSync(join(dest, "README.md"), "utf8"), "# widget\n");
	assert.equal(existsSync(join(cwd, packageName)), false);

	const checked = run(["check", "--repo", repoUrl, "--cwd", cwd]);
	assert.equal(checked.status, 0, checked.stdout);
	assert.match(checked.stdout, /up to date .* in tools\/widget/);

	const outside = run([
		"pin",
		packageName,
		tag,
		"--dest",
		mkTempDir(),
		"--repo",
		repoUrl,
		"--cwd",
		cwd,
	]);
	assert.equal(outside.status, 1);
	assert.match(
		outside.stderr,
		/--dest must be a directory inside the repo root/,
	);
});

test("sync overwrites upstream-only changes without --force and still guards local edits", () => {
	const { repoUrl, tag, root, packageName } = createFixtureRepo();
	const cwd = mkTempDir();
	run(["pin", packageName, tag, "--repo", repoUrl, "--cwd", cwd]);
	run(["sync", packageName, "--repo", repoUrl, "--cwd", cwd]);

	moveTag(root, tag, (repoRoot) => {
		writeFile(repoRoot, `packages/${packageName}/README.md`, "# widget v2\n");
		writeFile(
			repoRoot,
			`packages/${packageName}/src/index.mjs`,
			"export const value = 2;\n",
		);
	});
	run(["pin", packageName, tag, "--repo", repoUrl, "--cwd", cwd]);
	writeFileSync(join(cwd, packageName, "src/index.mjs"), "// local patch\n");

	const checked = run(["check", "--repo", repoUrl, "--cwd", cwd]);
	assert.equal(checked.status, 1);
	assert.match(checked.stdout, /upstream-change: README.md/);
	assert.match(checked.stdout, /local-edit: src\/index.mjs/);

	const blocked = run(["sync", packageName, "--repo", repoUrl, "--cwd", cwd]);
	assert.equal(blocked.status, 1);
	assert.match(blocked.stdout, /local edits since the last sync/);
	assert.match(blocked.stdout, /local-edit: src\/index.mjs/);
	assert.doesNotMatch(blocked.stdout, /README.md/);

	writeFileSync(
		join(cwd, packageName, "src/index.mjs"),
		"export const value = 1;\n",
	);
	const synced = run(["sync", packageName, "--repo", repoUrl, "--cwd", cwd]);
	assert.equal(synced.status, 0, synced.stdout);
	assert.equal(
		readFileSync(join(cwd, packageName, "README.md"), "utf8"),
		"# widget v2\n",
	);
	assert.equal(
		readFileSync(join(cwd, packageName, "src/index.mjs"), "utf8"),
		"export const value = 2;\n",
	);
});

test("a legacy pin without a baseline refuses differences with guidance, then records one", () => {
	const { repoUrl, tag, packageName } = createFixtureRepo();
	const cwd = mkTempDir();
	run(["pin", packageName, tag, "--repo", repoUrl, "--cwd", cwd]);
	const pinFilePath = join(cwd, "toolkit-pins.json");
	const { tag: pinnedTag, sha } = JSON.parse(readFileSync(pinFilePath, "utf8"))[
		packageName
	];
	writeFileSync(
		pinFilePath,
		`${JSON.stringify({ [packageName]: { tag: pinnedTag, sha } })}\n`,
	);
	writeFile(cwd, `${packageName}/README.md`, "# vendored long ago\n");

	const checked = run(["check", "--repo", repoUrl, "--cwd", cwd]);
	assert.equal(checked.status, 1);
	assert.match(checked.stdout, /modified: README.md/);
	assert.match(checked.stdout, /no sync baseline recorded/);

	const blocked = run(["sync", packageName, "--repo", repoUrl, "--cwd", cwd]);
	assert.equal(blocked.status, 1);
	assert.match(blocked.stdout, /refusing to overwrite/);
	assert.match(blocked.stdout, /may be local edits or just upstream changes/);
	assert.match(blocked.stdout, /review the listed files, then pass --force/);

	const forced = run([
		"sync",
		packageName,
		"--force",
		"--repo",
		repoUrl,
		"--cwd",
		cwd,
	]);
	assert.equal(forced.status, 0, forced.stderr);
	const pin = JSON.parse(readFileSync(pinFilePath, "utf8"))[packageName];
	assert.equal(pin.syncedSha, sha);
	assert.deepEqual(Object.keys(pin.syncedHashes).sort(), [
		"README.md",
		"src/index.mjs",
	]);
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
