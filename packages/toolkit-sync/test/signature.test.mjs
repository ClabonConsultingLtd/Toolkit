import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fetchPinnedTag } from "../src/git.mjs";
import {
	compareVersions,
	FIRST_SIGNED_VERSION,
	isLegacyTag,
	LEGACY_TAGS,
	TRUST_ANCHOR_PATH,
	verifyReleaseTag,
} from "../src/signature.mjs";
import {
	allowedSignersLine,
	copyLegacyTag,
	createFixtureRepo,
	createSigningKey,
	mkTempDir,
	testSigningKey,
	toolkitRepo,
} from "../test-helpers/fixture-repo.mjs";

const packageDir = new URL("../", import.meta.url);

function writeAnchor(content) {
	const path = join(mkTempDir(), "allowed_signers");
	writeFileSync(path, content);
	return path;
}

/** Fetch `tag` from a fixture repo into a fresh cache, as `pin` does. */
function fetched(fixture) {
	const cacheDir = join(mkTempDir(), "cache");
	fetchPinnedTag(cacheDir, fixture.repoUrl, fixture.tag);
	return cacheDir;
}

const trusted = () => writeAnchor(allowedSignersLine(testSigningKey()));

test("FIRST_SIGNED_VERSION is set to the release that ships tag signing", () => {
	assert.match(
		String(FIRST_SIGNED_VERSION),
		/^\d+\.\d+\.\d+$/,
		"set FIRST_SIGNED_VERSION to the version of the release that ships signing",
	);
	// v0.13.x are the last Legacy tags, so signing can't start below 0.14.0.
	assert.ok(compareVersions(FIRST_SIGNED_VERSION, "0.14.0") >= 0);
	// Until that release happens, the constant must be exactly one release
	// ahead of this package's version, so the release PR must be that version.
	const { version } = JSON.parse(
		readFileSync(new URL("package.json", packageDir), "utf8"),
	);
	if (compareVersions(version, FIRST_SIGNED_VERSION) < 0) {
		const [major, minor, patch] = version.split(".").map(Number);
		const next = [
			`${major}.${minor}.${patch + 1}`,
			`${major}.${minor + 1}.0`,
			`${major + 1}.0.0`,
		];
		assert.ok(
			next.includes(FIRST_SIGNED_VERSION),
			`FIRST_SIGNED_VERSION ${FIRST_SIGNED_VERSION} is not the next release after ${version}`,
		);
	}
});

test("the Trust anchor trusts the release key for git signatures and is vendored", () => {
	assert.equal(
		readFileSync(TRUST_ANCHOR_PATH, "utf8"),
		'toolkit-release namespaces="git" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEnNRrfwwwN88SJlBERLUFA0MypHecOxreM9QNhO0Ssy toolkit-release\n',
	);
	const manifest = JSON.parse(
		readFileSync(new URL("toolkit-manifest.json", packageDir), "utf8"),
	);
	assert.ok(manifest.include.includes("allowed_signers"));
});

/** This repository's `v*` tags below FIRST_SIGNED_VERSION, as LEGACY_TAGS records them. */
function repositoryLegacyTags() {
	const refs = execFileSync(
		"git",
		[
			"for-each-ref",
			"--sort=v:refname",
			"--format=%(refname:short) %(objecttype) %(objectname) %(*objectname)",
			"refs/tags/v*",
		],
		{ cwd: toolkitRepo, encoding: "utf8" },
	);
	return refs
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => {
			const [name, type, object, peeled] = line.split(" ");
			return type === "tag"
				? { name, commit: peeled, tagObject: object }
				: { name, commit: object, tagObject: null };
		})
		.filter(
			({ name }) =>
				/^v\d+\.\d+\.\d+$/.test(name) &&
				compareVersions(name.slice(1), FIRST_SIGNED_VERSION) < 0,
		);
}

