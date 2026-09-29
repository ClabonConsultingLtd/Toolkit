// Publishes the archive, checksums and SBOM for a tag as a GitHub Release.
// Reruns must not duplicate assets: the first run creates the release, every
// later run for the same tag re-uploads with --clobber instead.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function changelogNotes(changelog, version) {
	const heading = new RegExp(`^## ${version.replace(/\./g, "\\.")} - .*$`, "m");
	const match = heading.exec(changelog);
	if (!match) throw new Error(`CHANGELOG.md has no section for ${version}`);
	const bodyStart = match.index + match[0].length + 1;
	const rest = changelog.slice(bodyStart);
	const next = /^## /m.exec(rest);
	return (next ? rest.slice(0, next.index) : rest).trim();
}

export function archiveName(tag) {
	return `toolkit-${tag}.tar.gz`;
}

export function sbomName(tag) {
	return `toolkit-${tag}.cdx.json`;
}

export function assetPaths(tag) {
	return [archiveName(tag), "SHA256SUMS", sbomName(tag)];
}

// `create` the first time a tag is published; a rerun finds the release
// already exists and uploads with --clobber, replacing rather than
// duplicating each named asset.
export function releaseCommand({ tag, exists, notesFile, assetPaths }) {
	if (!exists)
		return [
			"release",
			"create",
			tag,
			...assetPaths,
			"--title",
			tag,
			"--notes-file",
			notesFile,
		];
	return ["release", "upload", tag, ...assetPaths, "--clobber"];
}

function releaseExists(tag, run) {
	try {
		run("gh", "release", "view", tag, "--json", "tagName");
		return true;
	} catch {
		return false;
	}
}

export function publishRelease(root, tag, run) {
	const version = tag.replace(/^v/, "");
	const changelog = readFileSync(`${root}/CHANGELOG.md`, "utf8");
	const notes = changelogNotes(changelog, version);
	const notesFile = join(
		mkdtempSync(join(tmpdir(), "toolkit-release-")),
		"notes.md",
	);
	writeFileSync(notesFile, `${notes}\n`);
	const exists = releaseExists(tag, run);
	const args = releaseCommand({
		tag,
		exists,
		notesFile,
		assetPaths: assetPaths(tag),
	});
	run("gh", ...args);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const run = (command, ...args) =>
		execFileSync(command, args, { stdio: "inherit" });
	publishRelease(process.cwd(), process.env.TAG, run);
}
