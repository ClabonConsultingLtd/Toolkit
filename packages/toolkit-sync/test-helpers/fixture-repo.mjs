import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

function git(cwd, args) {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function writeFile(root, relPath, content) {
	const full = join(root, relPath);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, content);
}

/**
 * Build a throwaway git repo shaped like Toolkit, with one vendorable
 * package ("widget") committed and tagged. Returns { repoUrl, root, tag, files }.
 */
export function createFixtureRepo({
	tag = "v0.1.0",
	packageName = "widget",
} = {}) {
	const root = mkdtempSync(join(tmpdir(), "toolkit-sync-fixture-"));
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
	git(root, ["tag", tag]);

	return { repoUrl: root, root, tag, files, packageName };
}

export function mkTempDir(prefix = "toolkit-sync-") {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** Force `tag` in `root` onto a new commit, after `mutate(root)` changes the working tree. */
export function moveTag(root, tag, mutate) {
	mutate(root);
	git(root, ["add", "-A"]);
	git(root, ["commit", "-q", "-m", "update"]);
	git(root, ["tag", "-f", tag]);
}

export { writeFile };
