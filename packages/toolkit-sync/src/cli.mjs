import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fetchPinnedTag, resolveTagToSha } from "./git.mjs";
import {
	BLOCKING_STATUSES,
	diffPackage,
	removeStaleFiles,
	resolveManifestedFiles,
	syncPackage,
	trustAnchorChange,
} from "./package-sync.mjs";
import {
	PIN_FILE_NAME,
	readPins,
	setPin,
	setSigner,
	setSyncedFiles,
} from "./pin-file.mjs";
import { FIRST_SIGNED_VERSION, verifyReleaseTag } from "./signature.mjs";
import { fingerprintKey } from "./trust-anchor.mjs";

export const DEFAULT_REPO_URL =
	"https://github.com/ClabonConsultingLtd/Toolkit.git";
const DEFAULT_CACHE_DIR = ".toolkit/toolkit-sync-cache";

const USAGE = `usage: toolkit-sync <command> [options]

commands:
  pin <package> <tag> [--dest <dir>]   pin a package to a Toolkit tag; --dest
                                       records where it is vendored
  check                                report differences from each pin
  sync [package] [--force]             copy pinned files into place; --force
       [--accept-trust-anchor-change]  overwrites local edits

options:
  --repo <url>       Toolkit repository (default: ${DEFAULT_REPO_URL})
  --cwd <dir>        consumer repo root holding ${PIN_FILE_NAME} (default: .)
  --dest <dir>       vendored package directory (default: the pin's recorded
                     dest, else <cwd>/<package>)
  --allow-unsigned   accept a Legacy tag (below v${FIRST_SIGNED_VERSION}) without a
                     signature, with a warning
  --accept-trust-anchor-change
                     let sync write a Trust anchor that adds a key; --force
                     doesn't
  -h, --help         show this help

Every tag must be a Signed release tag that verifies against the Trust
anchor (allowed_signers, vendored beside src/). Needs git 2.34+ and ssh-keygen.`;

class UsageError extends Error {}

function parseArgs(argv) {
	const positional = [];
	const flags = {
		force: false,
		help: false,
		allowUnsigned: false,
		acceptTrustAnchorChange: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--force") flags.force = true;
		else if (arg === "--allow-unsigned") flags.allowUnsigned = true;
		else if (arg === "--accept-trust-anchor-change")
			flags.acceptTrustAnchorChange = true;
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

/** Verify the fetched tag; returns the signer principal, or undefined for an allowed Legacy tag. */
function verifiedSigner(cacheDir, tag, flags) {
	return verifyReleaseTag(cacheDir, tag, { allowUnsigned: flags.allowUnsigned })
		.signer;
}

/** Record a verified signer the pin file lacks, as an older pin file does. */
function recordSigner(pinFilePath, packageName, pin, signer) {
	if (signer !== undefined && pin.signer !== signer)
		setSigner(pinFilePath, packageName, signer);
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
	const signer = verifiedSigner(cacheDir, tag, flags);
	resolveManifestedFiles(cacheDir, sha, packageName);
	const pins = setPin(pinFilePath, packageName, tag, sha, { dest, signer });
	const recorded = pins[packageName].dest;
	const destNote = recorded ? `, dest ${recorded}` : "";
	const signerNote = signer ? `, signed by ${signer}` : "";
	console.log(
		`pinned ${packageName} to ${tag} (${sha}${destNote}${signerNote})`,
	);
}

function diffOptions(pin) {
	return { baseline: pin.syncedHashes, previousFiles: pin.syncedFiles };
}

/** Escape control characters, so an anchor entry can't rewrite the terminal. */
const printable = (text) =>
	text.replace(
		/\p{Cc}/gu,
		(char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`,
	);

function describeAnchorEntry({ principal, options, publicKey }) {
	const fingerprint = fingerprintKey(publicKey);
	if (!principal || !fingerprint)
		return printable(
			`unreadable entry "${principal ? `${principal} ` : ""}${publicKey}"`,
		);
	const optionsNote = options.length > 0 ? ` ${options.join(",")}` : "";
	return printable(`${principal} ${fingerprint}${optionsNote}`);
}

/** Print every added and removed Trust anchor entry; returns whether any was added. */
function reportAnchorChange(packageName, tag, change) {
	if (!change || (change.added.length === 0 && change.removed.length === 0))
		return false;
	console.log(
		`${packageName}: ${tag} changes the Trust anchor (allowed_signers), the keys trusted to sign Toolkit releases`,
	);
	for (const entry of change.added)
		console.log(`  added: ${describeAnchorEntry(entry)}`);
	for (const entry of change.removed)
		console.log(`  removed: ${describeAnchorEntry(entry)}`);
	return change.added.length > 0;
}

function runCheck(_positional, flags) {
	const { pinFilePath, cacheDir, repoUrl, cwd } = resolvePaths(flags);
	const pins = readPins(pinFilePath);
	let anyDiverged = false;
	for (const [packageName, pin] of Object.entries(pins)) {
		const sha = fetchPinnedTag(cacheDir, repoUrl, pin.tag, pin.sha);
		const signer = verifiedSigner(cacheDir, pin.tag, flags);
		recordSigner(pinFilePath, packageName, pin, signer);
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
		const change = trustAnchorChange(
			cacheDir,
			sha,
			packageName,
			destDir,
			diffOptions(pin),
		);
		if (reportAnchorChange(packageName, pin.tag, change))
			console.log(
				"  sync refuses to write an added key without --accept-trust-anchor-change",
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
		const signer = verifiedSigner(cacheDir, pin.tag, flags);
		recordSigner(pinFilePath, packageName, pin, signer);
		const destDir = destDirFor(cwd, flags, packageName, pin);
		let refused = false;
		const change = trustAnchorChange(
			cacheDir,
			sha,
			packageName,
			destDir,
			diffOptions(pin),
		);
		if (
			reportAnchorChange(packageName, pin.tag, change) &&
			!flags.acceptTrustAnchorChange
		) {
			console.log(
				`${packageName}: ${pin.tag} adds a Trust anchor key, refusing to sync; nothing was written for this package`,
			);
			console.log(
				"  confirm each added key with Toolkit's maintainers, then pass --accept-trust-anchor-change to trust them (--force doesn't)",
			);
			refused = true;
		}
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
				refused = true;
			}
		}
		if (refused) {
			process.exitCode = 1;
			continue;
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
