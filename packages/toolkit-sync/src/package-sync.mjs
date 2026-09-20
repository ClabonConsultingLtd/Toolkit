import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { hasBlob, listTree, readBlob } from "./git.mjs";
import { matchManifest, parseManifest } from "./manifest.mjs";

function manifestPathFor(packageName) {
	return `packages/${packageName}/toolkit-manifest.json`;
}

/** Resolve the manifested, package-relative file list for `packageName` at `sha`. */
export function resolveManifestedFiles(
	cacheDir,
	sha,
	packageName,
	{ exec } = {},
) {
	const manifestPath = manifestPathFor(packageName);
	if (!hasBlob(cacheDir, sha, manifestPath, { exec })) {
		throw new Error(
			`no such vendorable package "${packageName}" (missing ${manifestPath} at ${sha})`,
		);
	}
	const manifest = parseManifest(
		readBlob(cacheDir, sha, manifestPath, { exec }).toString("utf8"),
	);
	const prefix = `packages/${packageName}/`;
	const relativePaths = listTree(cacheDir, sha, `packages/${packageName}`, {
		exec,
	}).map((path) => path.slice(prefix.length));
	return matchManifest(relativePaths, manifest.include);
}

/**
 * Compare local vendored files under `destDir` against the pinned tree.
 * Returns `{ diverged: [{ path, status }] }`; `status` is "modified" or "missing-local".
 */
export function diffPackage(
	cacheDir,
	sha,
	packageName,
	destDir,
	{ exec } = {},
) {
	const files = resolveManifestedFiles(cacheDir, sha, packageName, { exec });
	const diverged = [];
	for (const relPath of files) {
		const localPath = join(destDir, relPath);
		if (!existsSync(localPath)) {
			diverged.push({ path: relPath, status: "missing-local" });
			continue;
		}
		const pinned = readBlob(
			cacheDir,
			sha,
			`packages/${packageName}/${relPath}`,
			{ exec },
		);
		const local = readFileSync(localPath);
		if (!local.equals(pinned))
			diverged.push({ path: relPath, status: "modified" });
	}
	return { diverged, files };
}

/** Copy every manifested file for `packageName` at `sha` into `destDir`. Returns the file list written. */
export function syncPackage(
	cacheDir,
	sha,
	packageName,
	destDir,
	{ exec } = {},
) {
	const files = resolveManifestedFiles(cacheDir, sha, packageName, { exec });
	for (const relPath of files) {
		const content = readBlob(
			cacheDir,
			sha,
			`packages/${packageName}/${relPath}`,
			{ exec },
		);
		const localPath = join(destDir, relPath);
		mkdirSync(dirname(localPath), { recursive: true });
		writeFileSync(localPath, content);
	}
	return files;
}

/**
 * Delete files under `destDir` that were written by a previous `syncPackage` call
 * (`previousFiles`, package-relative) but are no longer in `currentFiles` — a file
 * dropped from the manifest upstream. Returns the package-relative paths removed.
 */
export function removeStaleFiles(destDir, previousFiles, currentFiles) {
	const current = new Set(currentFiles);
	const removed = [];
	for (const relPath of previousFiles ?? []) {
		if (current.has(relPath)) continue;
		const localPath = join(destDir, relPath);
		if (!existsSync(localPath)) continue;
		rmSync(localPath);
		removed.push(relPath);
	}
	return removed;
}
