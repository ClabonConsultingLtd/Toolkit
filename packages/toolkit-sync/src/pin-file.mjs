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

export function setPin(pinFilePath, packageName, tag, sha) {
	const pins = readPins(pinFilePath);
	const syncedFiles = pins[packageName]?.syncedFiles;
	pins[packageName] = syncedFiles ? { tag, sha, syncedFiles } : { tag, sha };
	writePins(pinFilePath, pins);
	return pins;
}

/** Record which package-relative files a `sync` last wrote, so a later sync can remove ones no longer manifested. */
export function setSyncedFiles(pinFilePath, packageName, files) {
	const pins = readPins(pinFilePath);
	if (!pins[packageName])
		throw new Error(`no pin recorded for "${packageName}"`);
	pins[packageName] = { ...pins[packageName], syncedFiles: files };
	writePins(pinFilePath, pins);
	return pins;
}
