import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
	allowedSignersLine,
	createFixtureRepo,
	createSigningKey,
	installCli,
	mkTempDir,
	moveTag,
	testSigningKey,
	writeFile,
} from "../test-helpers/fixture-repo.mjs";

const cli = installCli();

function run(args, cliPath = cli) {
	return spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8" });
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
	const first = createFixtureRepo({ packageName: "widget-a", tag: "v1.0.0" });
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

function readPin(cwd, packageName) {
	return JSON.parse(readFileSync(join(cwd, "toolkit-pins.json"), "utf8"))[
		packageName
	];
}

/** Write a pin by hand, as for a tag pinned before it was replaced upstream. */
function writePin(cwd, packageName, pin) {
	writeFileSync(
		join(cwd, "toolkit-pins.json"),
		`${JSON.stringify({ [packageName]: pin })}\n`,
	);
}

function shaOf(root, tag) {
	return spawnSync("git", ["rev-parse", `${tag}^{commit}`], {
		cwd: root,
		encoding: "utf8",
	}).stdout.trim();
}

test("a Signed release tag passes pin, check and sync, and pin records its signer", () => {
	const { repoUrl, tag, packageName } = createFixtureRepo();
	const cwd = mkTempDir();
	const common = ["--repo", repoUrl, "--cwd", cwd];

	const pinned = run(["pin", packageName, tag, ...common]);
	assert.equal(pinned.status, 0, pinned.stderr);
	assert.equal(readPin(cwd, packageName).signer, "toolkit-release");
	assert.deepEqual(Object.keys(readPin(cwd, packageName)).slice(0, 3), [
		"tag",
		"sha",
		"signer",
	]);

	const synced = run(["sync", packageName, ...common]);
	assert.equal(synced.status, 0, synced.stderr);
	const checked = run(["check", ...common]);
	assert.equal(checked.status, 0, checked.stderr);
	assert.match(checked.stdout, /up to date/);
	assert.equal(checked.stderr, "");
});

test("an unsigned tag at or above the first signed version fails pin, check and sync", () => {
	for (const annotate of [true, false]) {
		const { repoUrl, root, tag, packageName } = createFixtureRepo({
			signingKey: null,
			annotate,
		});
		const cwd = mkTempDir();
		const common = ["--repo", repoUrl, "--cwd", cwd];

		const pinned = run(["pin", packageName, tag, ...common]);
		assert.equal(pinned.status, 1);
		assert.match(pinned.stderr, /"v1\.0\.0" is not a Signed release tag/);
		assert.equal(existsSync(join(cwd, "toolkit-pins.json")), false);

		writePin(cwd, packageName, { tag, sha: shaOf(root, tag) });
		for (const command of ["check", "sync"]) {
			const result = run([command, ...common]);
			assert.equal(result.status, 1, `${command}: ${result.stdout}`);
			assert.match(result.stderr, /is not a Signed release tag/);
		}
		assert.equal(existsSync(join(cwd, packageName)), false);
	}
});

test("a tag signed by an unknown key fails pin, check and sync", () => {
	const { repoUrl, root, tag, packageName } = createFixtureRepo({
		signingKey: createSigningKey(),
	});
	const cwd = mkTempDir();
	const common = ["--repo", repoUrl, "--cwd", cwd];

	const pinned = run(["pin", packageName, tag, ...common]);
	assert.equal(pinned.status, 1);
	assert.match(pinned.stderr, /does not verify against the Trust anchor/);

	writePin(cwd, packageName, { tag, sha: shaOf(root, tag) });
	for (const command of ["check", "sync"]) {
		const result = run([command, ...common]);
		assert.equal(result.status, 1, `${command}: ${result.stdout}`);
		assert.match(result.stderr, /does not verify against the Trust anchor/);
	}
});

test("a Legacy tag fails without --allow-unsigned and passes with it plus a warning", () => {
	const { repoUrl, tag, packageName } = createFixtureRepo({
		tag: "v0.13.0",
		signingKey: null,
		annotate: true,
	});
	const cwd = mkTempDir();
	const common = ["--repo", repoUrl, "--cwd", cwd];

	const refused = run(["pin", packageName, tag, ...common]);
	assert.equal(refused.status, 1);
	assert.match(refused.stderr, /"v0\.13\.0" is a Legacy tag/);
	assert.match(refused.stderr, /--allow-unsigned/);

	for (const args of [
		["pin", packageName, tag],
		["sync", packageName],
		["check"],
	]) {
		const result = run([...args, "--allow-unsigned", ...common]);
		assert.equal(result.status, 0, `${args[0]}: ${result.stderr}`);
		assert.match(result.stderr, /warning: .*Legacy tag "v0\.13\.0"/);
	}
	assert.equal(readPin(cwd, packageName).signer, undefined);

	for (const command of ["check", "sync"]) {
		const result = run([command, ...common]);
		assert.equal(result.status, 1, `${command}: ${result.stdout}`);
		assert.match(result.stderr, /is a Legacy tag/);
	}
});

test("--allow-unsigned doesn't help an unsigned tag at or above the first signed version", () => {
	const { repoUrl, tag, packageName } = createFixtureRepo({
		signingKey: null,
		annotate: true,
	});
	const cwd = mkTempDir();
	const result = run([
		"pin",
		packageName,
		tag,
		"--allow-unsigned",
		"--repo",
		repoUrl,
		"--cwd",
		cwd,
	]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /is not a Signed release tag/);
	assert.match(result.stderr, /--allow-unsigned only applies to Legacy tags/);
	assert.doesNotMatch(result.stderr, /warning/);
});

test("a key used outside its valid-before window fails", () => {
	const { repoUrl, tag, packageName } = createFixtureRepo();
	const expired = installCli({
		anchor: allowedSignersLine(testSigningKey(), {
			options: ['valid-before="20200101"'],
		}),
	});
	const cwd = mkTempDir();
	const result = run(
		["pin", packageName, tag, "--repo", repoUrl, "--cwd", cwd],
		expired,
	);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /does not verify against the Trust anchor/);
	assert.match(result.stderr, /expired/);
});

