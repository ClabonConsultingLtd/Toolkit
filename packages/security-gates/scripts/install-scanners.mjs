// Installs pinned scanner release binaries after checking each download's
// SHA-256 against scanner-versions.json. Where a release publishes a checksums
// file (Trivy, Dockle), the pin must also match it. Opengrep's and Trivy's
// signatures are checked with cosign, which this script installs the same way
// first.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";

export const DEFAULT_VERSIONS_PATH = new URL(
	"../scanner-versions.json",
	import.meta.url,
).pathname;
export const ARCHES = ["amd64", "arm64"];

const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";

const OPENGREP_SIGNER = {
	identityRegexp:
		"^https://github\\.com/opengrep/opengrep/\\.github/workflows/[^@]+@refs/(heads|tags)/.+$",
	oidcIssuer: GITHUB_OIDC_ISSUER,
};

// Trivy signs each asset with a Sigstore bundle from its release workflow.
// The identity is anchored to the pinned version's tag.
const trivySigner = (v) => ({
	identityRegexp: `^https://github\\.com/aquasecurity/trivy/\\.github/workflows/[^@]+@refs/tags/v${v.replaceAll(".", "\\.")}$`,
	oidcIssuer: GITHUB_OIDC_ISSUER,
	bundle: true,
});

// Where each tool's release asset lives, and how to turn it into a binary.
// signer gives the cosign identity for a version; checksums, the release's
// checksums file.
export const TOOLS = {
	cosign: {
		url: (v, arch) =>
			`https://github.com/sigstore/cosign/releases/download/v${v}/cosign-linux-${arch}`,
	},
	gitleaks: {
		url: (v, arch) =>
			`https://github.com/gitleaks/gitleaks/releases/download/v${v}/gitleaks_${v}_linux_${arch === "amd64" ? "x64" : "arm64"}.tar.gz`,
		tarMember: "gitleaks",
	},
	"osv-scanner": {
		url: (v, arch) =>
			`https://github.com/google/osv-scanner/releases/download/v${v}/osv-scanner_linux_${arch}`,
	},
	opengrep: {
		url: (v, arch) =>
			`https://github.com/opengrep/opengrep/releases/download/v${v}/opengrep_manylinux_${arch === "amd64" ? "x86" : "aarch64"}`,
		signer: () => OPENGREP_SIGNER,
	},
	trivy: {
		url: (v, arch) =>
			`https://github.com/aquasecurity/trivy/releases/download/v${v}/trivy_${v}_Linux-${arch === "amd64" ? "64bit" : "ARM64"}.tar.gz`,
		tarMember: "trivy",
		checksums: (v) =>
			`https://github.com/aquasecurity/trivy/releases/download/v${v}/trivy_${v}_checksums.txt`,
		signer: trivySigner,
	},
	dockle: {
		url: (v, arch) =>
			`https://github.com/goodwithtech/dockle/releases/download/v${v}/dockle_${v}_Linux-${arch === "amd64" ? "64bit" : "ARM64"}.tar.gz`,
		tarMember: "dockle",
		checksums: (v) =>
			`https://github.com/goodwithtech/dockle/releases/download/v${v}/dockle_${v}_checksums.txt`,
	},
};

// Checks the versions file shape: tool → version → { arch → sha256 }, with
// exactly one version per tool and a hash for every supported architecture.
export function parseVersions(text, tools = TOOLS) {
	const data = JSON.parse(text);
	const pins = {};
	for (const [tool, versions] of Object.entries(data)) {
		if (!tools[tool]) throw new Error(`versions file: unknown tool "${tool}"`);
		const entries = Object.entries(versions ?? {});
		if (entries.length !== 1)
			throw new Error(`versions file: ${tool} must have exactly one version`);
		const [version, hashes] = entries[0];
		if (!/^\d+\.\d+\.\d+$/.test(version))
			throw new Error(
				`versions file: ${tool} version "${version}" is not X.Y.Z`,
			);
		for (const arch of ARCHES) {
			if (!/^[0-9a-f]{64}$/.test(hashes?.[arch] ?? "")) {
				throw new Error(
					`versions file: ${tool} ${version} has no valid sha256 for ${arch}`,
				);
			}
		}
		pins[tool] = { version, sha256: hashes };
	}
	return pins;
}

export function runnerArch(
	nodeArch = process.arch,
	platform = process.platform,
) {
	if (platform !== "linux")
		throw new Error(
			`unsupported platform ${platform}: security-gates runs on Linux runners`,
		);
	const arch = { x64: "amd64", arm64: "arm64" }[nodeArch];
	if (!arch)
		throw new Error(
			`unsupported architecture ${nodeArch}: use a linux/amd64 or linux/arm64 runner`,
		);
	return arch;
}

export function sha256(buffer) {
	return createHash("sha256").update(buffer).digest("hex");
}

export function verifyDigest(tool, buffer, expected) {
	const actual = sha256(buffer);
	if (actual !== expected) {
		throw new Error(
			`${tool}: SHA-256 mismatch, expected ${expected} but downloaded ${actual}`,
		);
	}
}

