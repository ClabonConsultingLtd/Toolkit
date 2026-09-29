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
	TRUST_ANCHOR_PATH,
	verifyReleaseTag,
} from "../src/signature.mjs";
import {
	allowedSignersLine,
	createFixtureRepo,
	createSigningKey,
	mkTempDir,
	testSigningKey,
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

test("isLegacyTag covers release tags below FIRST_SIGNED_VERSION only", () => {
	assert.equal(isLegacyTag("v0.13.0"), true);
	assert.equal(isLegacyTag("v0.1.0"), true);
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

test("a Legacy tag fails without allowUnsigned and passes with it plus a warning", () => {
	const fixture = createFixtureRepo({ tag: "v0.13.0", signingKey: null });
	const cacheDir = fetched(fixture);
	assert.throws(
		() => verifyReleaseTag(cacheDir, fixture.tag, { anchorPath: trusted() }),
		/"v0\.13\.0" is a Legacy tag[\s\S]*--allow-unsigned/,
	);
	const warnings = [];
	const result = verifyReleaseTag(cacheDir, fixture.tag, {
		anchorPath: trusted(),
		allowUnsigned: true,
		warn: (message) => warnings.push(message),
	});
	assert.deepEqual(result, { legacy: true });
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /warning: .*Legacy tag "v0\.13\.0"/);
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
