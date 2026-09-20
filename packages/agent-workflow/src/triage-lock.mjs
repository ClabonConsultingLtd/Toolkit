import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

const DEFAULT_TTL_MS = 30 * 60_000;
const LOCK_NAME = "run.lock";

function metaPath(lockPath) {
	return join(lockPath, "meta.json");
}

function readLockMeta(lockPath) {
	try {
		return JSON.parse(readFileSync(metaPath(lockPath), "utf8"));
	} catch {
		return null;
	}
}

// A repo's own triage-label state is the sole source of truth for what has
// been triaged; this lock only prevents two overlapping runs from racing
// each other while they read/apply those labels. It never tracks per-issue
// progress, and a stale lock (crashed run) is reclaimed automatically after
// ttlMs rather than requiring manual recovery.
export function acquireTriageLock(
	lockDir,
	{ ttlMs = DEFAULT_TTL_MS, now = Date.now(), pid = process.pid } = {},
) {
	const lockPath = join(lockDir, LOCK_NAME);
	mkdirSync(lockDir, { recursive: true });
	try {
		mkdirSync(lockPath);
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
		const meta = readLockMeta(lockPath);
		const heldSince = meta?.startedAt;
		if (typeof heldSince === "number" && now - heldSince < ttlMs)
			return {
				acquired: false,
				lockPath,
				heldSince,
				expiresAt: heldSince + ttlMs,
			};
		rmSync(lockPath, { recursive: true, force: true });
		mkdirSync(lockPath);
	}
	writeFileSync(metaPath(lockPath), JSON.stringify({ startedAt: now, pid }));
	return { acquired: true, lockPath, startedAt: now };
}

export function releaseTriageLock(lockDir) {
	const lockPath = join(lockDir, LOCK_NAME);
	const held = existsSync(lockPath);
	rmSync(lockPath, { recursive: true, force: true });
	return { released: held };
}
