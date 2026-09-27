import { execFileSync } from "node:child_process";
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

const bumps = ["patch", "minor", "major"];

export function releaseBump(labels) {
	const names = labels.map((label) => label.name ?? label);
	return bumps.findLast((kind) => names.includes(`release:${kind}`)) ?? null;
}

export function candidateBump(candidate) {
	return candidate.reduce(
		(kind, pr) =>
			bumps.indexOf(pr.bump) > bumps.indexOf(kind) ? pr.bump : kind,
		null,
	);
}

export function releasedPullRequests(changelog) {
	return new Set(
		[...changelog.matchAll(/^- #(\d+):/gm)].map((match) => Number(match[1])),
	);
}

// Every labelled PR waiting for a release, newest first. A PR waits when its
// merge commit is on main after the last tag and the changelog does not list
// it yet, so a run that was cancelled or skipped loses nothing.
export function releaseCandidate(pullRequests, unreleasedCommits, changelog) {
	const unreleased = new Set(unreleasedCommits);
	const released = releasedPullRequests(changelog);
	return pullRequests
		.map((pr) => ({ ...pr, bump: releaseBump(pr.labels) }))
		.filter(
			(pr) =>
				pr.bump &&
				unreleased.has(pr.mergeCommit?.oid) &&
				!released.has(pr.number),
		)
		.sort((a, b) => b.mergedAt.localeCompare(a.mergedAt) || b.number - a.number)
		.map(({ number, title, bump }) => ({ number, title, bump }));
}

export function addReleaseSection(changelog, version, date, candidate) {
	if (
		new RegExp(`^## ${version.replace(/\./g, "\\.")} - `, "m").test(changelog)
	)
		throw new Error(`CHANGELOG.md already has a ${version} section`);
	const entries = candidate.map((pr) => `- #${pr.number}: ${pr.title}`);
	const section = `## ${version} - ${date}\n\n${entries.join("\n")}\n`;
	const next = /^## /m.exec(changelog);
	if (!next) return `${changelog.trimEnd()}\n\n${section}`;
	return `${changelog.slice(0, next.index)}${section}\n${changelog.slice(next.index)}`;
}

// Rebuilds the release candidate on top of main. Returns the candidate version,
// or null when no labelled PR is waiting.
export function prepareRelease(root, pullRequests, unreleasedCommits, date) {
	const file = `${root}/CHANGELOG.md`;
	const changelog = readFileSync(file, "utf8");
	const candidate = releaseCandidate(
		pullRequests,
		unreleasedCommits,
		changelog,
	);
	if (candidate.length === 0) return null;
	const version = bump(releaseVersion(root), candidateBump(candidate));
	updateVersions(root, version);
	writeFileSync(file, addReleaseSection(changelog, version, date, candidate));
	return version;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const run = (command, ...args) =>
		execFileSync(command, args, { encoding: "utf8" }).trim();
	const tag = run(
		"git",
		"describe",
		"--tags",
		"--abbrev=0",
		"--match",
		"v[0-9]*",
	);
	// A day of slack keeps the search a superset; the commit range is exact.
	const since = new Date(
		Date.parse(run("git", "log", "-1", "--format=%cI", tag)) - 86_400_000,
	)
		.toISOString()
		.replace(/\.\d+Z$/, "Z");
	const pullRequests = JSON.parse(
		run(
			"gh",
			"pr",
			"list",
			"--base",
			"main",
			"--state",
			"merged",
			"--search",
			`merged:>=${since}`,
			"--limit",
			"1000",
			"--json",
			"number,title,labels,mergeCommit,mergedAt",
		),
	);
	const version = prepareRelease(
		process.cwd(),
		pullRequests,
		run("git", "rev-list", `${tag}..HEAD`).split("\n"),
		new Date().toISOString().slice(0, 10),
	);
	if (version) process.stdout.write(`${version}\n`);
}
