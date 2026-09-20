import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireTriageLock, releaseTriageLock } from "../src/triage-lock.mjs";

function lockDir() {
	return mkdtempSync(join(tmpdir(), "triage-lock-"));
}

test("acquireTriageLock grants an uncontended lock", () => {
	const dir = lockDir();
	const result = acquireTriageLock(dir, { now: 1_000 });
	assert.equal(result.acquired, true);
	assert.equal(existsSync(result.lockPath), true);
});

test("acquireTriageLock refuses a fresh lock held by another run", () => {
	const dir = lockDir();
	acquireTriageLock(dir, { now: 1_000 });
	const second = acquireTriageLock(dir, { now: 1_000 + 60_000 });
	assert.equal(second.acquired, false);
	assert.equal(second.heldSince, 1_000);
});

test("acquireTriageLock reclaims a lock older than ttlMs", () => {
	const dir = lockDir();
	acquireTriageLock(dir, { now: 1_000, ttlMs: 10_000 });
	const second = acquireTriageLock(dir, { now: 1_000 + 20_000, ttlMs: 10_000 });
	assert.equal(second.acquired, true);
});

test("releaseTriageLock removes the lock so it can be reacquired immediately", () => {
	const dir = lockDir();
	acquireTriageLock(dir, { now: 1_000 });
	const released = releaseTriageLock(dir);
	assert.equal(released.released, true);
	const second = acquireTriageLock(dir, { now: 1_000 + 1 });
	assert.equal(second.acquired, true);
});

test("releaseTriageLock is a no-op when nothing is held", () => {
	const dir = lockDir();
	assert.equal(releaseTriageLock(dir).released, false);
});
