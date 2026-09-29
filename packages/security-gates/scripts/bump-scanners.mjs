// Checks scanner-versions.json against each tool's latest GitHub release and
// writes back any version that is behind, after verifying the new release's
// assets against its own published checksums (and cosign signature, where
// install-scanners.mjs already requires one). Data-driven from TOOLS in
// install-scanners.mjs, so a tool added there is covered automatically.
//
// A release that can't be verified is skipped with a warning; its pin is
// left unchanged. Nothing is written when no tool is behind.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import {
	ARCHES,
	TOOLS as DEFAULT_TOOLS,
	DEFAULT_VERSIONS_PATH,
	download,
	installScanners,
	parseVersions,
	runnerArch,
	sha256,
	verifyReleaseChecksum,
	verifySignature,
} from "./install-scanners.mjs";

const REPO_PATTERN = /github\.com\/([^/]+)\/([^/]+)\/releases/;

// The owner/repo a tool's release assets live in, read back from its own
// download URL template rather than duplicated per tool.
export function toolRepo(tool, tools = DEFAULT_TOOLS) {
	const url = tools[tool].url("0.0.0", "amd64");
	const match = REPO_PATTERN.exec(url);
	if (!match)
		throw new Error(
			`${tool}: could not find a GitHub repo in its download URL`,
		);
	return { owner: match[1], repo: match[2] };
}

export async function fetchLatestRelease(owner, repo, { fetchImpl, token }) {
	const headers = { Accept: "application/vnd.github+json" };
	if (token) headers.Authorization = `Bearer ${token}`;
	const response = await fetchImpl(
		`https://api.github.com/repos/${owner}/${repo}/releases/latest`,
		{ headers },
	);
	if (!response.ok)
		throw new Error(
			`${owner}/${repo}: GitHub API returned HTTP ${response.status} for the latest release`,
		);
	const data = await response.json();
	const version = String(data.tag_name ?? "").replace(/^v/, "");
	if (!/^\d+\.\d+\.\d+$/.test(version))
		throw new Error(
			`${owner}/${repo}: latest release tag "${data.tag_name}" is not vX.Y.Z`,
		);
	return {
		version,
		url: data.html_url,
		assets: (data.assets ?? []).map((a) => ({
			name: a.name,
			url: a.browser_download_url,
		})),
	};
}

// X.Y.Z comparison; the versions file and the GitHub API both guarantee the
// shape (parseVersions and fetchLatestRelease each reject anything else).
export function isNewer(current, latest) {
	const a = current.split(".").map(Number);
	const b = latest.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		if (b[i] > a[i]) return true;
		if (b[i] < a[i]) return false;
	}
	return false;
}

// Tools that don't declare a `checksums` URL in install-scanners.mjs's TOOLS
// table (Gitleaks, OSV-Scanner, cosign) still publish one; this finds it by
// name among the release's assets instead of a per-tool URL template.
const CHECKSUMS_ASSET = /checksums|sha256sums/i;

export function findChecksumsAsset(assets) {
	return assets.find((a) => CHECKSUMS_ASSET.test(a.name));
}

// Downloads and verifies one tool's release assets for both architectures
// against the release's own checksums file — install-scanners.mjs's
// verifyReleaseChecksum decides whether each download matches it — and its
// cosign signature where install-scanners.mjs requires one. Returns the
// { arch: sha256 } pin to write, or throws on the first arch that fails
// verification.
export async function bumpTool(
	tool,
	version,
	release,
	{ fetchImpl, cosign, tools = DEFAULT_TOOLS },
) {
	const spec = tools[tool];
	const checksumsUrl = spec.checksums
		? spec.checksums(version)
		: findChecksumsAsset(release.assets)?.url;
	if (!checksumsUrl)
		throw new Error(`${tool}: no published checksums found for ${version}`);
	const checksumsText = (await download(checksumsUrl, fetchImpl)).toString(
		"utf8",
	);

	const sha256s = {};
	for (const arch of ARCHES) {
		const url = spec.url(version, arch);
		const filename = basename(url);
		const buffer = await download(url, fetchImpl);
		const actual = sha256(buffer);
		verifyReleaseChecksum(tool, checksumsText, filename, actual);
		if (spec.signer) {
			const staged = join(
				mkdtempSync(join(tmpdir(), `security-gates-bump-${tool}-`)),
				filename,
			);
			writeFileSync(staged, buffer);
			await verifySignature(tool, staged, url, spec.signer(version), {
				cosign,
				fetchImpl,
			});
		}
		sha256s[arch] = actual;
	}
	return sha256s;
}