test("LEGACY_TAGS matches every tag below FIRST_SIGNED_VERSION in this repository", () => {
	const expected = repositoryLegacyTags();
	assert.ok(
		expected.length > 0,
		"this clone has no v* tags; run `git fetch --tags` and retry",
	);
	assert.deepEqual(LEGACY_TAGS, expected);
	assert.equal(LEGACY_TAGS.length, 32);
	assert.equal(LEGACY_TAGS[0].name, "v0.1.0");
	assert.equal(LEGACY_TAGS.at(-1).name, "v0.13.0");
	assert.deepEqual(
		LEGACY_TAGS.filter((entry) => entry.tagObject === null).map(
			(entry) => entry.name,
		),
		["v0.1.0", "v0.2.0"],
	);
	assert.ok(Object.isFrozen(LEGACY_TAGS));
	assert.ok(LEGACY_TAGS.every((entry) => Object.isFrozen(entry)));
});

test("isLegacyTag covers only the tags in LEGACY_TAGS", () => {
	assert.equal(isLegacyTag("v0.13.0"), true);
	assert.equal(isLegacyTag("v0.1.0"), true);
	assert.equal(isLegacyTag("v0.13.5"), false);
	assert.equal(isLegacyTag("v0.0.1"), false);
	assert.equal(isLegacyTag(`v${FIRST_SIGNED_VERSION}`), false);
	assert.equal(isLegacyTag("v1.0.0"), false);
	assert.equal(isLegacyTag("0.13.0"), false);
	assert.equal(isLegacyTag("main"), false);
});

test("a tag signed by an anchored key verifies and names its signer", () => {
	const fixture = createFixtureRepo();
	assert.deepEqual(
		verifyReleaseTag(fetched(fixture), fixture.tag, { anchorPath: trusted() }),
		{ signer: "toolkit-release" },
	);
});

test("an unsigned tag at or above FIRST_SIGNED_VERSION fails", () => {
	for (const annotate of [true, false]) {
		const fixture = createFixtureRepo({
			tag: `v${FIRST_SIGNED_VERSION}`,
			signingKey: null,
			annotate,
		});
		assert.throws(
			() =>
				verifyReleaseTag(fetched(fixture), fixture.tag, {
					anchorPath: trusted(),
				}),
			/is not a Signed release tag: it has no signature/,
		);
	}
});

test("a tag signed by a key outside the Trust anchor fails", () => {
	const fixture = createFixtureRepo({ signingKey: createSigningKey() });
	assert.throws(
		() =>
			verifyReleaseTag(fetched(fixture), fixture.tag, {
				anchorPath: trusted(),
			}),
		/does not verify against the Trust anchor[\s\S]*No principal matched/,
	);
});

test("a key used after its valid-before date fails", () => {
	const fixture = createFixtureRepo();
	const anchorPath = writeAnchor(
		allowedSignersLine(testSigningKey(), {
			options: ['valid-before="20200101"'],
		}),
	);
	assert.throws(
		() => verifyReleaseTag(fetched(fixture), fixture.tag, { anchorPath }),
		/does not verify against the Trust anchor[\s\S]*expired/,
	);
});

test("a key used inside its valid-before window still verifies", () => {
	const fixture = createFixtureRepo();
	const anchorPath = writeAnchor(
		allowedSignersLine(testSigningKey(), {
			options: ['valid-before="29990101"'],
		}),
	);
	assert.deepEqual(
		verifyReleaseTag(fetched(fixture), fixture.tag, { anchorPath }),
		{ signer: "toolkit-release" },
	);
});

test("a signed tag object replayed under another tag name fails", () => {
	const fixture = createFixtureRepo();
	const object = execFileSync("git", ["rev-parse", fixture.tag], {
		cwd: fixture.root,
		encoding: "utf8",
	}).trim();
	execFileSync("git", ["update-ref", "refs/tags/v9.0.0", object], {
		cwd: fixture.root,
	});
	const replayed = { ...fixture, tag: "v9.0.0" };
	assert.throws(
		() =>
			verifyReleaseTag(fetched(replayed), "v9.0.0", {
				anchorPath: trusted(),
			}),
		/tag object is named "v1\.0\.0"/,
	);
});

