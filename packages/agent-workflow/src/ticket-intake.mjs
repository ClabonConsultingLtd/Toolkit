import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ACTIVE, atomicWrite, newBatch } from "./orchestration.mjs";
import { github } from "./orchestration-github.mjs";
import {
	batchStates,
	selectNext,
	withSelectionLock,
} from "./ticket-selection.mjs";

export function intakePath(batchFile) {
	return join(dirname(batchFile), ".intake", "policy.json");
}
export function readIntake(batchFile) {
	const path = intakePath(batchFile);
	if (!existsSync(path)) return null;
	const policy = JSON.parse(readFileSync(path, "utf8"));
	if (
		policy.version !== 1 ||
		!Number.isSafeInteger(policy.count) ||
		policy.count < 1
	)
		throw new Error("invalid intake policy");
	return policy;
}
export function isInProgress(ticket) {
	return (
		ACTIVE.has(ticket.status) ||
		!!ticket.workerActive ||
		!!ticket.launchUncertain
	);
}
export function capacity(batchFile, repository, replacement) {
	const policy = readIntake(batchFile);
	if (policy && policy.repository.toLowerCase() !== repository.toLowerCase())
		throw new Error("intake policy belongs to another repository");
	let active = 0,
		queued = 0;
	for (const record of batchStates(batchFile, repository)) {
		const state =
			replacement && resolve(record.path) === resolve(batchFile)
				? replacement
				: record.state;
		for (const ticket of Object.values(state.tickets)) {
			if (isInProgress(ticket)) active++;
			else if (ticket.status === "queued") queued++;
		}
	}
	return {
		limit: policy?.count ?? null,
		active,
		queued,
		executionSlots: policy ? Math.max(0, policy.count - active) : null,
		admissionSlots: policy ? Math.max(0, policy.count - active - queued) : null,
	};
}
export function enforceCapacity(batchFile, state, previousActive) {
	const currentActive = Object.values(state.tickets).filter(
		isInProgress,
	).length;
	if (currentActive <= previousActive) return;
	const summary = capacity(batchFile, state.repository, state);
	if (summary.limit !== null && summary.active > summary.limit)
		throw new Error(
			"repository intake execution limit reached; wait for an active slot",
		);
}
export function intakeCommand(command, checkout, input = {}, options = {}) {
	const cwd = resolve(checkout),
		anchor = join(cwd, ".toolkit", "orchestration", "intake-anchor.json");
	if (command === "status") return readIntake(anchor);
	return withSelectionLock(anchor, () => {
		let policy = readIntake(anchor);
		const path = intakePath(anchor);
		if (command === "configure") {
			if (!Number.isSafeInteger(input.count) || input.count < 1)
				throw new Error("count must be a positive integer");
			newBatch({ ...input, cwd, batchId: "intake-validation", tickets: ["1"] });
			if (
				policy &&
				policy.repository.toLowerCase() !== input.repository.toLowerCase()
			)
				throw new Error("intake already configured for another repository");
			const current = capacity(anchor, input.repository);
			if (current.active > input.count)
				throw new Error(
					"requested limit is below current active work; wait before lowering it",
				);
			policy = {
				version: 1,
				repository: input.repository,
				cwd,
				baseBranch: input.baseBranch,
				codexModel: input.codexModel,
				count: input.count,
				cron: "0 * * * *",
				timezone: "UTC",
				scheduleName: `ticket-intake:${input.repository}`,
				scheduleId: policy?.scheduleId ?? null,
				paused: policy?.paused ?? false,
				lastTick: policy?.lastTick ?? null,
			};
			atomicWrite(path, policy);
			return policy;
		}
		if (!policy) throw new Error("configure intake first");
		if (command === "schedule") {
			if (typeof input.scheduleId !== "string" || !input.scheduleId)
				throw new Error("scheduleId required");
			if (policy.scheduleId && policy.scheduleId !== input.scheduleId)
				throw new Error("intake schedule already registered");
			policy.scheduleId = input.scheduleId;
		} else if (command === "pause" || command === "resume") {
			policy.paused = command === "pause";
		} else if (command === "tick") {
			if (policy.paused) return { paused: true, initialized: false };
			const now = options.now ?? Date.now(),
				hour = new Date(now).toISOString().slice(0, 13);
			if (policy.lastTick && policy.lastTick.hour >= hour)
				return { ...policy.lastTick, replayed: true };
			const batchId = `intake-${hour.replace(/[-T:]/g, "")}`,
				batchFile = join(dirname(anchor), `${batchId}.json`);
			// Atomic batch creation precedes tick bookkeeping. Recover that batch after a crash.
			if (existsSync(batchFile)) {
				const existing = JSON.parse(readFileSync(batchFile, "utf8"));
				if (
					existing.repository !== policy.repository ||
					existing.selection?.intakeHour !== hour
				)
					throw new Error("intake batch ID collision");
				policy.lastTick = {
					hour,
					initialized: true,
					batchFile,
					tickets: existing.ticketOrder,
					recovered: true,
				};
			} else {
				const budget = capacity(anchor, policy.repository);
				const count = Math.min(policy.count, budget.admissionSlots);
				if (count === 0)
					policy.lastTick = {
						hour,
						initialized: false,
						tickets: [],
						reason: "capacity full",
						capacity: budget,
					};
				else {
					const request = {
						...policy,
						batchId,
						count,
						concurrency: Math.min(3, policy.count),
						models: input.models,
						excludeTickets: input.excludeTickets,
					};
					const selection = selectNext(
						batchFile,
						request,
						(options.github ?? github)(policy.repository),
					);
					if (selection.tickets.length) {
						const state = newBatch({ ...request, tickets: selection.tickets });
						state.selection = {
							mode: "hourly",
							intakeHour: hour,
							requestedCount: policy.count,
							order: selection.order,
						};
						state.managedByIntake = true;
						atomicWrite(batchFile, state);
						policy.lastTick = {
							hour,
							initialized: true,
							batchFile,
							...selection,
						};
					} else policy.lastTick = { hour, initialized: false, ...selection };
				}
			}
			atomicWrite(path, policy);
			return policy.lastTick;
		} else throw new Error(`unknown intake command: ${command}`);
		atomicWrite(path, policy);
		return policy;
	});
}
