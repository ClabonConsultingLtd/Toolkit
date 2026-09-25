import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const PIN_FILE_NAME = "toolkit-pins.json";

export function readPins(pinFilePath) {
	if (!existsSync(pinFilePath)) return {};
	return JSON.parse(readFileSync(pinFilePath, "utf8"));
}

export function writePins(pinFilePath, pins) {
	const sorted = Object.fromEntries(
		Object.keys(pins)
			.sort()
			.map((name) => [name, pins[name]]),
	);
	writeFileSync(pinFilePath, `${JSON.stringify(sorted, null, "\t")}\n`);
}

/**
 * Record `{tag, sha}` for `packageName`, keeping its recorded `dest` and
 * last-synced baseline. Pass `dest` (repo-relative, POSIX) to set or replace it.
 */
export function setPin(pinFilePath, packageName, tag, sha, { dest } = {}) {
	const pins = readPins(pinFilePath);
	const previous = pins[packageName] ?? {};
	const entry = { tag, sha };
	const recordedDest = dest ?? previous.dest;
	if (recordedDest !== undefined) entry.dest = recordedDest;
	for (const key of ["syncedSha", "syncedFiles", "syncedHashes"]) {
		if (previous[key] !== undefined) entry[key] = previous[key];
	}
	pins[packageName] = entry;
	writePins(pinFilePath, pins);
	return pins;
}

/**
 * Record what a `sync` last wrote: the commit (`sha`), the package-relative
 * `files` (so a later sync can remove ones no longer manifested), and their
 * content `hashes` (the baseline that separates local edits from upstream changes).
 */
export function setSyncedFiles(
	pinFilePath,
	packageName,
	files,
	{ sha, hashes } = {},
) {
	const pins = readPins(pinFilePath);
	if (!pins[packageName])
		throw new Error(`no pin recorded for "${packageName}"`);
	const entry = { ...pins[packageName], syncedFiles: files };
	if (sha !== undefined) entry.syncedSha = sha;
	if (hashes !== undefined) entry.syncedHashes = hashes;
	pins[packageName] = entry;
	writePins(pinFilePath, pins);
	return pins;
}
