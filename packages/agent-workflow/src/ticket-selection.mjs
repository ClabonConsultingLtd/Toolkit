import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { normalizeSpecLabels } from "./intake-config.mjs";
import { issueNumber, newBatch } from "./orchestration.mjs";
import {
	normalizeClaudeModels,
	resolveWorkerRuntime,
} from "./orchestration-github.mjs";
import {
	normalizeCodexModels,
	readClaudeCooldown,
} from "./provider-fallback.mjs";

const SELECTION_LOCK_TTL_MS = 30 * 60_000;

function processAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}

// A selection transaction is short and synchronous, so the lock outliving its
// writer means that process was killed (e.g. an agent tool timeout) before its
// finally block ran. Reclaim it when the recorded owner is provably gone on
// this host, or when it is older than the TTL (unknown host, or a legacy lock
// with no owner metadata, judged by the directory's mtime).
function staleSelectionLock(lock, { now, host, ttlMs, alive }) {
	let meta = null;
	try {
		meta = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
	} catch {}
	let startedAt = meta?.startedAt;
	if (typeof startedAt !== "number") {
		try {
			startedAt = statSync(lock).mtimeMs;
		} catch (error) {
			if (error.code === "ENOENT") return true;
			throw error;
		}
	}
	if (now - startedAt >= ttlMs) return true;
	return meta?.host === host && Number.isInteger(meta.pid) && !alive(meta.pid);
}

