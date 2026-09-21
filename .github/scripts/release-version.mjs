import { readFileSync, writeFileSync } from "node:fs";

const packageFiles = [
	"packages/agent-workflow/package.json",
	"packages/claude-token-optimisation/package.json",
	"packages/toolkit-sync/package.json",
];
const pythonFiles = [
	"packages/image-generation/pyproject.toml",
	"packages/image-to-3d/pyproject.toml",
];
const lockFiles = [
	"packages/image-generation/uv.lock",
	"packages/image-to-3d/uv.lock",
];

export function parseVersion(version) {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	if (!match) throw new Error(`invalid version: ${version}`);
	return match.slice(1).map(Number);
}

export function bump(version, kind) {
	const [major, minor, patch] = parseVersion(version);
	if (kind === "major") return `${major + 1}.0.0`;
	if (kind === "minor") return `${major}.${minor + 1}.0`;
	if (kind === "patch") return `${major}.${minor}.${patch + 1}`;
	throw new Error(`invalid release bump: ${kind}`);
}

export function pendingBump(base, candidate) {
	if (base === candidate) return null;
	const [baseMajor, baseMinor, basePatch] = parseVersion(base);
	const [candidateMajor, candidateMinor, candidatePatch] =
		parseVersion(candidate);
	if (candidateMajor > baseMajor) return "major";
	if (candidateMajor === baseMajor && candidateMinor > baseMinor)
		return "minor";
	if (
		candidateMajor === baseMajor &&
		candidateMinor === baseMinor &&
		candidatePatch > basePatch
	)
		return "patch";
	throw new Error(`${candidate} is not newer than ${base}`);
}

export function nextVersion(base, candidate, requested) {
	const rank = { patch: 1, minor: 2, major: 3 };
	const pending = pendingBump(base, candidate);
	return bump(
		base,
		!pending || rank[requested] > rank[pending] ? requested : pending,
	);
}

function replaceExactlyOnce(text, pattern, replacement, file) {
	const flags = pattern.flags.includes("g")
		? pattern.flags
		: `${pattern.flags}g`;
	if ([...text.matchAll(new RegExp(pattern.source, flags))].length !== 1)
		throw new Error(`${file}: expected exactly one version declaration`);
	return text.replace(pattern, replacement);
}

export function releaseVersion(root) {
	return JSON.parse(
		readFileSync(`${root}/packages/agent-workflow/package.json`, "utf8"),
	).version;
}

export function updateVersions(root, version) {
	parseVersion(version);
	for (const relative of packageFiles) {
		const file = `${root}/${relative}`;
		const manifest = JSON.parse(readFileSync(file, "utf8"));
		manifest.version = version;
		writeFileSync(file, `${JSON.stringify(manifest, null, "\t")}\n`);
	}
	for (const relative of pythonFiles) {
		const file = `${root}/${relative}`;
		writeFileSync(
			file,
			replaceExactlyOnce(
				readFileSync(file, "utf8"),
				/^version = "\d+\.\d+\.\d+"$/m,
				`version = "${version}"`,
				file,
			),
		);
	}
	for (const relative of lockFiles) {
		const file = `${root}/${relative}`;
		writeFileSync(
			file,
			replaceExactlyOnce(
				readFileSync(file, "utf8"),
				/(name = "toolkit-image-(?:generation|to-3d)"\nversion = )"\d+\.\d+\.\d+"/,
				`$1"${version}"`,
				file,
			),
		);
	}
}

export function updateChangelog(
	root,
	version,
	previousVersion,
	prNumber,
	title,
	date,
) {
	const file = `${root}/CHANGELOG.md`;
	const text = readFileSync(file, "utf8");
	const entry = `- #${prNumber}: ${title}`;
	if (text.includes(entry)) return;
	const escapedPrevious = previousVersion.replace(/\./g, "\\.");
	const previousHeading = new RegExp(`^## ${escapedPrevious} - .*$`, "m");
	if (previousVersion !== version && previousHeading.test(text)) {
		writeFileSync(
			file,
			text.replace(previousHeading, `## ${version} - ${date}\n\n${entry}`),
		);
		return;
	}
	const heading = new RegExp(`^## ${version.replace(/\./g, "\\.")} - .*$`, "m");
	const match = heading.exec(text);
	if (!match) throw new Error(`CHANGELOG.md has no ${version} release entry`);
	const index = match.index + match[0].length;
	writeFileSync(
		file,
		`${text.slice(0, index)}\n\n${entry}${text.slice(index)}`,
	);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const [base, requested, prNumber, title] = process.argv.slice(2);
	if (!base || !requested || !prNumber || !title)
		throw new Error(
			"usage: release-version.mjs BASE_VERSION BUMP PR_NUMBER PR_TITLE",
		);
	const root = process.cwd();
	const previous = releaseVersion(root);
	const version = nextVersion(base, previous, requested);
	updateVersions(root, version);
	updateChangelog(
		root,
		version,
		previous,
		prNumber,
		title,
		new Date().toISOString().slice(0, 10),
	);
	process.stdout.write(`${version}\n`);
}
