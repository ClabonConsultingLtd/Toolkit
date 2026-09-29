import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
	bumpScanners,
	bumpTool,
	fetchLatestRelease,
	findChecksumsAsset,
	isNewer,
	prBody,
	toolRepo,
} from "../scripts/bump-scanners.mjs";
import { TOOLS as REAL_TOOLS, sha256 } from "../scripts/install-scanners.mjs";

// A small, self-contained tool table so these tests don't depend on the real
// scanner set, and stay valid as more tools are added to install-scanners.mjs.
// gadget mirrors Opengrep (a static cert/sig signer); camera mirrors Dockle
// (a checksums() URL function, no signer).
function fakeTools() {
	return {
		widget: {
			url: (v, arch) =>
				`https://github.com/acme/widget/releases/download/v${v}/widget_linux_${arch}`,
		},
		gadget: {
			url: (v, arch) =>
				`https://github.com/acme/gadget/releases/download/v${v}/gadget_linux_${arch}`,
			signer: () => ({
				identityRegexp: "^https://.*$",
				oidcIssuer: "https://issuer.example",
			}),
		},
		camera: {
			url: (v, arch) =>
				`https://github.com/acme/camera/releases/download/v${v}/camera_linux_${arch}`,
			checksums: (v) =>
				`https://github.com/acme/camera/releases/download/v${v}/camera_checksums.txt`,
		},
	};
}

function widgetOnly() {
	const { widget } = fakeTools();
	return { widget };
}

function checksumsText(entries) {
	return `${entries.map(([hash, name]) => `${hash}  ${name}`).join("\n")}\n`;
}

// A fake GitHub + asset-download server. `releases["owner/repo"]` is a
// release object as returned by the GitHub API; `assets[url]` is the raw
// body served for that asset URL.
function fakeFetch({ releases = {}, assets = {} } = {}) {
	const requested = [];
	const impl = async (url) => {
		requested.push(url);
		const releaseMatch =
			/^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/releases\/latest$/.exec(
				url,
			);
		if (releaseMatch) {
			const release = releases[`${releaseMatch[1]}/${releaseMatch[2]}`];
			if (!release) return { ok: false, status: 404 };
			return { ok: true, status: 200, json: async () => release };
		}
		const body = assets[url];
		if (body === undefined) return { ok: false, status: 404 };
		return {
			ok: true,
			status: 200,
			arrayBuffer: async () => Buffer.from(body),
		};
	};
	return { impl, requested };
}

function ghRelease(owner, repo, tag, assetNames) {
	return {
		tag_name: tag,
		html_url: `https://github.com/${owner}/${repo}/releases/tag/${tag}`,
		assets: assetNames.map((name) => ({
			name,
			browser_download_url: `https://github.com/${owner}/${repo}/releases/download/${tag}/${name}`,
		})),
	};
}

function fakeCosign(exitStatus) {
	const path = join(tmpdir(), `bump-cosign-${process.pid}-${Math.random()}.sh`);
	const log = `${path}.log`;
	writeFileSync(
		path,
		`#!/bin/sh\nprintf '%s\\n' "$@" > ${log}\nexit ${exitStatus}\n`,
	);
	chmodSync(path, 0o755);
	return { path, log };
}

test("toolRepo reads owner/repo back from a tool's download URL", () => {
	assert.deepEqual(toolRepo("widget", fakeTools()), {
		owner: "acme",
		repo: "widget",
	});
});

test("toolRepo reads Trivy's and Dockle's repos straight from the installer's real table", () => {
	assert.deepEqual(toolRepo("trivy"), { owner: "aquasecurity", repo: "trivy" });
	assert.deepEqual(toolRepo("dockle"), {
		owner: "goodwithtech",
		repo: "dockle",
	});
});

test("isNewer compares X.Y.Z versions", () => {
	assert.equal(isNewer("1.2.3", "1.2.4"), true);
	assert.equal(isNewer("1.2.3", "1.3.0"), true);
	assert.equal(isNewer("1.2.3", "2.0.0"), true);
	assert.equal(isNewer("1.2.3", "1.2.3"), false);
	assert.equal(isNewer("1.2.3", "1.2.2"), false);
});

