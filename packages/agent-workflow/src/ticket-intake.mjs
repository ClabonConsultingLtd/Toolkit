import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	normalizeExcludeTickets,
	normalizeRequiredChecks,
	normalizeSpecLabels,
	readRepositoryIntakeConfig,
} from "./intake-config.mjs";
import { ACTIVE, atomicWrite, newBatch } from "./orchestration.mjs";
import { github, helperIdentity } from "./orchestration-github.mjs";
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
	if (policy.requiredChecks !== undefined)
		normalizeRequiredChecks(policy.requiredChecks, "invalid intake policy");
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
function readHourlyBatch(batchFile, repository, hour) {
	const existing = JSON.parse(readFileSync(batchFile, "utf8"));
	if (
		existing.repository !== repository ||
		existing.selection?.intakeHour !== hour ||
		!Array.isArray(existing.ticketOrder) ||
		!existing.ticketOrder.length
	)
		throw new Error("intake batch ID collision");
	return existing;
}
function configuredPolicy(anchor, cwd, policy, input) {
	if (!Number.isSafeInteger(input.count) || input.count < 1)
		throw new Error("count must be a positive integer");
	for (const field of ["cron", "timezone"])
		if (
			input[field] !== undefined &&
			(typeof input[field] !== "string" || !input[field].trim())
		)
			throw new Error(`${field} must be a nonempty string`);
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
	return {
		version: 1,
		repository: input.repository,
		cwd,
		baseBranch: input.baseBranch,
		codexModel: input.codexModel,
		count: input.count,
		cron: input.cron ?? policy?.cron ?? "*/30 8-19 * * *",
		timezone: input.timezone ?? policy?.timezone ?? "UTC",
		excludeTickets: normalizeExcludeTickets(
			input.excludeTickets ?? policy?.excludeTickets ?? [],
		),
		...(input.requiredChecks === undefined
			? {}
			: { requiredChecks: normalizeRequiredChecks(input.requiredChecks) }),
		...(input.specLabels === undefined
			? {}
			: { specLabels: normalizeSpecLabels(input.specLabels) }),
		scheduleName: `ticket-intake:${input.repository}`,
		scheduleId: policy?.scheduleId ?? null,
		paused: policy?.paused ?? false,
		...(policy?.paused && {
			pausedAt: policy.pausedAt,
			pauseReason: policy.pauseReason,
		}),
		lastTick: policy?.lastTick ?? null,
	};
}
function reconcileSchedule(policy, schedule, now) {
	if (!policy.scheduleId)
		throw new Error(
			"intake schedule ID is missing; register the Paseo schedule before admission",
		);
	if (!schedule || typeof schedule !== "object")
		throw new Error("live Paseo schedule state is required before admission");
	if (
		schedule.id !== policy.scheduleId ||
		schedule.name !== policy.scheduleName
	)
		throw new Error(
			"live Paseo schedule ID or name does not match intake policy",
		);
	if (typeof schedule.paused !== "boolean")
		throw new Error("live Paseo schedule paused state is unavailable");
	if (schedule.paused && !policy.paused) {
		policy.pausedAt = new Date(now).toISOString();
		policy.pauseReason = "Paused in Paseo";
	} else if (!schedule.paused) {
		delete policy.pausedAt;
		delete policy.pauseReason;
	}
	policy.paused = schedule.paused;
}
// Controller merges otherwise read branch protection, which GitHub hides on private repositories without a paid plan.
const REQUIRED_CHECKS_WARNING =
	"requiredChecks is not configured: controller merges fall back to the branch protection API, which GitHub denies for private repositories on plans without protected branches. List the checks in toolkit-intake.json.";
function withRequiredChecksWarning(result, requiredChecks) {
	return requiredChecks === undefined
		? { ...result, warnings: [REQUIRED_CHECKS_WARNING] }
		: result;
}