test("a vendored copy without its Trust anchor fails closed", () => {
	const { repoUrl, tag, packageName } = createFixtureRepo();
	const cwd = mkTempDir();
	const result = run(
		["pin", packageName, tag, "--repo", repoUrl, "--cwd", cwd],
		installCli({ anchor: null }),
	);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /no Trust anchor at .*allowed_signers/);
});

test("a pin file without a signer keeps working, and the next verified command adds it", () => {
	const { repoUrl, root, tag, packageName } = createFixtureRepo();
	const cwd = mkTempDir();
	const common = ["--repo", repoUrl, "--cwd", cwd];
	writePin(cwd, packageName, { tag, sha: shaOf(root, tag) });

	const checked = run(["check", ...common]);
	assert.equal(checked.status, 1);
	assert.match(checked.stdout, /missing-local: README\.md/);
	assert.equal(readPin(cwd, packageName).signer, "toolkit-release");

	writePin(cwd, packageName, { tag, sha: shaOf(root, tag) });
	const synced = run(["sync", ...common]);
	assert.equal(synced.status, 0, synced.stderr);
	assert.equal(readPin(cwd, packageName).signer, "toolkit-release");
});

const anchorPackage = "toolkit-sync";
const releaseKey = testSigningKey();
const backupKey = createSigningKey();
const releaseLine = allowedSignersLine(releaseKey);
const backupLine = allowedSignersLine(backupKey, {
	principal: "backup-release",
});

