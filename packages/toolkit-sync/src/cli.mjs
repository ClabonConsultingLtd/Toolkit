import { join } from "node:path";
import { fetchPinnedTag, resolveTagToSha } from "./git.mjs";
import {
	diffPackage,
	removeStaleFiles,
	resolveManifestedFiles,
	syncPackage,
} from "./package-sync.mjs";
import {
	PIN_FILE_NAME,
	readPins,
	setPin,
	setSyncedFiles,
} from "./pin-file.mjs";

export const DEFAULT_REPO_URL =
	"https://github.com/ClabonConsultingLtd/Toolkit.git";
const DEFAULT_CACHE_DIR = ".toolkit/toolkit-sync-cache";

function parseArgs(argv) {
	const positional = [];
	const flags = { force: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--force") flags.force = true;
		else if (arg === "--repo") flags.repo = argv[++i];
		else if (arg === "--dest") flags.dest = argv[++i];
		else if (arg === "--cwd") flags.cwd = argv[++i];
		else positional.push(arg);
	}
	return { positional, flags };
}

function resolvePaths(flags) {
	const cwd = flags.cwd ?? process.cwd();
	return {
		cwd,
		pinFilePath: join(cwd, PIN_FILE_NAME),
		cacheDir: join(cwd, DEFAULT_CACHE_DIR),
		repoUrl: flags.repo ?? DEFAULT_REPO_URL,
	};
}

function destDirFor(cwd, flags, packageName) {
	return flags.dest ?? join(cwd, packageName);
}

function runPin([packageName, tag], flags) {
	if (!packageName || !tag)
		throw new Error("usage: toolkit-sync pin <package> <tag>");
	const { pinFilePath, cacheDir, repoUrl } = resolvePaths(flags);
	const sha = resolveTagToSha(repoUrl, tag);
	fetchPinnedTag(cacheDir, repoUrl, tag, sha);
	resolveManifestedFiles(cacheDir, sha, packageName);
	setPin(pinFilePath, packageName, tag, sha);
	console.log(`pinned ${packageName} to ${tag} (${sha})`);
}

function runCheck(_positional, flags) {
	const { pinFilePath, cacheDir, repoUrl, cwd } = resolvePaths(flags);
	const pins = readPins(pinFilePath);
	let anyDiverged = false;
	for (const [packageName, pin] of Object.entries(pins)) {
		const sha = fetchPinnedTag(cacheDir, repoUrl, pin.tag, pin.sha);
		const destDir = destDirFor(cwd, flags, packageName);
		const { diverged } = diffPackage(cacheDir, sha, packageName, destDir);
		if (diverged.length === 0) {
			console.log(`${packageName}: up to date with ${pin.tag}`);
			continue;
		}
		anyDiverged = true;
		console.log(`${packageName}: diverged from ${pin.tag}`);
		for (const entry of diverged)
			console.log(`  ${entry.status}: ${entry.path}`);
	}
	if (anyDiverged) process.exitCode = 1;
}

function runSync(positional, flags) {
	const { pinFilePath, cacheDir, repoUrl, cwd } = resolvePaths(flags);
	const pins = readPins(pinFilePath);
	const requested = positional[0];
	const names = requested ? [requested] : Object.keys(pins);
	for (const packageName of names) {
		const pin = pins[packageName];
		if (!pin)
			throw new Error(`no pin recorded for "${packageName}"; run "pin" first`);
		const sha = fetchPinnedTag(cacheDir, repoUrl, pin.tag, pin.sha);
		const destDir = destDirFor(cwd, flags, packageName);
		if (!flags.force) {
			const { diverged } = diffPackage(cacheDir, sha, packageName, destDir);
			const modified = diverged.filter((entry) => entry.status === "modified");
			if (modified.length > 0) {
				console.log(
					`${packageName}: local files have diverged from ${pin.tag}, refusing to overwrite`,
				);
				for (const entry of modified)
					console.log(`  ${entry.status}: ${entry.path}`);
				console.log("  pass --force to overwrite anyway");
				process.exitCode = 1;
				continue;
			}
		}
		const files = syncPackage(cacheDir, sha, packageName, destDir);
		const removed = removeStaleFiles(destDir, pin.syncedFiles, files);
		setSyncedFiles(pinFilePath, packageName, files);
		const removedNote =
			removed.length > 0 ? `, removed ${removed.length} stale file(s)` : "";
		console.log(
			`${packageName}: synced ${files.length} file(s) from ${pin.tag}${removedNote}`,
		);
	}
}

const commands = { pin: runPin, check: runCheck, sync: runSync };

const [command, ...rest] = process.argv.slice(2);
const handler = commands[command];
if (!handler) throw new Error("usage: toolkit-sync <pin|check|sync> ...");
const { positional, flags } = parseArgs(rest);
handler(positional, flags);