export function intakeCommand(command, checkout, input = {}, options = {}) {
	const cwd = resolve(checkout),
		anchor = join(cwd, ".toolkit", "orchestration", "intake-anchor.json");
	const activeHelper = helperIdentity();
	if (command === "status") {
		const policy = readIntake(anchor);
		const config = readRepositoryIntakeConfig(cwd);
		return policy
			? withRequiredChecksWarning(
					{
						...policy,
						activeHelper,
						repositoryConfig: config ? "toolkit-intake.json" : null,
					},
					config?.requiredChecks ?? policy.requiredChecks,
				)
			: {
					activeHelper,
					configured: false,
					repositoryConfig: config ? "toolkit-intake.json" : null,
				};
	}
	const result = withSelectionLock(anchor, () => {
		let policy = readIntake(anchor);
		const path = intakePath(anchor);
		const config = ["configure", "sync-config", "tick"].includes(command)
			? readRepositoryIntakeConfig(cwd)
			: null;
		if (command === "configure" || command === "sync-config") {
			if (command === "sync-config" && !config)
				throw new Error("toolkit-intake.json is required for sync-config");
			if (config && Object.keys(input).length)
				throw new Error(
					"toolkit-intake.json is authoritative; configure without a request",
				);
			policy = configuredPolicy(anchor, cwd, policy, config ?? input);
			atomicWrite(path, policy);
			return withRequiredChecksWarning(policy, policy.requiredChecks);
		}
		if (!policy) throw new Error("configure intake first");
		if (command === "tick" && config) {
			policy = configuredPolicy(anchor, cwd, policy, config);
		}
		if (command === "schedule") {
			if (typeof input.scheduleId !== "string" || !input.scheduleId)
				throw new Error("scheduleId required");
			if (policy.scheduleId && policy.scheduleId !== input.scheduleId)
				throw new Error("intake schedule already registered");
			policy.scheduleId = input.scheduleId;
		} else if (["tick", "pause", "resume"].includes(command)) {
			reconcileSchedule(
				policy,
				options.schedule ?? input.schedule,
				options.now ?? Date.now(),
			);
			if (command === "pause" || command === "resume") {
				if (policy.paused !== (command === "pause"))
					throw new Error(`${command} the Paseo schedule first`);
				atomicWrite(path, policy);
				return policy;
			}
			const dynamicExclusions = normalizeExcludeTickets(
				input.excludeTickets ?? [],
			);
			atomicWrite(path, policy);
			if (policy.paused) {
				return {
					status: "paused",
					paused: true,
					initialized: false,
					capacity: capacity(anchor, policy.repository),
				};
			}
			const now = options.now ?? Date.now(),
				hour = new Date(now).toISOString().slice(0, 13);
			const batchId = `intake-${hour.replace(/[-T:]/g, "")}`,
				batchFile = join(dirname(anchor), `${batchId}.json`);
			if (policy.lastTick?.hour > hour)
				return {
					...policy.lastTick,
					status: "replayed",
					replayed: true,
					reason: "clock is before the last evaluated hour",
					capacity: capacity(anchor, policy.repository),
				};
			if (policy.lastTick?.hour === hour && policy.lastTick.initialized) {
				if (!existsSync(batchFile))
					throw new Error(
						"admitted intake batch is missing; reconcile before retrying",
					);
				const existing = readHourlyBatch(batchFile, policy.repository, hour);
				if (
					JSON.stringify(existing.ticketOrder) !==
					JSON.stringify(policy.lastTick.tickets)
				)
					throw new Error("intake batch differs from the recorded admission");
				return {
					...policy.lastTick,
					status: "replayed",
					replayed: true,
					capacity: capacity(anchor, policy.repository),
				};
			}
			const retried = policy.lastTick?.hour === hour;
			// Atomic batch creation precedes tick bookkeeping. Recover that batch after a crash.
			if (existsSync(batchFile)) {
				const existing = readHourlyBatch(batchFile, policy.repository, hour);
				policy.lastTick = {
					hour,
					status: "recovered",
					initialized: true,
					batchFile,
					tickets: existing.ticketOrder,
					recovered: true,
					helper: existing.selection.helper ?? null,
					capacity: capacity(anchor, policy.repository),
				};
			} else {
				const budget = capacity(anchor, policy.repository);
				const count = Math.min(policy.count, budget.admissionSlots);
				if (count === 0)
					policy.lastTick = {
						hour,
						status: "capacity-full",
						retried,
						initialized: false,
						tickets: [],
						reason: "capacity full",
						skipped: [
							{
								reason:
									"capacity full; wait for a managed ticket to release a slot",
							},
						],
						capacity: budget,
					};
				else {
					const request = {
						...policy,
						batchId,
						count,
						concurrency: Math.min(3, policy.count),
						models: input.models,
						codexModels: input.codexModels,
						fallbackStatePath: options.fallbackStatePath,
						excludeTickets: [
							...(policy.excludeTickets ?? []),
							...dynamicExclusions,
						],
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
							helper: activeHelper,
						};
						state.managedByIntake = true;
						atomicWrite(batchFile, state);
						policy.lastTick = {
							hour,
							status: "admitted",
							retried,
							initialized: true,
							batchFile,
							capacity: capacity(anchor, policy.repository),
							...selection,
						};
					} else
						policy.lastTick = {
							hour,
							status: "empty",
							retried,
							initialized: false,
							reason: "no eligible tickets",
							capacity: budget,
							...selection,
						};
				}
			}
			if (!("helper" in policy.lastTick)) policy.lastTick.helper = activeHelper;
			atomicWrite(path, policy);
			return policy.lastTick;
		} else throw new Error(`unknown intake command: ${command}`);
		atomicWrite(path, policy);
		return policy;
	});
	return { ...result, activeHelper };
}