// Checks that a release's checksums file ("<sha256>  <asset>" per line)
// lists the asset with the pinned hash.
export function verifyReleaseChecksum(tool, checksumsText, asset, expected) {
	const listed = checksumsText
		.split(/\r?\n/)
		.map((line) => line.trim().split(/\s+\*?/))
		.find(([, name]) => name === asset)?.[0];
	if (!listed)
		throw new Error(
			`${tool}: the release checksums file doesn't list ${asset}`,
		);
	if (listed.toLowerCase() !== expected) {
		throw new Error(
			`${tool}: the release checksums file gives ${listed} for ${asset}, but the pin is ${expected}`,
		);
	}
}

export async function download(url, fetchImpl) {
	const response = await fetchImpl(url);
	if (!response.ok)
		throw new Error(`download failed: ${url} returned HTTP ${response.status}`);
	return Buffer.from(await response.arrayBuffer());
}

function run(command, args) {
	const result = spawnSync(command, args, { encoding: "utf8" });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args[0]} failed (exit ${result.status}):\n${result.stderr}${result.stdout}`,
		);
	}
}

export async function verifySignature(
	tool,
	assetPath,
	url,
	signer,
	{ cosign, fetchImpl },
) {
	let material;
	if (signer.bundle) {
		writeFileSync(
			`${assetPath}.sigstore.json`,
			await download(`${url}.sigstore.json`, fetchImpl),
		);
		material = ["--bundle", `${assetPath}.sigstore.json`];
	} else {
		const [signature, certificate] = await Promise.all([
			download(`${url}.sig`, fetchImpl),
			download(`${url}.cert`, fetchImpl),
		]);
		writeFileSync(`${assetPath}.sig`, signature);
		writeFileSync(`${assetPath}.cert`, certificate);
		material = [
			"--certificate",
			`${assetPath}.cert`,
			"--signature",
			`${assetPath}.sig`,
		];
	}
	try {
		run(cosign, [
			"verify-blob",
			...material,
			"--certificate-identity-regexp",
			signer.identityRegexp,
			"--certificate-oidc-issuer",
			signer.oidcIssuer,
			assetPath,
		]);
	} catch (error) {
		throw new Error(
			`${tool}: cosign signature verification failed\n${error.message}`,
		);
	}
}

// Downloads, verifies and installs one tool into dest. Nothing is written to
// dest until the digest, and the release checksums file and signature where
// there are any, have been checked.
export async function installTool(
	tool,
	pin,
	{ arch, dest, fetchImpl = fetch, cosign = join(dest, "cosign") },
) {
	const spec = TOOLS[tool];
	const url = spec.url(pin.version, arch);
	const payload = await download(url, fetchImpl);
	verifyDigest(tool, payload, pin.sha256[arch]);
	if (spec.checksums) {
		const checksums = await download(spec.checksums(pin.version), fetchImpl);
		verifyReleaseChecksum(
			tool,
			checksums.toString("utf8"),
			basename(url),
			pin.sha256[arch],
		);
	}

	const workDir = mkdtempSync(join(tmpdir(), `security-gates-${tool}-`));
	try {
		const asset = join(workDir, basename(url));
		writeFileSync(asset, payload);
		if (spec.signer)
			await verifySignature(tool, asset, url, spec.signer(pin.version), {
				cosign,
				fetchImpl,
			});
		let binary = payload;
		if (spec.tarMember) {
			const unpacked = join(workDir, "unpacked");
			mkdirSync(unpacked);
			run("tar", ["-xzf", asset, "-C", unpacked, spec.tarMember]);
			binary = readFileSync(join(unpacked, spec.tarMember));
		}

		mkdirSync(dest, { recursive: true });
		const target = join(dest, tool);
		writeFileSync(target, binary);
		chmodSync(target, 0o755);
		return { tool, version: pin.version, path: target };
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}
}

// Installs the requested tools, adding cosign first when a tool needs a
// signature check.
export async function installScanners(
	tools,
	{ versionsText, arch, dest, fetchImpl = fetch },
) {
	const pins = parseVersions(versionsText);
	const order = [
		...new Set([
			...(tools.some((t) => TOOLS[t]?.signer) ? ["cosign"] : []),
			...tools,
		]),
	];
	const installed = [];
	for (const tool of order) {
		if (!TOOLS[tool])
			throw new Error(
				`unknown tool "${tool}"; choose from ${Object.keys(TOOLS).join(", ")}`,
			);
		if (!pins[tool]) throw new Error(`versions file has no pin for ${tool}`);
		installed.push(
			await installTool(tool, pins[tool], { arch, dest, fetchImpl }),
		);
	}
	return installed;
}

const USAGE = `usage: install-scanners.mjs --dest <dir> [--versions <file>] <tool>...

tools: ${Object.keys(TOOLS).join(", ")}`;

async function main() {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			dest: { type: "string" },
			versions: { type: "string" },
			help: { type: "boolean", short: "h" },
		},
	});
	if (values.help || !values.dest || positionals.length === 0) {
		console.log(USAGE);
		process.exit(values.help ? 0 : 2);
	}
	try {
		const installed = await installScanners(positionals, {
			versionsText: readFileSync(
				values.versions ?? DEFAULT_VERSIONS_PATH,
				"utf8",
			),
			arch: runnerArch(),
			dest: values.dest,
		});
		for (const { tool, version, path } of installed)
			console.log(`installed ${tool} ${version} at ${path} (verified)`);
	} catch (error) {
		console.error(`::error::${error.message.replaceAll("\n", "%0A")}`);
		process.exit(1);
	}
}

if (process.argv[1] === import.meta.filename) await main();