test("findChecksumsAsset matches common checksum file names", () => {
	assert.equal(
		findChecksumsAsset([{ name: "widget_1.2.3_checksums.txt" }]).name,
		"widget_1.2.3_checksums.txt",
	);
	assert.equal(
		findChecksumsAsset([{ name: "widget_SHA256SUMS" }]).name,
		"widget_SHA256SUMS",
	);
	assert.equal(findChecksumsAsset([{ name: "widget_linux_amd64" }]), undefined);
});

test("fetchLatestRelease rejects a non-vX.Y.Z tag", async () => {
	const { impl } = fakeFetch({
		releases: { "acme/widget": ghRelease("acme", "widget", "latest", []) },
	});
	await assert.rejects(
		fetchLatestRelease("acme", "widget", { fetchImpl: impl }),
		/is not vX\.Y\.Z/,
	);
});

test("fetchLatestRelease sends a bearer token when given one", async () => {
	let seenAuth;
	const impl = async (_url, init) => {
		seenAuth = init?.headers?.Authorization;
		return {
			ok: true,
			status: 200,
			json: async () => ghRelease("acme", "widget", "v1.0.0", []),
		};
	};
	await fetchLatestRelease("acme", "widget", {
		fetchImpl: impl,
		token: "secret",
	});
	assert.equal(seenAuth, "Bearer secret");
});

test("bumpTool verifies both architectures against the release's checksums", async () => {
	const tools = fakeTools();
	const amd64Body = "amd64-binary";
	const arm64Body = "arm64-binary";
	const release = ghRelease("acme", "widget", "v2.0.0", ["checksums.txt"]);
	const { impl } = fakeFetch({
		assets: {
			[release.assets[0].browser_download_url]: checksumsText([
				[sha256(Buffer.from(amd64Body)), "widget_linux_amd64"],
				[sha256(Buffer.from(arm64Body)), "widget_linux_arm64"],
			]),
			[tools.widget.url("2.0.0", "amd64")]: amd64Body,
			[tools.widget.url("2.0.0", "arm64")]: arm64Body,
		},
	});
	const sha256s = await bumpTool("widget", "2.0.0", asAssets(release), {
		fetchImpl: impl,
		tools,
	});
	assert.equal(sha256s.amd64, sha256(Buffer.from(amd64Body)));
	assert.equal(sha256s.arm64, sha256(Buffer.from(arm64Body)));
});

// bumpTool expects release.assets entries shaped { name, url }, matching
// fetchLatestRelease's return value (not the raw GitHub API field names).
function asAssets(release) {
	return {
		url: release.html_url,
		assets: release.assets.map((a) => ({
			name: a.name,
			url: a.browser_download_url,
		})),
	};
}

test("bumpTool rejects a release with no published checksums", async () => {
	const tools = fakeTools();
	const release = { url: "https://example.com", assets: [] };
	const { impl } = fakeFetch({
		assets: { [tools.widget.url("2.0.0", "amd64")]: "body" },
	});
	await assert.rejects(
		bumpTool("widget", "2.0.0", release, { fetchImpl: impl, tools }),
		/no published checksum/,
	);
});

test("bumpTool rejects a download that doesn't match its published checksum", async () => {
	const tools = fakeTools();
	const body = "amd64-binary";
	const release = {
		url: "https://example.com",
		assets: [
			{ name: "checksums.txt", url: "https://example.com/checksums.txt" },
		],
	};
	const { impl } = fakeFetch({
		assets: {
			"https://example.com/checksums.txt": checksumsText([
				["0".repeat(64), "widget_linux_amd64"],
			]),
			[tools.widget.url("2.0.0", "amd64")]: body,
		},
	});
	await assert.rejects(
		bumpTool("widget", "2.0.0", release, { fetchImpl: impl, tools }),
		/the release checksums file gives .* but the pin is/,
	);
});