// Checks every tool in `tools` against its latest release, verifies and
// applies the ones that are behind, and reports the ones it couldn't verify.
export async function bumpScanners(
	versionsText,
	{ fetchImpl, token, cosign, tools = DEFAULT_TOOLS },
) {
	const pins = parseVersions(versionsText, tools);
	const existing = JSON.parse(versionsText);
	const data = {};
	const changes = [];
	const skips = [];
	for (const tool of Object.keys(tools).sort()) {
		const current = pins[tool]?.version ?? "0.0.0";
		data[tool] = existing[tool];
		try {
			const { owner, repo } = toolRepo(tool, tools);
			const release = await fetchLatestRelease(owner, repo, {
				fetchImpl,
				token,
			});
			if (!isNewer(current, release.version)) continue;
			const sha256s = await bumpTool(tool, release.version, release, {
				fetchImpl,
				cosign,
				tools,
			});
			data[tool] = { [release.version]: sha256s };
			changes.push({
				tool,
				from: current,
				to: release.version,
				url: release.url,
			});
		} catch (error) {
			skips.push({ tool, reason: error.message });
		}
	}
	return {
		versionsText: `${JSON.stringify(data, null, "\t")}\n`,
		changes,
		skips,
	};
}

export function prBody(changes) {
	const lines = [
		"Automated scanner version bump. Each release below was verified against its published checksums, plus a cosign signature where `install-scanners.mjs` requires one.",
		"",
		"| Tool | From | To | Release notes |",
		"| --- | --- | --- | --- |",
		...changes.map(
			(c) => `| ${c.tool} | ${c.from} | ${c.to} | [${c.to}](${c.url}) |`,
		),
		"",
		"This workflow runs the security-gates unit tests, the Opengrep rule tests and all three Gates against this repository's own tree, using these new pins, before opening or updating this PR. A pull request opened with the default `GITHUB_TOKEN` does not trigger `pull_request`-triggered CI, so that in-run verification is the CI signal for this PR; push a commit as a human, or re-run this workflow, to trigger it again.",
	];
	return `${lines.join("\n")}\n`;
}

const USAGE =
	"usage: bump-scanners.mjs [--versions <file>] [--pr-body <file>] [--github-output <file>]";

async function main() {
	const { values } = parseArgs({
		options: {
			versions: { type: "string" },
			"pr-body": { type: "string" },
			"github-output": { type: "string" },
			help: { type: "boolean", short: "h" },
		},
	});
	if (values.help) {
		console.log(USAGE);
		process.exit(0);
	}
	const versionsPath = values.versions ?? DEFAULT_VERSIONS_PATH;
	const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
	const authedFetch = (url, init = {}) => fetch(url, init);

	// cosign verifies Opengrep's signature below; install it now at its own
	// currently pinned (and already verified) version.
	const cosignDest = mkdtempSync(join(tmpdir(), "security-gates-bump-cosign-"));
	const [{ path: cosign }] = await installScanners(["cosign"], {
		versionsText: readFileSync(versionsPath, "utf8"),
		arch: runnerArch(),
		dest: cosignDest,
	});

	const result = await bumpScanners(readFileSync(versionsPath, "utf8"), {
		fetchImpl: authedFetch,
		token,
		cosign,
	});

	for (const skip of result.skips)
		console.log(`::warning::${skip.tool}: skipped, ${skip.reason}`);

	const githubOutput = values["github-output"] ?? process.env.GITHUB_OUTPUT;
	if (result.changes.length === 0) {
		console.log("every scanner is already at its latest verified release");
		if (githubOutput)
			writeFileSync(githubOutput, "changed=false\n", { flag: "a" });
		return;
	}

	writeFileSync(versionsPath, result.versionsText);
	console.log(
		`bumped: ${result.changes.map((c) => `${c.tool} ${c.from} -> ${c.to}`).join(", ")}`,
	);
	if (values["pr-body"])
		writeFileSync(values["pr-body"], prBody(result.changes));
	if (githubOutput)
		writeFileSync(githubOutput, "changed=true\n", { flag: "a" });
}

if (process.argv[1] === import.meta.filename) {
	main().catch((error) => {
		console.error(`::error::${error.message.replaceAll("\n", "%0A")}`);
		process.exit(1);
	});
}
