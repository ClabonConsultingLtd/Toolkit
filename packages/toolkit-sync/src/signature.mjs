import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The version of the first release with a Signed release tag. Release tags
 * below it are Legacy tags. It is fixed here, never read from the remote.
 */
export const FIRST_SIGNED_VERSION = "0.14.0";

/** The Trust anchor, vendored with toolkit-sync beside its `src/` directory. */
export const TRUST_ANCHOR_PATH = fileURLToPath(
	new URL("../allowed_signers", import.meta.url),
);

function parseVersion(version) {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	if (!match) throw new Error(`invalid version: ${version}`);
	return match.slice(1).map(Number);
}

/** Compare two `X.Y.Z` versions: negative, zero or positive. */
export function compareVersions(a, b) {
	const left = parseVersion(a);
	const right = parseVersion(b);
	for (let i = 0; i < 3; i++)
		if (left[i] !== right[i]) return left[i] - right[i];
	return 0;
}

/** Whether `tag` is a `vX.Y.Z` release tag from before release tags were signed. */
export function isLegacyTag(tag) {
	const match = /^v(\d+\.\d+\.\d+)$/.exec(tag);
	return match !== null && compareVersions(match[1], FIRST_SIGNED_VERSION) < 0;
}

function git(cacheDir, args) {
	return spawnSync("git", ["--git-dir", cacheDir, ...args], {
		encoding: "utf8",
	});
}

const indent = (text) => text.replace(/^/gm, "  ");

/**
 * Verify the tag object for `tag` already fetched into `cacheDir`.
 *
 * Returns `{ signer }`, the Trust anchor principal that signed it, for a
 * Signed release tag. A Legacy tag is refused unless `allowUnsigned` is set,
 * in which case it `warn`s and returns `{ legacy: true }`. `allowUnsigned`
 * never applies to a tag at or above FIRST_SIGNED_VERSION. Anything else
 * throws: a missing Trust anchor, no signature, or an untrusted one.
 */
export function verifyReleaseTag(
	cacheDir,
	tag,
	{
		anchorPath = TRUST_ANCHOR_PATH,
		allowUnsigned = false,
		warn = (message) => console.error(message),
	} = {},
) {
	if (isLegacyTag(tag)) {
		if (!allowUnsigned)
			throw new Error(
				`tag "${tag}" is a Legacy tag from before release tags were signed (v${FIRST_SIGNED_VERSION}); pass --allow-unsigned to accept it without verification`,
			);
		warn(
			`warning: accepting Legacy tag "${tag}" without a signature because of --allow-unsigned`,
		);
		return { legacy: true };
	}
	const refusal = (reason, details = "") => {
		const note = allowUnsigned
			? ` (--allow-unsigned only applies to Legacy tags below v${FIRST_SIGNED_VERSION})`
			: "";
		return new Error(
			`tag "${tag}" is not a Signed release tag: ${reason}${note}${details && `\n${indent(details)}`}`,
		);
	};
	if (!existsSync(anchorPath))
		throw new Error(
			`no Trust anchor at ${anchorPath}; vendor the whole toolkit-sync package, including allowed_signers`,
		);
	const ref = `refs/tags/${tag}`;
	if (git(cacheDir, ["cat-file", "-t", ref]).stdout.trim() !== "tag")
		throw refusal("it has no signature (a lightweight tag)");
	const name = /^tag (.*)$/m.exec(
		git(cacheDir, ["cat-file", "tag", ref]).stdout,
	)?.[1];
	if (name !== tag)
		throw refusal(`the tag object is named "${name}", so it was re-published`);
	const result = git(cacheDir, [
		"-c",
		"gpg.format=ssh",
		"-c",
		`gpg.ssh.allowedSignersFile=${anchorPath}`,
		"verify-tag",
		"--raw",
		ref,
	]);
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
	// git prints "Good ... signature" even for a key the anchor doesn't hold,
	// so success needs both a zero exit and a named principal.
	const signer = /^Good "git" signature for (\S+) with /m.exec(output)?.[1];
	if (result.status === 0 && signer) return { signer };
	if (/no signature found/.test(output)) throw refusal("it has no signature");
	throw refusal(
		`its signature does not verify against the Trust anchor at ${anchorPath}`,
		output,
	);
}
