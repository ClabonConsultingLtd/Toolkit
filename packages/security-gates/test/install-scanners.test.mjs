import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	DEFAULT_VERSIONS_PATH,
	installScanners,
	parseVersions,
	runnerArch,
	sha256,
	TOOLS,
	verifyReleaseChecksum,
} from "../scripts/install-scanners.mjs";

const tempDir = () => mkdtempSync(join(tmpdir(), "security-gates-test-"));

function fakeFetch(assets) {
	const requested = [];
	const impl = async (url) => {
		requested.push(url);
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

function versionsFor(bodies, version = "1.2.3") {
	const data = {};
	for (const [tool, body] of Object.entries(bodies)) {
		data[tool] = {
			[version]: { amd64: sha256(Buffer.from(body)), arm64: "0".repeat(64) },
		};
	}
	return JSON.stringify(data);
}

test("the committed versions file pins every tool on both architectures", () => {
	const pins = parseVersions(readFileSync(DEFAULT_VERSIONS_PATH, "utf8"));
	assert.deepEqual(Object.keys(pins).sort(), Object.keys(TOOLS).sort());
	for (const pin of Object.values(pins)) {
		assert.match(pin.version, /^\d+\.\d+\.\d+$/);
		assert.match(pin.sha256.amd64, /^[0-9a-f]{64}$/);
		assert.match(pin.sha256.arm64, /^[0-9a-f]{64}$/);
	}
});

test("parseVersions rejects files that don't follow tool → version → { arch → sha256 }", () => {
	const hashes = { amd64: "a".repeat(64), arm64: "b".repeat(64) };
	assert.throws(
		() => parseVersions(JSON.stringify({ grype: { "1.0.0": hashes } })),
		/unknown tool "grype"/,
	);
	assert.throws(
		() =>
			parseVersions(
				JSON.stringify({ gitleaks: { "1.0.0": hashes, "1.0.1": hashes } }),
			),
		/exactly one version/,
	);
	assert.throws(
		() => parseVersions(JSON.stringify({ gitleaks: { latest: hashes } })),
		/is not X.Y.Z/,
	);
	assert.throws(
		() =>
			parseVersions(
				JSON.stringify({ gitleaks: { "1.0.0": { amd64: hashes.amd64 } } }),
			),
		/no valid sha256 for arm64/,
	);
	assert.throws(
		() =>
			parseVersions(
				JSON.stringify({ gitleaks: { "1.0.0": { ...hashes, amd64: "XYZ" } } }),
			),
		/no valid sha256 for amd64/,
	);
});

test("runnerArch maps Node's architecture names and refuses anything else", () => {
	assert.equal(runnerArch("x64", "linux"), "amd64");
	assert.equal(runnerArch("arm64", "linux"), "arm64");
	assert.throws(() => runnerArch("ia32", "linux"), /unsupported architecture/);
	assert.throws(() => runnerArch("x64", "darwin"), /unsupported platform/);
});

test("installScanners installs a binary whose SHA-256 matches its pin", async () => {
	const body = "#!/bin/sh\necho osv\n";
	const url = TOOLS["osv-scanner"].url("1.2.3", "amd64");
	const dest = tempDir();
	const { impl } = fakeFetch({ [url]: body });
	const [installed] = await installScanners(["osv-scanner"], {
		versionsText: versionsFor({ "osv-scanner": body }),
		arch: "amd64",
		dest,
		fetchImpl: impl,
	});
	assert.equal(installed.path, join(dest, "osv-scanner"));
	assert.equal(readFileSync(installed.path, "utf8"), body);
	assert.equal(spawnSync(installed.path, { encoding: "utf8" }).stdout, "osv\n");
});

test("changing a hash in the versions file fails the install and writes nothing", async () => {
	const body = "#!/bin/sh\necho osv\n";
	const url = TOOLS["osv-scanner"].url("1.2.3", "amd64");
	const versions = JSON.parse(versionsFor({ "osv-scanner": body }));
	const pinned = versions["osv-scanner"]["1.2.3"].amd64;
	versions["osv-scanner"]["1.2.3"].amd64 =
		`${pinned[0] === "0" ? "1" : "0"}${pinned.slice(1)}`;
	const dest = tempDir();
	await assert.rejects(
		installScanners(["osv-scanner"], {
			versionsText: JSON.stringify(versions),
			arch: "amd64",
			dest,
			fetchImpl: fakeFetch({ [url]: body }).impl,
		}),
		/osv-scanner: SHA-256 mismatch/,
	);
	assert.equal(existsSync(join(dest, "osv-scanner")), false);
});

test("installScanners extracts Gitleaks from its verified tarball", async () => {
	const work = tempDir();
	writeFileSync(join(work, "gitleaks"), "#!/bin/sh\necho gitleaks\n");
	writeFileSync(join(work, "README.md"), "not installed\n");
	assert.equal(
		spawnSync("tar", ["-czf", "asset.tar.gz", "gitleaks", "README.md"], {
			cwd: work,
		}).status,
		0,
	);
	const tarball = readFileSync(join(work, "asset.tar.gz"));
	const url = TOOLS.gitleaks.url("1.2.3", "amd64");
	assert.match(url, /gitleaks_1\.2\.3_linux_x64\.tar\.gz$/);
	const dest = tempDir();
	await installScanners(["gitleaks"], {
		versionsText: versionsFor({ gitleaks: tarball }),
		arch: "amd64",
		dest,
		fetchImpl: fakeFetch({ [url]: tarball }).impl,
	});
	assert.equal(
		readFileSync(join(dest, "gitleaks"), "utf8"),
		"#!/bin/sh\necho gitleaks\n",
	);
	assert.equal(existsSync(join(dest, "README.md")), false);
});

// A stand-in cosign records its arguments and exits with the given status.
function opengrepAssets(cosignStatus) {
	const log = join(tempDir(), "cosign-args");
	const cosign = `#!/bin/sh\nprintf '%s\\n' "$@" > ${log}\nexit ${cosignStatus}\n`;
	const opengrep = "#!/bin/sh\necho opengrep\n";
	const opengrepUrl = TOOLS.opengrep.url("1.2.3", "amd64");
	return {
		log,
		versionsText: versionsFor({ cosign, opengrep }),
		assets: {
			[TOOLS.cosign.url("1.2.3", "amd64")]: cosign,
			[opengrepUrl]: opengrep,
			[`${opengrepUrl}.sig`]: "signature",
			[`${opengrepUrl}.cert`]: "certificate",
		},
	};
}

test("Opengrep is installed after cosign verifies its signature", async () => {
	const { log, versionsText, assets } = opengrepAssets(0);
	const dest = tempDir();
	const { impl, requested } = fakeFetch(assets);
	const installed = await installScanners(["opengrep"], {
		versionsText,
		arch: "amd64",
		dest,
		fetchImpl: impl,
	});
	assert.deepEqual(
		installed.map((i) => i.tool),
		["cosign", "opengrep"],
	);
	assert.equal(requested[0], TOOLS.cosign.url("1.2.3", "amd64"));
	const args = readFileSync(log, "utf8").trim().split("\n");
	assert.equal(args[0], "verify-blob");
	assert.ok(args.includes("--certificate-oidc-issuer"));
	assert.ok(args.includes("https://token.actions.githubusercontent.com"));
	assert.ok(existsSync(join(dest, "opengrep")));
});

test("a failed signature check stops the Opengrep install", async () => {
	const { versionsText, assets } = opengrepAssets(1);
	const dest = tempDir();
	await assert.rejects(
		installScanners(["opengrep"], {
			versionsText,
			arch: "amd64",
			dest,
			fetchImpl: fakeFetch(assets).impl,
		}),
		/opengrep: cosign signature verification failed/,
	);
	assert.equal(existsSync(join(dest, "opengrep")), false);
});

function tarball(member, body) {
	const work = tempDir();
	writeFileSync(join(work, member), body);
	assert.equal(
		spawnSync("tar", ["-czf", "asset.tar.gz", member], { cwd: work }).status,
		0,
	);
	return readFileSync(join(work, "asset.tar.gz"));
}

// Trivy's assets, with a checksums file listing the given hash for the
// amd64 tarball, and a stand-in cosign like opengrepAssets'.
function trivyAssets({ cosignStatus = 0, listedHash } = {}) {
	const log = join(tempDir(), "cosign-args");
	const cosign = `#!/bin/sh\nprintf '%s\\n' "$@" > ${log}\nexit ${cosignStatus}\n`;
	const trivy = tarball("trivy", "#!/bin/sh\necho trivy\n");
	const url = TOOLS.trivy.url("1.2.3", "amd64");
	const hash = listedHash ?? sha256(trivy);
	return {
		log,
		versionsText: versionsFor({ cosign, trivy }),
		assets: {
			[TOOLS.cosign.url("1.2.3", "amd64")]: cosign,
			[url]: trivy,
			[`${url}.sigstore.json`]: "{}",
			[TOOLS.trivy.checksums("1.2.3")]:
				`${"f".repeat(64)}  trivy_1.2.3_Linux-ARM64.tar.gz\n${hash}  trivy_1.2.3_Linux-64bit.tar.gz\n`,
		},
	};
}

test("Trivy is installed after its release checksum and signature bundle are verified", async () => {
	const { log, versionsText, assets } = trivyAssets();
	const dest = tempDir();
	const { impl, requested } = fakeFetch(assets);
	await installScanners(["trivy"], {
		versionsText,
		arch: "amd64",
		dest,
		fetchImpl: impl,
	});
	assert.ok(requested.includes(TOOLS.trivy.checksums("1.2.3")));
	const args = readFileSync(log, "utf8").trim().split("\n");
	assert.equal(args[0], "verify-blob");
	assert.equal(
		args[args.indexOf("--bundle") + 1].endsWith(".sigstore.json"),
		true,
	);
	assert.equal(
		args[args.indexOf("--certificate-identity-regexp") + 1],
		"^https://github\\.com/aquasecurity/trivy/\\.github/workflows/[^@]+@refs/tags/v1\\.2\\.3$",
	);
	assert.equal(
		readFileSync(join(dest, "trivy"), "utf8"),
		"#!/bin/sh\necho trivy\n",
	);
});

test("a pin that differs from the release checksums file fails the install", async () => {
	const { versionsText, assets } = trivyAssets({ listedHash: "e".repeat(64) });
	const dest = tempDir();
	await assert.rejects(
		installScanners(["trivy"], {
			versionsText,
			arch: "amd64",
			dest,
			fetchImpl: fakeFetch(assets).impl,
		}),
		/trivy: the release checksums file gives e{64} for trivy_1\.2\.3_Linux-64bit\.tar\.gz/,
	);
	assert.equal(existsSync(join(dest, "trivy")), false);
});

test("a failed signature check stops the Trivy install", async () => {
	const { versionsText, assets } = trivyAssets({ cosignStatus: 1 });
	const dest = tempDir();
	await assert.rejects(
		installScanners(["trivy"], {
			versionsText,
			arch: "amd64",
			dest,
			fetchImpl: fakeFetch(assets).impl,
		}),
		/trivy: cosign signature verification failed/,
	);
	assert.equal(existsSync(join(dest, "trivy")), false);
});

test("Dockle is checked against its release checksums file, without cosign", async () => {
	const dockle = tarball("dockle", "#!/bin/sh\necho dockle\n");
	const url = TOOLS.dockle.url("1.2.3", "arm64");
	assert.match(url, /dockle_1\.2\.3_Linux-ARM64\.tar\.gz$/);
	const versionsText = JSON.stringify({
		dockle: { "1.2.3": { amd64: "0".repeat(64), arm64: sha256(dockle) } },
	});
	const dest = tempDir();
	const { impl, requested } = fakeFetch({
		[url]: dockle,
		[TOOLS.dockle.checksums("1.2.3")]:
			`${sha256(dockle)}  dockle_1.2.3_Linux-ARM64.tar.gz\n`,
	});
	const installed = await installScanners(["dockle"], {
		versionsText,
		arch: "arm64",
		dest,
		fetchImpl: impl,
	});
	assert.deepEqual(
		installed.map((i) => i.tool),
		["dockle"],
	);
	assert.equal(requested.length, 2);
	assert.equal(
		readFileSync(join(dest, "dockle"), "utf8"),
		"#!/bin/sh\necho dockle\n",
	);
});

test("verifyReleaseChecksum fails when the checksums file doesn't list the asset", () => {
	assert.throws(
		() =>
			verifyReleaseChecksum(
				"dockle",
				`${"a".repeat(64)}  dockle_1.2.3_Linux-64bit.tar.gz\n`,
				"dockle_1.2.3_Linux-ARM64.tar.gz",
				"a".repeat(64),
			),
		/dockle: the release checksums file doesn't list dockle_1\.2\.3_Linux-ARM64\.tar\.gz/,
	);
	verifyReleaseChecksum(
		"dockle",
		`${"A".repeat(64)} *dockle_1.2.3_Linux-ARM64.tar.gz\n`,
		"dockle_1.2.3_Linux-ARM64.tar.gz",
		"a".repeat(64),
	);
});

test("the CLI reports a bad versions file as an error annotation", () => {
	const dir = tempDir();
	const versions = JSON.parse(readFileSync(DEFAULT_VERSIONS_PATH, "utf8"));
	const [version] = Object.keys(versions.gitleaks);
	versions.gitleaks[version].amd64 = "not-a-hash";
	writeFileSync(join(dir, "versions.json"), JSON.stringify(versions));
	const result = spawnSync(
		process.execPath,
		[
			new URL("../scripts/install-scanners.mjs", import.meta.url).pathname,
			"--versions",
			join(dir, "versions.json"),
			"--dest",
			join(dir, "bin"),
			"gitleaks",
		],
		{ encoding: "utf8" },
	);
	assert.equal(result.status, 1);
	assert.match(
		result.stderr,
		/::error::versions file: gitleaks .* no valid sha256 for amd64/,
	);
	assert.equal(existsSync(join(dir, "bin", "gitleaks")), false);
});