test("bumpTool verifies a signed tool's cosign signature too", async () => {
	const tools = fakeTools();
	const body = "gadget-binary";
	const url = (arch) => tools.gadget.url("2.0.0", arch);
	const { path: cosign, log } = fakeCosign(0);
	const release = {
		url: "https://example.com",
		assets: [
			{ name: "checksums.txt", url: "https://example.com/checksums.txt" },
		],
	};
	const { impl } = fakeFetch({
		assets: {
			"https://example.com/checksums.txt": checksumsText([
				[sha256(Buffer.from(body)), "gadget_linux_amd64"],
				[sha256(Buffer.from(body)), "gadget_linux_arm64"],
			]),
			[url("amd64")]: body,
			[url("arm64")]: body,
			[`${url("amd64")}.sig`]: "sig",
			[`${url("amd64")}.cert`]: "cert",
			[`${url("arm64")}.sig`]: "sig",
			[`${url("arm64")}.cert`]: "cert",
		},
	});
	const sha256s = await bumpTool("gadget", "2.0.0", release, {
		fetchImpl: impl,
		tools,
		cosign,
	});
	assert.equal(sha256s.amd64, sha256(Buffer.from(body)));
	assert.ok(existsSync(log));
	assert.match(readFileSync(log, "utf8"), /verify-blob/);
});

test("bumpTool rejects a failed cosign signature", async () => {
	const tools = fakeTools();
	const body = "gadget-binary";
	const url = (arch) => tools.gadget.url("2.0.0", arch);
	const { path: cosign } = fakeCosign(1);
	const release = {
		url: "https://example.com",
		assets: [
			{ name: "checksums.txt", url: "https://example.com/checksums.txt" },
		],
	};
	const { impl } = fakeFetch({
		assets: {
			"https://example.com/checksums.txt": checksumsText([
				[sha256(Buffer.from(body)), "gadget_linux_amd64"],
				[sha256(Buffer.from(body)), "gadget_linux_arm64"],
			]),
			[url("amd64")]: body,
			[url("arm64")]: body,
			[`${url("amd64")}.sig`]: "sig",
			[`${url("amd64")}.cert`]: "cert",
		},
	});
	await assert.rejects(
		bumpTool("gadget", "2.0.0", release, { fetchImpl: impl, tools, cosign }),
		/cosign signature verification failed/,
	);
});

test("bumpTool fetches a tool's declared checksums() URL directly instead of guessing from release assets", async () => {
	const tools = fakeTools();
	const amd64Body = "camera-amd64";
	const arm64Body = "camera-arm64";
	const url = (arch) => tools.camera.url("2.0.0", arch);
	const checksumsUrl = tools.camera.checksums("2.0.0");
	// The release lists no asset that looks like a checksums file; camera's
	// checksums() function is the only way to find it.
	const release = { url: "https://example.com", assets: [] };
	const { impl, requested } = fakeFetch({
		assets: {
			[checksumsUrl]: checksumsText([
				[sha256(Buffer.from(amd64Body)), "camera_linux_amd64"],
				[sha256(Buffer.from(arm64Body)), "camera_linux_arm64"],
			]),
			[url("amd64")]: amd64Body,
			[url("arm64")]: arm64Body,
		},
	});
	const sha256s = await bumpTool("camera", "2.0.0", release, {
		fetchImpl: impl,
		tools,
	});
	assert.equal(sha256s.amd64, sha256(Buffer.from(amd64Body)));
	assert.equal(sha256s.arm64, sha256(Buffer.from(arm64Body)));
	assert.ok(requested.includes(checksumsUrl));
});

