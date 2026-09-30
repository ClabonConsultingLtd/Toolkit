import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
	diffTrustAnchor,
	fingerprintKey,
	parseTrustAnchor,
} from "../src/trust-anchor.mjs";
import {
	allowedSignersLine,
	createSigningKey,
} from "../test-helpers/fixture-repo.mjs";

const keyA = createSigningKey();
const keyB = createSigningKey();

const lineA = allowedSignersLine(keyA);
const lineB = allowedSignersLine(keyB, { principal: "backup-release" });

const describe = ({ principal, options, publicKey }) =>
	`${principal} ${options.join(",")} ${publicKey}`;

test("parseTrustAnchor reads one entry per principal and skips comments and blank lines", () => {
	const entries = parseTrustAnchor(
		`# the release key\n\n  a@x,b@x  namespaces="git"  ${keyA.publicKey} a comment\n${keyB.publicKey.replace(/^/, "c@x ")}\n`,
	);
	assert.deepEqual(entries.map(describe), [
		`a@x namespaces="git" ${keyA.publicKey}`,
		`b@x namespaces="git" ${keyA.publicKey}`,
		`c@x  ${keyB.publicKey}`,
	]);
});

test("parseTrustAnchor keeps a quoted option value with spaces intact", () => {
	const [entry] = parseTrustAnchor(
		`p namespaces="git",valid-after="20260101 00:00" ${keyA.publicKey}\n`,
	);
	assert.deepEqual(entry.options, [
		'namespaces="git"',
		'valid-after="20260101 00:00"',
	]);
	assert.equal(entry.publicKey, keyA.publicKey);
});

test("diffTrustAnchor ignores comments, blank lines, whitespace, order and the key comment", () => {
	const before = `${lineA}${lineB}`;
	const after = `# reordered\n\n${lineB.replace(/ /g, "\t  ")}\n${lineA.trimEnd()} trailing key comment\n`;
	assert.deepEqual(diffTrustAnchor(before, after), { added: [], removed: [] });
});

test("diffTrustAnchor ignores the order of options and of principals", () => {
	const before = `a@x,b@x namespaces="git",valid-before="20270101" ${keyA.publicKey}\n`;
	const after = `b@x,a@x valid-before="20270101",namespaces="git" ${keyA.publicKey}\n`;
	assert.deepEqual(diffTrustAnchor(before, after), { added: [], removed: [] });
});

test("diffTrustAnchor reports a new key as added and a dropped key as removed", () => {
	const added = diffTrustAnchor(lineA, `${lineA}${lineB}`);
	assert.deepEqual(added.added.map(describe), [
		`backup-release namespaces="git" ${keyB.publicKey}`,
	]);
	assert.deepEqual(added.removed, []);

	const removed = diffTrustAnchor(`${lineA}${lineB}`, lineA);
	assert.deepEqual(removed.added, []);
	assert.deepEqual(removed.removed.map(describe), [
		`backup-release namespaces="git" ${keyB.publicKey}`,
	]);
});

test("diffTrustAnchor reports an existing key under a new principal as an addition", () => {
	const renamed = allowedSignersLine(keyA, { principal: "someone-else" });
	const { added, removed } = diffTrustAnchor(lineA, renamed);
	assert.deepEqual(added.map(describe), [
		`someone-else namespaces="git" ${keyA.publicKey}`,
	]);
	assert.deepEqual(removed.map(describe), [
		`toolkit-release namespaces="git" ${keyA.publicKey}`,
	]);

	const extraPrincipal = `toolkit-release,someone-else namespaces="git" ${keyA.publicKey}\n`;
	assert.deepEqual(diffTrustAnchor(lineA, extraPrincipal).added.map(describe), [
		`someone-else namespaces="git" ${keyA.publicKey}`,
	]);
});

test("diffTrustAnchor reports changed options as an addition", () => {
	const widened = allowedSignersLine(keyA, { options: ["cert-authority"] });
	const { added, removed } = diffTrustAnchor(lineA, widened);
	assert.deepEqual(added.map(describe), [
		`toolkit-release namespaces="git",cert-authority ${keyA.publicKey}`,
	]);
	assert.equal(removed.length, 1);

	const optionless = `toolkit-release ${keyA.publicKey}\n`;
	assert.equal(diffTrustAnchor(lineA, optionless).added.length, 1);
});

test("diffTrustAnchor treats a missing old anchor as every entry added", () => {
	for (const missing of [null, undefined]) {
		const { added, removed } = diffTrustAnchor(missing, `${lineA}${lineB}`);
		assert.equal(added.length, 2);
		assert.deepEqual(removed, []);
	}
	assert.deepEqual(diffTrustAnchor(lineA, null).removed.length, 1);
});

test("diffTrustAnchor treats a line it can't parse as an entry, so a change to it still counts", () => {
	const { added } = diffTrustAnchor(lineA, `${lineA}not a signer line\n`);
	assert.equal(added.length, 1);
	assert.equal(added[0].publicKey, "not a signer line");
});

test("fingerprintKey returns ssh-keygen's SHA256 fingerprint, and undefined for a bad key", () => {
	const expected = execFileSync(
		"ssh-keygen",
		["-lf", `${keyA.privateKey}.pub`],
		{
			encoding: "utf8",
		},
	).split(" ")[1];
	assert.match(expected, /^SHA256:/);
	assert.equal(fingerprintKey(keyA.publicKey), expected);
	assert.equal(fingerprintKey("ssh-ed25519 AAAAnotakey"), undefined);
	assert.equal(fingerprintKey("not a signer line"), undefined);
});
