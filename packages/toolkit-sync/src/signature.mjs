import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The version of the first release with a Signed release tag. Release tags
 * below it are Legacy tags. It is fixed here, never read from the remote.
 */
export const FIRST_SIGNED_VERSION = "0.14.0";

/**
 * Every Legacy tag: each release tag below FIRST_SIGNED_VERSION, with the
 * commit it points at and its tag object (`null` for a lightweight tag). The
 * list is closed and fixed here, never read from the remote. A test checks it
 * against the repository's tags.
 */
export const LEGACY_TAGS = Object.freeze(
	[
		{
			name: "v0.1.0",
			commit: "a0ab1c4048221bc77d3f301de89d6933d432725f",
			tagObject: null,
		},
		{
			name: "v0.2.0",
			commit: "e8e29c444ccef0c67d4bfa4437825ab1f66ac63f",
			tagObject: null,
		},
		{
			name: "v0.3.0",
			commit: "42740923e601505c8f23f853de21eb3f9e609359",
			tagObject: "f0916d7e7b937c7160b8c01dd95193bd0d098ceb",
		},
		{
			name: "v0.3.1",
			commit: "a937df8ed7ae80eb6bac3bb60c5634cd056ce572",
			tagObject: "2ce1a179387d53adda801d5b3dab7261c47bcbbc",
		},
		{
			name: "v0.3.2",
			commit: "c44374e818524cd3cc6061bb82f5d926274bcd75",
			tagObject: "ce9b9d6b5f5b472bf6e3a9bdf661bbf9a8554935",
		},
		{
			name: "v0.3.3",
			commit: "2cc39b4521c4ea86e8c00bcb8dc66b95748062b8",
			tagObject: "aa6d714e451f6c7c606134fa6b46248228cfe86f",
		},
		{
			name: "v0.3.4",
			commit: "d9e1f620456930c4ff0587a66bab8d59a5db355a",
			tagObject: "0499da1569a4932f3baaa5934854693740e737f7",
		},
		{
			name: "v0.3.5",
			commit: "e43c4ffcf317f25e4b31c575e512903287c9842e",
			tagObject: "63581347464d60ddca468fb35b71d076c2b4db60",
		},
		{
			name: "v0.3.6",
			commit: "7249c388c945b3e7ec2ffcacdb960f58ca633d50",
			tagObject: "ac701038888473237a200a36a41ea12dcd968f34",
		},
		{
			name: "v0.3.7",
			commit: "1566c1958e93fa15a2a958128ac0b1b35bff6ae8",
			tagObject: "f7cdee35a9269f57f9fdf1cc3899a6c422fd1859",
		},
		{
			name: "v0.4.0",
			commit: "efc5667620781d9b18ad1b41c65406728c92a637",
			tagObject: "b562f2383fa7e48bfc937a9a832ea19b0a145e20",
		},
		{
			name: "v0.4.1",
			commit: "df45b1ca9d789df8b6ff84f4bf8bce01eee4e48b",
			tagObject: "0408cbbb02140148616ab08ed019d0b0265f1550",
		},
		{
			name: "v0.4.2",
			commit: "39e03ac10c3bcacde0e3f80a59f22b52adebf426",
			tagObject: "80fe195ae01f5107b3615bfe11454d5f40f55782",
		},
		{
			name: "v0.4.3",
			commit: "34fedc277b42999e876532feb8e5c2bf3abe8204",
			tagObject: "fbcb2f8c8a34b41105a5ef188ed016c94a96739f",
		},
		{
			name: "v0.4.4",
			commit: "9e686ef81ba754ac2e25af78190131889b3f8a0f",
			tagObject: "da9d68ab255568cd11c21bb382e5a9ba588de8b3",
		},
		{
			name: "v0.5.0",
			commit: "f74eb8d2c3e954448aa6f0d3283afcbdc5312ee7",
			tagObject: "9521f4253b93e8404ca5895513c98a04c9b981c1",
		},
		{
			name: "v0.5.1",
			commit: "27550216ee5780f92fa1246aa89be1502a4b9c74",
			tagObject: "c0e132e82905053540d3d9748a1019e3bc517517",
		},
		{
			name: "v0.5.2",
			commit: "f39ebdeae4e9d13c35fcbe9cc6a7e7d1a642faba",
			tagObject: "12d0d54265ce5ab2e635643b91c8523136a65a2b",
		},
		{
			name: "v0.6.0",
			commit: "3ed2ff46a8ec46e6fecb88c22fea3483fede53c2",
			tagObject: "a1726f6ea656228c4b53419d0d3f494f25f9e5e1",
		},
		{
			name: "v0.7.0",
			commit: "6207acf05766ac5af8b05323dc534c18eec376a9",
			tagObject: "f9744568d371521a4a2387f795975f948dbc1401",
		},
		{
			name: "v0.7.1",
			commit: "a533d01701c4e802ad687c9ffa1ee5b9432d6cd3",
			tagObject: "796f52f40fe5eded26b103451e2a2821fb5d6b1d",
		},
		{
			name: "v0.8.0",
			commit: "b88ef6c26d58b3013a8aeae2cfd3048ae0aca044",
			tagObject: "8762e96bcc9f7c38d7429679b006aa0b94feca81",
		},
		{
			name: "v0.9.0",
			commit: "c984ba1e9ac3a34f23d0ab27bf4bd4c4a26ad3d8",
			tagObject: "17376c2d786f9cc205af0f97f509ffd3f2c673e9",
		},
		{
			name: "v0.9.1",
			commit: "54e744d9dd3c9fefc70d95045b09c9bd1ccb5715",
			tagObject: "e92d517609ac0a8fb470f5d84bae77917bd5896b",
		},
		{
			name: "v0.10.0",
			commit: "5dbd56104da7b3bd6df6b86f7505bbef6feec83e",
			tagObject: "d94db987548b9ffea16a55a517ad9d1c0843613e",
		},
		{
			name: "v0.10.1",
			commit: "9e03287190ccfd12556f4a7af79c1f59aa5b2a66",
			tagObject: "299ee324c4d85c7570711fe49c17fc8f0effac0e",
		},
		{
			name: "v0.10.2",
			commit: "a5edbd8ddf3ea809c71d8392b23f40aa009ccb8b",
			tagObject: "89e0871a52bcd22038e98ce36fb1a62a245d1fe6",
		},
		{
			name: "v0.11.0",
			commit: "e586d0a7f6e32693ed7fa106619d5a1cf12c1e0e",
			tagObject: "0232be128b408cf118ba9eccb18ca05cd3144e9b",
		},
		{
			name: "v0.11.1",
			commit: "5b8372874cc62d00c81701cf05b084183ca8b8ec",
			tagObject: "480721fa5b5da26e769bdb5b6d8984d5b90ca0cf",
		},
		{
			name: "v0.11.2",
			commit: "8ec52236bd174bc2107a91974965f86b102a0a65",
			tagObject: "4c42e4443288432670a3cb86b96bd2a67b571903",
		},
		{
			name: "v0.12.0",
			commit: "9732ee9fbfca7a327fd73d067ce6234444defaa6",
			tagObject: "64c3b90505fa657b0ee3cf8a9313aae88d3d0264",
		},
		{
			name: "v0.13.0",
			commit: "187f049c628a8b269625787d7ed280167e26ae40",
			tagObject: "45cc84adc2d4941ecdab2e864fd00610f004fce2",
		},
	].map((entry) => Object.freeze(entry)),
);

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

