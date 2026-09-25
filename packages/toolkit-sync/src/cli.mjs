import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fetchPinnedTag, resolveTagToSha } from "./git.mjs";
import {
	BLOCKING_STATUSES,
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

const USAGE = `usage: toolkit-sync <command> [options]

commands:
  pin <package> <tag> [--dest <dir>]   pin a package to a Toolkit tag; --dest
                                       records where it is vendored
  check                                report differences from each pin
  sync [package] [--force]             copy pinned files into place; --force
                                       overwrites local edits

options:
  --repo <url>   Toolkit repository (default: ${DEFAULT_REPO_URL})
  --cwd <dir>    consumer repo root holding ${PIN_FILE_NAME} (default: .)
  --dest <dir>   vendored package directory (default: the pin's recorded
                 dest, else <cwd>/<package>)
  -h, --help     show this help`;

class UsageError extends Error {}

function parseArgs(argv) {
	const positional = [];
	const flags = { force: false, help: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--force") flags.force = true;
		else if (arg === "--help" || arg === "-h") flags.help = true;
		else if (arg === "--repo") flags.repo = argv[++i];
		else if (arg === "--dest") flags.dest = argv[++i];
		else if (arg === "--cwd") flags.cwd = argv[++i];
		else positional.push(arg);
	}
	return { positional, flags };
}

function resolvePaths(flags) {
	const cwd = resolve(flags.cwd ?? process.cwd());
	return {
		cwd,
		pinFilePath: join(cwd, PIN_FILE_NAME),
		cacheDir: join(cwd, DEFAULT_CACHE_DIR),
		repoUrl: flags.repo ?? DEFAULT_REPO_URL,
	};
}

/** `--dest`, else the pin's recorded dest (repo-relative), else `<cwd>/<package>`. */
function destDirFor(cwd, flags, packageName, pin) {
	if (flags.dest) return resolve(flags.dest);
	if (pin?.dest) return resolve(cwd, pin.dest);
	return join(cwd, packageName);
}

/** Express `dir` relative to the repo root `cwd`, with POSIX separators. */
function toRecordedDest(cwd, dir) {
	const rel = relative(cwd, resolve(dir));
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel))
		throw new UsageError(
			`--dest must be a directory inside the repo root ${cwd}, got ${dir}`,
		);
	return rel.split(sep).join("/");
}

function displayDest(cwd, destDir) {
	const rel = relative(cwd, destDir);
	return rel && !rel.startsWith("..") ? rel.split(sep).join("/") : destDir;
}

function runPin([packageName, tag], flags) {
	if (!packageName || !tag)
		throw new UsageError(
			"usage: toolkit-sync pin <package> <tag> [--dest <dir>]",
		);
	const { pinFilePath, cacheDir, repoUrl, cwd } = resolvePaths(flags);
	const dest = flags.dest ? toRecordedDest(cwd, flags.dest) : undefined;
	const sha = resolveTagToSha(repoUrl, tag);
	fetchPinnedTag(cacheDir, repoUrl, tag, sha);
	resolveManifestedFiles(cacheDir, sha, packageName);
	const pins = setPin(pinFilePath, packageName, tag, sha, { dest });
	const recorded = pins[packageName].dest;
	const destNote = recorded ? `, dest ${recorded}` : "";
	console.log(`pinned ${packageName} to ${tag} (${sha}${destNote})`);
}

function diffOptions(pin) {
	return { baseline: pin.syncedHashes, previousFiles: pin.syncedFiles };
}

function runCheck(_positional, flags) {
	const { pinFilePath, cacheDir, repoUrl, cwd } = resolvePaths(flags);
	const pins = readPins(pinFilePath);
	let anyDiverged = false;
	for (const [packageName, pin] of Object.entries(pins)) {
		const sha = fetchPinnedTag(cacheDir, repoUrl, pin.tag, pin.sha);
		const destDir = destDirFor(cwd, flags, packageName, pin);
		const where = displayDest(cwd, destDir);
		const { diverged } = diffPackage(
			cacheDir,
			sha,
			packageName,
			destDir,
			diffOptions(pin),
		);
		if (diverged.length === 0) {
			console.log(`${packageName}: up to date with ${pin.tag} in ${where}`);
			continue;
		}
		anyDiverged = true;
		console.log(`${packageName}: diverged from ${pin.tag} in ${where}`);
		for (const entry of diverged)
			console.log(`  ${entry.status}: ${entry.path}`);
		if (!pin.syncedHashes && diverged.some((e) => e.status === "modified"))
			console.log(
				"  no sync baseline recorded: a modified file may be a local edit or an upstream change",
			);
	}
	if (anyDiverged) process.exitCode = 1;
}

function reportRefusal(packageName, pin, blocked) {
	if (pin.syncedHashes) {
		console.log(
			`${packageName}: local edits since the last sync would be overwritten by ${pin.tag}, refusing to overwrite`,
		);
		for (const entry of blocked)
			console.log(`  ${entry.status}: ${entry.path}`);
		console.log(
			"  review these edits and upstream any you want to keep, then pass --force to overwrite them",
		);
		return;
	}
	console.log(
		`${packageName}: local files differ from ${pin.tag} and no sync baseline is recorded, refusing to overwrite`,
	);
	for (const entry of blocked) console.log(`  ${entry.status}: ${entry.path}`);
	console.log(
		"  these may be local edits or just upstream changes since the vendored copy was made",
	);
	console.log(
		"  review the listed files, then pass --force to overwrite; later syncs record a baseline and only stop for real local edits",
	);
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
		const destDir = destDirFor(cwd, flags, packageName, pin);
		if (!flags.force) {
			const { diverged } = diffPackage(
				cacheDir,
				sha,
				packageName,
				destDir,
				diffOptions(pin),
			);
			const blocked = diverged.filter((e) => BLOCKING_STATUSES.has(e.status));
			if (blocked.length > 0) {
				reportRefusal(packageName, pin, blocked);
				process.exitCode = 1;
				continue;
			}
		}
		const { files, hashes } = syncPackage(cacheDir, sha, packageName, destDir);
		const removed = removeStaleFiles(destDir, pin.syncedFiles, files);
		setSyncedFiles(pinFilePath, packageName, files, { sha, hashes });
		const removedNote =
			removed.length > 0 ? `, removed ${removed.length} stale file(s)` : "";
		console.log(
			`${packageName}: synced ${files.length} file(s) from ${pin.tag} into ${displayDest(cwd, destDir)}${removedNote}`,
		);
	}
}

const commands = { pin: runPin, check: runCheck, sync: runSync };

function main(argv) {
	const [command, ...rest] = argv;
	const { positional, flags } = parseArgs(rest);
	if (command === "--help" || command === "-h" || command === "help") {
		console.log(USAGE);
		return;
	}
	const handler = commands[command];
	if (!handler) {
		const problem = command ? `unknown command "${command}"\n` : "";
		throw new UsageError(`${problem}${USAGE}`);
	}
	if (flags.help) {
		console.log(USAGE);
		return;
	}
	handler(positional, flags);
}

try {
	main(process.argv.slice(2));
} catch (error) {
	console.error(
		error instanceof UsageError ? error.message : `error: ${error.message}`,
	);
	process.exitCode = 1;
}
