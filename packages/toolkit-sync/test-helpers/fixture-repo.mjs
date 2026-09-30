import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function git(cwd, args) {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function writeFile(root, relPath, content) {
	const full = join(root, relPath);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, content);
}

export function mkTempDir(prefix = "toolkit-sync-") {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** Generate a throwaway ed25519 key in a temporary directory. */
export function createSigningKey() {
	const privateKey = join(mkTempDir("toolkit-sync-key-"), "key");
	execFileSync("ssh-keygen", [
		"-q",
		"-t",
		"ed25519",
		"-N",
		"",
		"-C",
		"toolkit-sync-test",
		"-f",
		privateKey,
	]);
	const publicKey = readFileSync(`${privateKey}.pub`, "utf8")
		.trim()
		.split(" ")
		.slice(0, 2)
		.join(" ");
	return { privateKey, publicKey };
}

let sharedKey;

/** The throwaway key the fixtures sign with by default, made once per test file. */
export function testSigningKey() {
	sharedKey ??= createSigningKey();
	return sharedKey;
}

/** One `allowed_signers` line trusting `key` for git signatures. */
export function allowedSignersLine(
	key,
	{ principal = "toolkit-release", options = [] } = {},
) {
	return `${principal} ${['namespaces="git"', ...options].join(",")} ${key.publicKey}\n`;
}

/**
 * Tag HEAD in `root`. `signingKey` signs an annotated tag; `null` makes an
 * unsigned one, annotated if `annotate` is set and lightweight otherwise.
 */
export function tagRelease(
	root,
	tag,
	{ signingKey = testSigningKey(), annotate = false, force = false } = {},
) {
	const forceArgs = force ? ["-f"] : [];
	if (signingKey === null) {
		const kind = annotate ? ["-a", "-m", `Release ${tag}`] : [];
		git(root, ["tag", ...forceArgs, ...kind, tag]);
		return;
	}
	git(root, [
		"-c",
		"gpg.format=ssh",
		"-c",
		`user.signingkey=${signingKey.privateKey}`,
		"tag",
		"-s",
		...forceArgs,
		"-m",
		`Release ${tag}`,
		tag,
	]);
}

/**
 * Build a throwaway git repo shaped like Toolkit, with one vendorable
 * package ("widget") committed and tagged. The tag is signed with
 * `testSigningKey()` unless other `tagOptions` are given.
 * Returns { repoUrl, root, tag, files, packageName }.
 */
export function createFixtureRepo({
	tag = "v1.0.0",
	packageName = "widget",
	...tagOptions
} = {}) {
	const root = mkTempDir("toolkit-sync-fixture-");
	git(root, ["init", "-q", "-b", "main"]);
	git(root, ["config", "user.email", "test@example.com"]);
	git(root, ["config", "user.name", "Test"]);

	const files = {
		[`packages/${packageName}/toolkit-manifest.json`]: `${JSON.stringify(
			{ include: ["README.md", "src/**"] },
			null,
			"\t",
		)}\n`,
		[`packages/${packageName}/README.md`]: "# widget\n",
		[`packages/${packageName}/src/index.mjs`]: "export const value = 1;\n",
		[`packages/${packageName}/test/index.test.mjs`]:
			"// excluded from the manifest\n",
		[`packages/${packageName}/package.json`]: '{"name":"widget"}\n',
	};
	for (const [path, content] of Object.entries(files))
		writeFile(root, path, content);

	git(root, ["add", "-A"]);
	git(root, ["commit", "-q", "-m", "initial"]);
	tagRelease(root, tag, tagOptions);

	return { repoUrl: root, root, tag, files, packageName };
}

/** Force `tag` in `root` onto a new commit, after `mutate(root)` changes the working tree. */
export function moveTag(root, tag, mutate, tagOptions = {}) {
	mutate(root);
	git(root, ["add", "-A"]);
	git(root, ["commit", "-q", "-m", "update"]);
	tagRelease(root, tag, { ...tagOptions, force: true });
}

/** The Toolkit repository these tests run in. Its tags are the real Legacy tags. */
export const toolkitRepo = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Build a bare repo holding a copy of Toolkit's real Legacy tag `tag`.
 * `retag` replaces it on the same commit: "annotated" with a new tag object,
 * "lightweight" with none. Returns { repoUrl, root, tag }.
 */
export function copyLegacyTag(tag, { retag } = {}) {
	const root = mkTempDir("toolkit-sync-legacy-");
	git(root, ["init", "-q", "--bare"]);
	git(root, [
		"fetch",
		"-q",
		"--depth",
		"1",
		toolkitRepo,
		`+refs/tags/${tag}:refs/tags/${tag}`,
	]);
	if (retag) {
		const commit = git(root, ["rev-parse", `refs/tags/${tag}^{commit}`]);
		const kind = retag === "annotated" ? ["-a", "-m", `Release ${tag}`] : [];
		git(root, [
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.com",
			"tag",
			"-f",
			...kind,
			tag,
			commit.trim(),
		]);
	}
	return { repoUrl: root, root, tag };
}

const srcDir = fileURLToPath(new URL("../src/", import.meta.url));

/**
 * Vendor a copy of toolkit-sync into a temporary directory, the way a
 * consumer does, with `anchor` as its Trust anchor (`null` for none).
 * Returns the path of the copied `cli.mjs`.
 */
export function installCli({
	anchor = allowedSignersLine(testSigningKey()),
} = {}) {
	const root = mkTempDir("toolkit-sync-vendored-");
	mkdirSync(join(root, "src"));
	for (const name of readdirSync(srcDir))
		copyFileSync(join(srcDir, name), join(root, "src", name));
	if (anchor !== null) writeFileSync(join(root, "allowed_signers"), anchor);
	return join(root, "src", "cli.mjs");
}

export { writeFile };
