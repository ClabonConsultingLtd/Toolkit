import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";

function defaultGitExec(args, options) {
	return execFileSync("git", args, { encoding: "utf8", ...options });
}

/** Resolve a tag on `repoUrl` to the commit SHA it points at (dereferencing annotated tags). */
export function resolveTagToSha(repoUrl, tag, { exec = defaultGitExec } = {}) {
	const refs = [`refs/tags/${tag}^{}`, `refs/tags/${tag}`];
	for (const ref of refs) {
		const out = exec(["ls-remote", repoUrl, ref]);
		const line = out.split("\n").find((entry) => entry.trim().length > 0);
		if (line) return line.split(/\s+/)[0];
	}
	throw new Error(`could not resolve tag "${tag}" on ${repoUrl}`);
}

/** Ensure a local git object cache exists at `cacheDir`. */
export function ensureCache(cacheDir, { exec = defaultGitExec } = {}) {
	if (existsSync(cacheDir)) return;
	mkdirSync(cacheDir, { recursive: true });
	exec(["init", "--bare", "-q", cacheDir]);
}

/**
 * Fetch `tag` from `repoUrl` into `cacheDir` and return the commit SHA fetched.
 * Throws if the fetched commit does not match `expectedSha` (the tag moved upstream).
 */
export function fetchPinnedTag(
	cacheDir,
	repoUrl,
	tag,
	expectedSha,
	{ exec = defaultGitExec } = {},
) {
	ensureCache(cacheDir, { exec });
	exec([
		"--git-dir",
		cacheDir,
		"fetch",
		"-q",
		"--depth",
		"1",
		repoUrl,
		`+refs/tags/${tag}:refs/tags/${tag}`,
	]);
	const out = exec([
		"--git-dir",
		cacheDir,
		"rev-list",
		"-n",
		"1",
		`refs/tags/${tag}`,
	]);
	const sha = out.trim();
	if (expectedSha && sha !== expectedSha) {
		throw new Error(
			`tag "${tag}" now points to ${sha}, not the pinned ${expectedSha} — re-run "pin" to accept the move`,
		);
	}
	return sha;
}

/** List every blob path in the tree at `sha`, optionally scoped to `pathspec` (default: the whole tree). */
export function listTree(
	cacheDir,
	sha,
	pathspec = ".",
	{ exec = defaultGitExec } = {},
) {
	const out = exec([
		"--git-dir",
		cacheDir,
		"ls-tree",
		"-r",
		"--name-only",
		sha,
		"--",
		pathspec,
	]);
	return out.split("\n").filter((entry) => entry.length > 0);
}

/** Read the raw contents of `path` as it exists in the tree at `sha`. */
export function readBlob(cacheDir, sha, path, { exec = defaultGitExec } = {}) {
	return Buffer.from(
		exec(["--git-dir", cacheDir, "show", `${sha}:${path}`], {
			encoding: "buffer",
		}),
	);
}

/** Whether `path` exists in the tree at `sha`. */
export function hasBlob(cacheDir, sha, path, { exec = defaultGitExec } = {}) {
	try {
		exec(["--git-dir", cacheDir, "cat-file", "-e", `${sha}:${path}`]);
		return true;
	} catch {
		return false;
	}
}