/** Whether `tag` is a `vX.Y.Z` release tag below FIRST_SIGNED_VERSION. */
function predatesSigning(tag) {
	const match = /^v(\d+\.\d+\.\d+)$/.exec(tag);
	return match !== null && compareVersions(match[1], FIRST_SIGNED_VERSION) < 0;
}

/** Whether `tag` names a Legacy tag in LEGACY_TAGS. */
export function isLegacyTag(tag) {
	return LEGACY_TAGS.some((entry) => entry.name === tag);
}

function git(cacheDir, args) {
	return spawnSync("git", ["--git-dir", cacheDir, ...args], {
		encoding: "utf8",
	});
}

const indent = (text) => text.replace(/^/gm, "  ");

/** The commit and tag object (`null` if lightweight) of the fetched `ref`. */
function fetchedRef(cacheDir, ref) {
	const resolve = (rev) =>
		git(cacheDir, ["rev-parse", "--verify", "-q", rev]).stdout.trim() || null;
	const lightweight =
		git(cacheDir, ["cat-file", "-t", ref]).stdout.trim() === "commit";
	return {
		commit: resolve(`${ref}^{commit}`),
		tagObject: lightweight ? null : resolve(ref),
	};
}

const describeRef = ({ commit, tagObject }) =>
	`commit ${commit ?? "none"}, tag object ${tagObject ?? "none"}`;

/**
 * Throw unless `tag` was fetched exactly as its LEGACY_TAGS entry records it:
 * a Legacy tag name on any other commit or tag object isn't a Legacy tag.
 */
function checkLegacyTag(cacheDir, tag) {
	const unknown = (reason) =>
		new Error(`tag "${tag}" is not a known Legacy tag: ${reason}`);
	const entry = LEGACY_TAGS.find((legacy) => legacy.name === tag);
	if (!entry)
		throw unknown(
			`it is below v${FIRST_SIGNED_VERSION}, but toolkit-sync's fixed list of Legacy tags doesn't include it`,
		);
	const actual = fetchedRef(cacheDir, `refs/tags/${tag}`);
	if (actual.commit !== entry.commit || actual.tagObject !== entry.tagObject)
		throw unknown(
			`the fetched tag (${describeRef(actual)}) doesn't match toolkit-sync's fixed list of Legacy tags (${describeRef(entry)})`,
		);
}

/**
 * Verify the tag object for `tag` already fetched into `cacheDir`.
 *
 * Returns `{ signer }`, the Trust anchor principal that signed it, for a
 * Signed release tag. A Legacy tag is refused unless `allowUnsigned` is set,
 * in which case it `warn`s and returns `{ legacy: true }`. A tag below
 * FIRST_SIGNED_VERSION that doesn't match its LEGACY_TAGS entry exactly is
 * always refused, and `allowUnsigned` never applies to a tag at or above
 * FIRST_SIGNED_VERSION. Anything else throws: a missing Trust anchor, no
 * signature, or an untrusted one.
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
	if (predatesSigning(tag)) {
		checkLegacyTag(cacheDir, tag);
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