test("a missing Trust anchor fails closed", () => {
	const fixture = createFixtureRepo();
	assert.throws(
		() =>
			verifyReleaseTag(fetched(fixture), fixture.tag, {
				anchorPath: join(mkTempDir(), "allowed_signers"),
			}),
		/no Trust anchor at/,
	);
});

test("a known Legacy tag fails without allowUnsigned and passes with it plus a warning", () => {
	for (const tag of ["v0.13.0", "v0.1.0"]) {
		const cacheDir = fetched(copyLegacyTag(tag));
		assert.throws(
			() => verifyReleaseTag(cacheDir, tag, { anchorPath: trusted() }),
			(error) => {
				assert.ok(error.message.includes(`"${tag}" is a Legacy tag`));
				assert.match(error.message, /pass --allow-unsigned/);
				return true;
			},
		);
		const warnings = [];
		const result = verifyReleaseTag(cacheDir, tag, {
			anchorPath: trusted(),
			allowUnsigned: true,
			warn: (message) => warnings.push(message),
		});
		assert.deepEqual(result, { legacy: true });
		assert.deepEqual(warnings, [
			`warning: accepting Legacy tag "${tag}" without a signature because of --allow-unsigned`,
		]);
	}
});

/** Assert `fixture`'s tag is refused as not a known Legacy tag, with or without allowUnsigned. */
function assertUnknownLegacyTag(fixture) {
	const cacheDir = fetched(fixture);
	for (const allowUnsigned of [false, true]) {
		assert.throws(
			() =>
				verifyReleaseTag(cacheDir, fixture.tag, {
					anchorPath: trusted(),
					allowUnsigned,
					warn: () => assert.fail("no warning for an unknown tag"),
				}),
			(error) => {
				assert.match(error.message, /is not a known Legacy tag/);
				assert.doesNotMatch(error.message, /--allow-unsigned/);
				return true;
			},
		);
	}
}

test("a tag below FIRST_SIGNED_VERSION that isn't in LEGACY_TAGS fails even with allowUnsigned", () => {
	for (const tagOptions of [
		{ signingKey: null },
		{ signingKey: null, annotate: true },
		{},
	])
		assertUnknownLegacyTag(
			createFixtureRepo({ tag: "v0.13.5", ...tagOptions }),
		);
});

test("a known Legacy tag name on another commit fails even with allowUnsigned", () => {
	for (const annotate of [false, true])
		assertUnknownLegacyTag(
			createFixtureRepo({ tag: "v0.13.0", signingKey: null, annotate }),
		);
});

test("a known Legacy tag re-created on the same commit with another tag object fails", () => {
	assertUnknownLegacyTag(copyLegacyTag("v0.13.0", { retag: "annotated" }));
});

test("a lightweight ref under an annotated Legacy tag, or the reverse, fails", () => {
	assertUnknownLegacyTag(copyLegacyTag("v0.13.0", { retag: "lightweight" }));
	assertUnknownLegacyTag(copyLegacyTag("v0.1.0", { retag: "annotated" }));
});

test("allowUnsigned doesn't help an unsigned tag at or above FIRST_SIGNED_VERSION", () => {
	const fixture = createFixtureRepo({
		tag: `v${FIRST_SIGNED_VERSION}`,
		signingKey: null,
		annotate: true,
	});
	assert.throws(
		() =>
			verifyReleaseTag(fetched(fixture), fixture.tag, {
				anchorPath: trusted(),
				allowUnsigned: true,
				warn: () => assert.fail("no warning for a non-Legacy tag"),
			}),
		/no signature \(--allow-unsigned only applies to Legacy tags/,
	);
});