// Trivy and Dockle are covered automatically through install-scanners.mjs's
// real TOOLS table: Trivy has both a checksums() URL and a version-anchored
// cosign bundle signer, Dockle only a checksums() URL. These use the real
// table (not fakeTools) to prove that coverage directly, per install-scanners'
// own url()/checksums() shapes for each.
test("bumpTool covers Trivy through the installer's table: checksums() plus a cosign bundle signature", async () => {
	const version = "0.75.0";
	const amd64Body = "trivy-amd64";
	const arm64Body = "trivy-arm64";
	const amd64Url = REAL_TOOLS.trivy.url(version, "amd64");
	const arm64Url = REAL_TOOLS.trivy.url(version, "arm64");
	const checksumsUrl = REAL_TOOLS.trivy.checksums(version);
	const { path: cosign, log } = fakeCosign(0);
	const { impl } = fakeFetch({
		assets: {
			[checksumsUrl]: checksumsText([
				[sha256(Buffer.from(amd64Body)), basename(amd64Url)],
				[sha256(Buffer.from(arm64Body)), basename(arm64Url)],
			]),
			[amd64Url]: amd64Body,
			[arm64Url]: arm64Body,
			[`${amd64Url}.sigstore.json`]: "{}",
			[`${arm64Url}.sigstore.json`]: "{}",
		},
	});
	const sha256s = await bumpTool(
		"trivy",
		version,
		{ url: "https://example.com", assets: [] },
		{ fetchImpl: impl, cosign },
	);
	assert.equal(sha256s.amd64, sha256(Buffer.from(amd64Body)));
	assert.equal(sha256s.arm64, sha256(Buffer.from(arm64Body)));
	const args = readFileSync(log, "utf8").trim().split("\n");
	assert.equal(args[0], "verify-blob");
	assert.ok(args.includes("--bundle"));
	assert.ok(
		args.some((a) => a.includes(version)),
		"the signer identity is anchored to this pinned version",
	);
});

test("bumpTool covers Dockle through the installer's table: checksums() only, no signature required", async () => {
	const version = "0.4.16";
	const amd64Body = "dockle-amd64";
	const arm64Body = "dockle-arm64";
	const amd64Url = REAL_TOOLS.dockle.url(version, "amd64");
	const arm64Url = REAL_TOOLS.dockle.url(version, "arm64");
	const checksumsUrl = REAL_TOOLS.dockle.checksums(version);
	assert.equal(REAL_TOOLS.dockle.signer, undefined);
	const { impl } = fakeFetch({
		assets: {
			[checksumsUrl]: checksumsText([
				[sha256(Buffer.from(amd64Body)), basename(amd64Url)],
				[sha256(Buffer.from(arm64Body)), basename(arm64Url)],
			]),
			[amd64Url]: amd64Body,
			[arm64Url]: arm64Body,
		},
	});
	const sha256s = await bumpTool(
		"dockle",
		version,
		{ url: "https://example.com", assets: [] },
		{ fetchImpl: impl },
	);
	assert.equal(sha256s.amd64, sha256(Buffer.from(amd64Body)));
	assert.equal(sha256s.arm64, sha256(Buffer.from(arm64Body)));
});

// --- bumpScanners: the end-to-end orchestration -----------------------------

function versionsFor(pins) {
	return `${JSON.stringify(pins, null, "\t")}\n`;
}

test("bumpScanners bumps only the tool that is behind, with correct hashes for both arches", async () => {
	const tools = widgetOnly();
	const oldBody = "old-widget";
	const newAmd64 = "new-widget-amd64";
	const newArm64 = "new-widget-arm64";
	const currentVersions = versionsFor({
		widget: {
			"1.0.0": {
				amd64: sha256(Buffer.from(oldBody)),
				arm64: sha256(Buffer.from(oldBody)),
			},
		},
	});
	const release = ghRelease("acme", "widget", "v1.1.0", ["checksums.txt"]);
	const { impl, requested } = fakeFetch({
		releases: { "acme/widget": release },
		assets: {
			[release.assets[0].browser_download_url]: checksumsText([
				[sha256(Buffer.from(newAmd64)), "widget_linux_amd64"],
				[sha256(Buffer.from(newArm64)), "widget_linux_arm64"],
			]),
			[tools.widget.url("1.1.0", "amd64")]: newAmd64,
			[tools.widget.url("1.1.0", "arm64")]: newArm64,
		},
	});
	const result = await bumpScanners(currentVersions, {
		fetchImpl: impl,
		tools,
	});
	assert.deepEqual(result.skips, []);
	assert.deepEqual(result.changes, [
		{
			tool: "widget",
			from: "1.0.0",
			to: "1.1.0",
			url: "https://github.com/acme/widget/releases/tag/v1.1.0",
		},
	]);
	const written = JSON.parse(result.versionsText);
	assert.deepEqual(Object.keys(written.widget), ["1.1.0"]);
	assert.equal(written.widget["1.1.0"].amd64, sha256(Buffer.from(newAmd64)));
	assert.equal(written.widget["1.1.0"].arm64, sha256(Buffer.from(newArm64)));
	assert.ok(
		requested.includes(
			"https://api.github.com/repos/acme/widget/releases/latest",
		),
	);
});