// Serialize selection and initialization across batches in the canonical state
// directory. Per-batch execution leases continue to own implementation/review.
export function withSelectionLock(
	file,
	action,
	{
		now = Date.now(),
		host = hostname(),
		pid = process.pid,
		ttlMs = SELECTION_LOCK_TTL_MS,
		alive = processAlive,
	} = {},
) {
	const dir = dirname(file),
		lock = join(dir, ".selection.lock");
	mkdirSync(dir, { recursive: true });
	try {
		mkdirSync(lock);
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
		if (!staleSelectionLock(lock, { now, host, ttlMs, alive }))
			throw new Error(
				"another batch selection is in progress; retry later (the lock is reclaimed automatically once its owner has exited or after 30 minutes)",
			);
		rmSync(lock, { recursive: true, force: true });
		try {
			mkdirSync(lock);
		} catch (retry) {
			if (retry.code === "EEXIST")
				throw new Error("another batch selection is in progress; retry later");
			throw retry;
		}
	}
	writeFileSync(
		join(lock, "owner.json"),
		JSON.stringify({ host, pid, startedAt: now }),
	);
	try {
		return action();
	} finally {
		rmSync(lock, { recursive: true, force: true });
	}
}
export function batchStates(file, repository) {
	const dir = dirname(file),
		states = [];
	if (!existsSync(dir)) return states;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const path = join(dir, entry.name);
		let state;
		try {
			state = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			throw new Error(`cannot inspect existing batch state: ${path}`);
		}
		if (
			!state.version ||
			typeof state.tickets !== "object" ||
			Array.isArray(state.tickets)
		)
			continue;
		if (state.repository?.toLowerCase() !== repository.toLowerCase()) continue;
		if (state.version !== 1)
			throw new Error(`unsupported batch version: ${path}`);
		states.push({ path, state });
	}
	return states;
}
export function claimedTickets(file, repository) {
	const claimed = new Set();
	for (const { state } of batchStates(file, repository))
		for (const [number, ticket] of Object.entries(state.tickets))
			if (ticket.status !== "completed") claimed.add(issueNumber(number));
	return claimed;
}
export function assertUnclaimed(file, input) {
	const claimed = claimedTickets(file, input.repository);
	const conflicts = input.tickets
		.map(issueNumber)
		.filter((n) => claimed.has(n));
	if (conflicts.length)
		throw new Error(
			`tickets already belong to another batch: ${conflicts.join(", ")}`,
		);
}
export function selectNext(file, input, api) {
	if (!Number.isSafeInteger(input.count) || input.count < 1)
		throw new Error("count must be a positive integer");
	if (input.tickets !== undefined)
		throw new Error("choose count or explicit tickets, not both");
	// Validate all initialization fields before contacting GitHub, even for preview.
	newBatch({ ...input, tickets: ["1"] });
	// A malformed live catalog is an invocation error, not evidence that every
	// ready ticket's recommendation is unsupported. Validate before GitHub reads
	// or an intake tick can persist an incorrect empty result.
	const evaluatedAt = Date.now();
	const cooldown = readClaudeCooldown(input.fallbackStatePath, evaluatedAt);
	const models = cooldown.active
		? input.models
		: normalizeClaudeModels(input.models);
	if (cooldown.active) normalizeCodexModels(input.codexModels);
	if (
		input.excludeTickets !== undefined &&
		!Array.isArray(input.excludeTickets)
	)
		throw new Error("excludeTickets must be an array");
	const specLabels = normalizeSpecLabels(input.specLabels ?? []);
	const claimed = claimedTickets(file, input.repository);
	for (const n of input.excludeTickets ?? []) claimed.add(issueNumber(n));
	const selected = [],
		skipped = [],
		cache = new Map();
	const candidates = api
		.listReady()
		.sort(
			(a, b) =>
				String(a.created_at).localeCompare(String(b.created_at)) ||
				Number(a.number) - Number(b.number),
		);
	const seen = new Set();
	for (const candidate of candidates) {
		const number = issueNumber(candidate.number);
		if (seen.has(number)) continue;
		seen.add(number);
		let reason;
		if (claimed.has(number)) reason = "already selected or active";
		else {
			let issue;
			try {
				issue = api.issue(number);
			} catch (error) {
				if (error.code !== "INVALID_DEPENDENCY_DECLARATION") throw error;
				skipped.push({
					number,
					reason: "invalid dependency declaration",
					detail: error.message,
				});
				continue;
			}
			cache.set(number, issue);
			if (issue.state !== "OPEN" || !issue.labels.includes("ready-for-agent"))
				reason = "not open and ready-for-agent";
			else if (
				issue.labels.some((l) =>
					[
						"done",
						"wontfix",
						"ready-for-human",
						"needs-info",
						"needs-triage",
					].includes(l),
				)
			)
				reason = "conflicting status label";
			else if (issue.assignees?.length) reason = "already assigned";
			else if (issue.labels.some((l) => specLabels.includes(l)))
				reason = "spec or umbrella label";
			else {
				const children = api.subTickets(number);
				if (children.length) {
					skipped.push({
						number,
						reason: "parent spec with sub-tickets",
						subTickets: children,
					});
					continue;
				}
				const pending = [];
				for (const dependency of issue.dependencies) {
					if (!cache.has(dependency))
						cache.set(dependency, api.issue(dependency, false));
					if (
						cache.get(dependency).state !== "CLOSED" ||
						claimed.has(dependency)
					)
						pending.push(dependency);
				}
				if (pending.length)
					reason = `blocked by ${pending.map((n) => `#${n}`).join(", ")}`;
				else {
					const implementationPr = api.hasImplementationPr(number);
					if (implementationPr) {
						reason = "existing open or merged implementation PR";
						if (typeof implementationPr === "object")
							skipped.push({ number, reason, pr: implementationPr });
						else skipped.push({ number, reason });
						continue;
					}
					try {
						resolveWorkerRuntime(
							issue.recommendation,
							{ models, codexModels: input.codexModels },
							{ statePath: input.fallbackStatePath, now: evaluatedAt },
						);
					} catch (error) {
						reason = error.message;
					}
				}
			}
		}
		if (reason) skipped.push({ number, reason });
		else selected.push(number);
		if (selected.length === input.count) break;
	}
	return {
		requestedCount: input.count,
		tickets: selected,
		skipped,
		order: "oldest-created-first",
		selectionMode: "fixed",
		shortfall: input.count - selected.length,
	};
}
