import { createHash } from "node:crypto";
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

/** SHA-256 of a file's raw contents, as recorded in a pin's `syncedHashes` baseline. */
export function hashContent(content) {
	return createHash("sha256").update(content).digest("hex");
}

/** Statuses meaning a local edit, or a difference with no baseline to explain it. */
export const BLOCKING_STATUSES = new Set(["local-edit", "modified"]);

/**
 * Compare local vendored files under `destDir` against the pinned tree.
 *
 * `baseline` is the `{ path: sha256 }` map the last `sync` wrote (a pin's
 * `syncedHashes`); `previousFiles` is the file list it wrote (`syncedFiles`).
 * Returns `{ diverged: [{ path, status }], files }`, where `status` is:
 * - "missing-local": manifested at the pin but absent locally;
 * - "upstream-change": differs from the pin but matches the baseline, so only
 *   upstream changed;
 * - "local-edit": differs from the baseline (edited since the last sync);
 * - "modified": differs from the pin and there is no baseline to say why;
 * - "removed-upstream": synced before, no longer manifested, not edited.
 */
export function diffPackage(
	cacheDir,
	sha,
	packageName,
	destDir,
	{ exec, baseline, previousFiles } = {},
) {
	const files = resolveManifestedFiles(cacheDir, sha, packageName, { exec });
	const classify = (relPath, local) => {
		if (!baseline) return "modified";
		return baseline[relPath] === hashContent(local)
			? "upstream-change"
			: "local-edit";
	};
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
			diverged.push({ path: relPath, status: classify(relPath, local) });
	}
	const current = new Set(files);
	for (const relPath of previousFiles ?? []) {
		const localPath = join(destDir, relPath);
		if (current.has(relPath) || !existsSync(localPath)) continue;
		const edited =
			baseline && classify(relPath, readFileSync(localPath)) === "local-edit";
		diverged.push({
			path: relPath,
			status: edited ? "local-edit" : "removed-upstream",
		});
	}
	return { diverged, files };
}

/**
 * Copy every manifested file for `packageName` at `sha` into `destDir`.
 * Returns `{ files, hashes }`: the files written and their `{ path: sha256 }` baseline.
 */
export function syncPackage(
	cacheDir,
	sha,
	packageName,
	destDir,
	{ exec } = {},
) {
	const files = resolveManifestedFiles(cacheDir, sha, packageName, { exec });
	const hashes = {};
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
		hashes[relPath] = hashContent(content);
	}
	return { files, hashes };
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