test("bumpScanners makes no change when every tool is already current", async () => {
	const tools = widgetOnly();
	const body = "widget";
	const currentVersions = versionsFor({
		widget: {
			"1.0.0": {
				amd64: sha256(Buffer.from(body)),
				arm64: sha256(Buffer.from(body)),
			},
		},
	});
	const { impl } = fakeFetch({
		releases: { "acme/widget": ghRelease("acme", "widget", "v1.0.0", []) },
	});
	const result = await bumpScanners(currentVersions, {
		fetchImpl: impl,
		tools,
	});
	assert.deepEqual(result.changes, []);
	assert.deepEqual(result.skips, []);
	assert.deepEqual(
		JSON.parse(result.versionsText),
		JSON.parse(currentVersions),
	);
});

test("bumpScanners skips a tool whose release can't be verified, with a warning reason, and leaves its pin untouched", async () => {
	const tools = widgetOnly();
	const body = "widget";
	const currentVersions = versionsFor({
		widget: {
			"1.0.0": {
				amd64: sha256(Buffer.from(body)),
				arm64: sha256(Buffer.from(body)),
			},
		},
	});
	const { impl } = fakeFetch({
		// The checksums asset is listed in the release but its download 404s,
		// so verification can't happen and the tool must be skipped.
		releases: {
			"acme/widget": ghRelease("acme", "widget", "v1.1.0", ["checksums.txt"]),
		},
	});
	const result = await bumpScanners(currentVersions, {
		fetchImpl: impl,
		tools,
	});
	assert.deepEqual(result.changes, []);
	assert.equal(result.skips.length, 1);
	assert.equal(result.skips[0].tool, "widget");
	assert.match(result.skips[0].reason, /download failed/);
	assert.deepEqual(
		JSON.parse(result.versionsText),
		JSON.parse(currentVersions),
	);
});

test("bumpScanners is data-driven: any tool table is covered without code changes", async () => {
	const tools = {
		newtool: {
			url: (v, arch) =>
				`https://github.com/acme/newtool/releases/download/v${v}/newtool_linux_${arch}`,
		},
	};
	const body = "newtool-binary";
	const currentVersions = versionsFor({});
	const release = ghRelease("acme", "newtool", "v0.1.0", ["checksums.txt"]);
	const { impl } = fakeFetch({
		releases: { "acme/newtool": release },
		assets: {
			[release.assets[0].browser_download_url]: checksumsText([
				[sha256(Buffer.from(body)), "newtool_linux_amd64"],
				[sha256(Buffer.from(body)), "newtool_linux_arm64"],
			]),
			[tools.newtool.url("0.1.0", "amd64")]: body,
			[tools.newtool.url("0.1.0", "arm64")]: body,
		},
	});
	const result = await bumpScanners(currentVersions, {
		fetchImpl: impl,
		tools,
	});
	assert.deepEqual(result.skips, []);
	assert.equal(result.changes.length, 1);
	assert.equal(result.changes[0].tool, "newtool");
	assert.equal(
		JSON.parse(result.versionsText).newtool["0.1.0"].amd64,
		sha256(Buffer.from(body)),
	);
});

test("prBody lists each bumped tool with a link to its release notes", () => {
	const body = prBody([
		{
			tool: "widget",
			from: "1.0.0",
			to: "1.1.0",
			url: "https://github.com/acme/widget/releases/tag/v1.1.0",
		},
	]);
	assert.match(body, /\| widget \| 1\.0\.0 \| 1\.1\.0 \|/);
	assert.match(
		body,
		/\[1\.1\.0\]\(https:\/\/github\.com\/acme\/widget\/releases\/tag\/v1\.1\.0\)/,
	);
});