function fingerprintOf(key) {
	return spawnSync("ssh-keygen", ["-lf", `${key.privateKey}.pub`], {
		encoding: "utf8",
	}).stdout.split(" ")[1];
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

function anchorLine(action, principal, key) {
	return new RegExp(
		`${action}: ${principal} ${escapeRegExp(fingerprintOf(key))}`,
	);
}

/** Pin and sync a toolkit-sync-shaped package whose anchor is `anchor`, then move its tag to `next`. */
function vendoredAnchor(anchor, next) {
	const { repoUrl, root, tag } = createFixtureRepo({
		packageName: anchorPackage,
		anchor,
	});
	const cwd = mkTempDir();
	const common = ["--repo", repoUrl, "--cwd", cwd];
	run(["pin", anchorPackage, tag, ...common]);
	const first = run([
		"sync",
		anchorPackage,
		"--accept-trust-anchor-change",
		...common,
	]);
	assert.equal(first.status, 0, first.stdout + first.stderr);
	moveTag(root, tag, (repoRoot) => {
		writeFile(repoRoot, `packages/${anchorPackage}/allowed_signers`, next);
		writeFile(repoRoot, `packages/${anchorPackage}/README.md`, "# v2\n");
	});
	run(["pin", anchorPackage, tag, ...common]);
	const dest = join(cwd, anchorPackage);
	return { cwd, common, dest, tag };
}

test("sync with no Trust anchor at the destination needs --accept-trust-anchor-change, and --force doesn't bypass it", () => {
	const { repoUrl, tag } = createFixtureRepo({
		packageName: anchorPackage,
		anchor: releaseLine,
	});
	const cwd = mkTempDir();
	const common = ["--repo", repoUrl, "--cwd", cwd];
	run(["pin", anchorPackage, tag, ...common]);

	for (const extra of [[], ["--force"]]) {
		const refused = run(["sync", anchorPackage, ...extra, ...common]);
		assert.equal(refused.status, 1, `${extra}: ${refused.stdout}`);
		assert.match(
			refused.stdout,
			anchorLine("added", "toolkit-release", releaseKey),
		);
		assert.match(refused.stdout, /refusing to sync/);
		assert.match(refused.stdout, /--accept-trust-anchor-change/);
		assert.equal(existsSync(join(cwd, anchorPackage)), false);
		assert.equal(readPin(cwd, anchorPackage).syncedFiles, undefined);
	}

	const accepted = run([
		"sync",
		anchorPackage,
		"--accept-trust-anchor-change",
		...common,
	]);
	assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
	assert.match(
		accepted.stdout,
		anchorLine("added", "toolkit-release", releaseKey),
	);
	assert.equal(
		readFileSync(join(cwd, anchorPackage, "allowed_signers"), "utf8"),
		releaseLine,
	);
});

test("sync refuses a release that adds a Trust anchor key until --accept-trust-anchor-change, even with --force", () => {
	const { cwd, common, dest } = vendoredAnchor(
		releaseLine,
		`${releaseLine}${backupLine}`,
	);
	const pinBefore = readPin(cwd, anchorPackage);

	for (const extra of [[], ["--force"]]) {
		const refused = run(["sync", anchorPackage, ...extra, ...common]);
		assert.equal(refused.status, 1, `${extra}: ${refused.stdout}`);
		assert.match(refused.stdout, /Trust anchor/);
		assert.match(
			refused.stdout,
			anchorLine("added", "backup-release", backupKey),
		);
		assert.doesNotMatch(refused.stdout, /removed:/);
		assert.match(refused.stdout, /refusing to sync/);
		assert.match(refused.stdout, /--accept-trust-anchor-change/);
		assert.equal(
			readFileSync(join(dest, "allowed_signers"), "utf8"),
			releaseLine,
		);
		assert.equal(readFileSync(join(dest, "README.md"), "utf8"), "# widget\n");
		assert.deepEqual(readPin(cwd, anchorPackage), pinBefore);
	}

	const accepted = run([
		"sync",
		anchorPackage,
		"--accept-trust-anchor-change",
		...common,
	]);
	assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
	assert.match(
		accepted.stdout,
		anchorLine("added", "backup-release", backupKey),
	);
	assert.equal(
		readFileSync(join(dest, "allowed_signers"), "utf8"),
		`${releaseLine}${backupLine}`,
	);
	assert.equal(readFileSync(join(dest, "README.md"), "utf8"), "# v2\n");
});

test("sync prints a Trust anchor key removal and proceeds without the flag", () => {
	const { common, dest } = vendoredAnchor(
		`${releaseLine}${backupLine}`,
		releaseLine,
	);
	const synced = run(["sync", anchorPackage, ...common]);
	assert.equal(synced.status, 0, synced.stdout + synced.stderr);
	assert.match(
		synced.stdout,
		anchorLine("removed", "backup-release", backupKey),
	);
	assert.doesNotMatch(synced.stdout, /added:/);
	assert.equal(
		readFileSync(join(dest, "allowed_signers"), "utf8"),
		releaseLine,
	);
});

test("sync treats a formatting-only Trust anchor change as no change", () => {
	const { common, dest } = vendoredAnchor(
		releaseLine,
		`# release key\n\n${releaseLine.replace(/ /g, "  ")}`,
	);
	const synced = run(["sync", anchorPackage, ...common]);
	assert.equal(synced.status, 0, synced.stdout + synced.stderr);
	assert.doesNotMatch(synced.stdout, /Trust anchor/);
	assert.match(
		readFileSync(join(dest, "allowed_signers"), "utf8"),
		/^# release key/,
	);
});

test("check reports added and removed Trust anchor keys, writes nothing, and fails on an addition", () => {
	const renamed = allowedSignersLine(backupKey, { principal: "renamed" });
	const { cwd, common, dest } = vendoredAnchor(
		`${releaseLine}${backupLine}`,
		`${releaseLine}${renamed}`,
	);
	const pinBefore = readPin(cwd, anchorPackage);
	const checked = run(["check", ...common]);
	assert.equal(checked.status, 1, checked.stdout);
	assert.match(checked.stdout, anchorLine("added", "renamed", backupKey));
	assert.match(
		checked.stdout,
		anchorLine("removed", "backup-release", backupKey),
	);
	assert.match(checked.stdout, /--accept-trust-anchor-change/);
	assert.equal(
		readFileSync(join(dest, "allowed_signers"), "utf8"),
		`${releaseLine}${backupLine}`,
	);
	assert.deepEqual(readPin(cwd, anchorPackage), pinBefore);

	const removalOnly = vendoredAnchor(
		`${releaseLine}${backupLine}`,
		releaseLine,
	);
	const removal = run(["check", ...removalOnly.common]);
	assert.match(
		removal.stdout,
		anchorLine("removed", "backup-release", backupKey),
	);
	assert.doesNotMatch(removal.stdout, /added:|--accept-trust-anchor-change/);
});

test("sync prints control characters in an added Trust anchor entry escaped", () => {
	const hostile = `evil\u001b[2J namespaces="git" ${backupKey.publicKey}\n`;
	const { common } = vendoredAnchor(releaseLine, `${releaseLine}${hostile}`);
	const refused = run(["sync", anchorPackage, ...common]);
	assert.equal(refused.status, 1, refused.stdout);
	assert.equal(refused.stdout.includes("\u001b"), false);
	assert.match(refused.stdout, /added: evil\\x1b\[2J SHA256:/);
});

test("usage lists --accept-trust-anchor-change", () => {
	assert.match(run(["--help"]).stdout, /--accept-trust-anchor-change/);
});
