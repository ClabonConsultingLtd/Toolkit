import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	acquire,
	assertLease,
	changeTicket,
	checkCycles,
	disposition,
	newBatch,
	readState,
	reconcile,
	renew,
	transaction,
} from "./orchestration.mjs";
import { requirePassingChecks } from "./orchestration-checks.mjs";
import {
	github,
	requireReady,
	resolveWorkerRuntime,
	verifyPr,
} from "./orchestration-github.mjs";
import {
	fallbackStatePath,
	readClaudeCooldown,
	recordClaudeLimit,
} from "./provider-fallback.mjs";
import {
	capacity,
	enforceCapacity,
	isInProgress,
	readIntake,
} from "./ticket-intake.mjs";
import {
	assertUnclaimed,
	selectNext,
	withSelectionLock,
} from "./ticket-selection.mjs";

export function execute(command, path, input = {}, options = {}) {
	if (command === "claude-cooldown")
		return readClaudeCooldown(options.fallbackStatePath ?? fallbackStatePath());
	if (command === "record-claude-limit")
		return recordClaudeLimit(
			options.fallbackStatePath ?? fallbackStatePath(),
			input.error,
			{ agentId: input.agentId, failureKey: input.failureKey },
		);
	const makeGitHub = options.github ?? github;
	if (command === "status") return readState(path);
	if (command === "select-next")
		return selectNext(
			path,
			{ ...input, fallbackStatePath: options.fallbackStatePath },
			makeGitHub(input.repository),
		);
	if (command === "init" || command === "init-next") {
		return withSelectionLock(path, () =>
			transaction(path, (existing) => {
				if (existing) throw new Error("batch already exists; resume it");
				if (command === "init") {
					const state = newBatch(input);
					assertUnclaimed(path, input);
					return { state, output: state };
				}
				const selection = selectNext(
					path,
					{ ...input, fallbackStatePath: options.fallbackStatePath },
					makeGitHub(input.repository),
				);
				if (!selection.tickets.length)
					return { output: { initialized: false, ...selection } };
				const state = newBatch({ ...input, tickets: selection.tickets });
				state.selection = {
					mode: "next",
					requestedCount: input.count,
					order: selection.order,
					selectedAt: new Date().toISOString(),
				};
				return { state, output: { initialized: true, ...selection, state } };
			}),
		);
	}
	const run = () =>
		transaction(path, (state) => {
			if (!state) throw new Error("initialize batch first");
			if (command === "acquire") return { state, output: acquire(state) };
			if (command === "release") {
				// An expired owner can still clean up if no later run acquired the
				// batch. Token equality fences it from clearing a successor's lease.
				if (!input.token || state.lease?.token !== input.token)
					throw new Error("lease missing or owned by another run");
				state.lease = null;
				return { state, output: { released: true } };
			}
			assertLease(state, input.token);
			const previousActive = Object.values(state.tickets).filter(
				isInProgress,
			).length;
			let output;
			const api = makeGitHub(state.repository);
			if (command === "renew") output = renew(state, input.token);
			else if (command === "sync" || command === "reserve") {
				const issues = api.snapshot(state);
				for (const ticket of Object.values(state.tickets))
					if (issues[ticket.number].dependencyError)
						changeTicket(state, ticket.number, "block", {
							reason: issues[ticket.number].dependencyError,
						});
				checkCycles(issues);
				for (const t of Object.values(state.tickets)) {
					t.dependencies = issues[t.number].dependencies;
					if (t.pr && t.status !== "completed") {
						const pr = api.pr(t.pr);
						verifyPr(state, t, pr);
						if (pr.state === "MERGED")
							api.finalize(state, t, () => assertLease(state, input.token));
						else if (pr.state === "CLOSED")
							changeTicket(state, t.number, "block", {
								reason:
									"PR closed without merge; human reconciliation required",
							});
						else if (
							t.status === "awaiting_merge" &&
							t.reviewedHead !== pr.headRefOid
						) {
							t.status = "blocked";
							t.blockKind = "human";
							t.previousStatus = "reviewing";
							t.reason =
								"PR head changed after review; resume for a new review";
						}
					}
				}
				for (const t of Object.values(state.tickets)) {
					if (
						issues[t.number].state === "CLOSED" &&
						t.status !== "completed" &&
						t.blockKind !== "human"
					)
						changeTicket(state, t.number, "block", {
							reason: "Issue closed without verified PR merge",
						});
				}
				reconcile(state, issues);
				if (command === "reserve") {
					const t = state.tickets[String(input.number).replace(/^#/, "")];
					if (!t) throw new Error("ticket outside selected batch");
					const issue = requireReady(state, t, issues);
					const runtime = resolveWorkerRuntime(issue.recommendation, input, {
						statePath: options.fallbackStatePath,
					});
					output = changeTicket(state, input.number, "reserve", runtime);
				} else {
					output = { ...disposition(state), issues };
					const budget = capacity(path, state.repository, state);
					if (budget.limit !== null) {
						output.slots = Math.min(output.slots, budget.executionSlots);
						output.launchable = output.launchable.slice(0, output.slots);
						output.repositoryCapacity = budget;
					}
				}
			} else if (command === "schedule") {
				if (!input.scheduleId) throw new Error("scheduleId required");
				if (state.scheduleId && state.scheduleId !== input.scheduleId)
					throw new Error("schedule already registered");
				state.scheduleId = input.scheduleId;
				output = state;
			} else if (command === "link-pr") {
				const t = state.tickets[String(input.number)];
				if (!t?.branch) throw new Error("reserve ticket first");
				if (t.pr && String(t.pr) !== String(input.pr))
					throw new Error("PR already linked");
				const pr = api.pr(input.pr);
				verifyPr(state, t, pr);
				t.pr = pr.number;
				t.prUrl = pr.url;
				output = t;
			} else if (command === "ready" || command === "merge-ready") {
				const t = state.tickets[String(input.number)];
				if (!t?.pr) throw new Error("link PR first");
				const pr = api.pr(t.pr);
				verifyPr(state, t, pr);
				const reviewedHead =
					command === "ready" ? input.reviewedHead : t.reviewedHead;
				if (pr.state !== "OPEN" || pr.headRefOid !== reviewedHead)
					throw new Error("review must match current open PR head");
				const policy = readIntake(path);
				if (
					policy &&
					policy.repository.toLowerCase() !== state.repository.toLowerCase()
				)
					throw new Error("intake policy belongs to another repository");
				let required = policy?.requiredChecks;
				if (command === "merge-ready") {
					if (t.status !== "awaiting_merge")
						throw new Error("ticket is not awaiting merge");
					if (pr.isDraft) throw new Error("PR is still a draft");
					if (required === undefined) {
						try {
							required = api.requiredStatusChecks(state.baseBranch);
						} catch (error) {
							throw new Error(
								`required checks not configured and branch protection is unavailable: ${error.message}`,
							);
						}
					}
				}
				requirePassingChecks(pr.statusCheckRollup ?? [], required);
				output =
					command === "ready"
						? changeTicket(state, input.number, command, input)
						: {
								mergeReady: true,
								pr: pr.number,
								head: pr.headRefOid,
								requiredChecks: required,
							};
			} else output = changeTicket(state, input.number, command, input);
			if (["reserve", "resume", "fix"].includes(command))
				enforceCapacity(path, state, previousActive);
			assertLease(state, input.token);
			return { state, output };
		});
	const mutatesCapacity =
		["reserve", "resume", "fix"].includes(command) ||
		(command === "attach" && input.workerActive === true);
	return mutatesCapacity ? withSelectionLock(path, run) : run();
}
export function main(args = process.argv.slice(2)) {
	try {
		const [command, file, request] = args;
		if (!command || !file || args.length > 3)
			throw new Error("usage: orchestrate COMMAND STATE.json [REQUEST.json|-]");
		const input = request
			? JSON.parse(readFileSync(request === "-" ? 0 : request, "utf8"))
			: {};
		console.log(
			JSON.stringify(execute(command, resolve(file), input), null, 2),
		);
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
	main();
