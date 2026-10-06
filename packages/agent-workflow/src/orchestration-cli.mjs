import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { readRepositoryIntakeConfig } from "./intake-config.mjs";
import {
	acquire,
	assertLease,
	changeTicket,
	checkCycles,
	disposition,
	newBatch,
	PROVIDER_LIMIT,
	readState,
	reconcile,
	renew,
	transaction,
} from "./orchestration.mjs";
import {
	mergeState,
	requireMergeable,
	requireNoReportedFailures,
	requirePassingChecks,
} from "./orchestration-checks.mjs";
import {
	checkApproval,
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

// A resumed Claude worker would hit the limit again while the shared cooldown lasts.
function claudeLimitPending(ticket, options) {
	return (
		ticket.blockKind === PROVIDER_LIMIT &&
		ticket.provider?.startsWith("claude/") &&
		readClaudeCooldown(options.fallbackStatePath ?? fallbackStatePath()).active
	);
}
// Repository scripts always run from the stable checkout, never from a
// worker's worktree, so PR code never runs with the controller's permissions.
function checkoutScript(cwd, relative, label) {
	const checkout = realpathSync(cwd);
	const script = realpathSync(resolve(checkout, relative));
	if (!script.startsWith(`${checkout}${sep}`))
		throw new Error(`${label} escapes the checkout`);
	return script;
}
function repositoryConfigFor(state) {
	const config = readRepositoryIntakeConfig(state.cwd);
	if (
		config &&
		config.repository.toLowerCase() !== state.repository.toLowerCase()
	)
		throw new Error("repository intake config belongs to another repository");
	return config;
}
// A ticket placed on a worker host launches through that host's Paseo daemon.
// The host must still be configured, and the issue must still be free of the
// labels the host excludes, or the reservation is refused before any mutation.
function workerHostFor(path, state, ticket, issue) {
	if (!ticket.host) return null;
	const hosts =
		repositoryConfigFor(state)?.workerHosts ??
		readIntake(path)?.workerHosts ??
		[];
	const host = hosts.find((h) => h.id === ticket.host);
	if (!host)
		throw new Error(
			`worker host ${ticket.host} is no longer configured; block the ticket or restore the host`,
		);
	const excluded = host.excludeLabels.filter((l) => issue.labels.includes(l));
	if (excluded.length)
		throw new Error(
			`worker host ${host.id} excludes label ${excluded.join(", ")}; block the ticket for a human`,
		);
	const { excludeLabels, count, ...launch } = host;
	return launch;
}
// The worktree of a ticket on a worker host is on another machine, so the
// controller cannot run the hook here. The first call returns the exact command
// to run there, from that host's stable checkout as it would be locally; the
// second, with `remoteResult`, records what happened. Like the local hook it
// never changes the ticket's lifecycle state.
function remoteCleanup(state, t, config, input) {
	if (
		typeof input.worktreePath !== "string" ||
		!input.worktreePath.startsWith("/")
	)
		throw new Error("worktreePath must be an absolute path on the worker host");
	const host = (config.workerHosts ?? []).find((h) => h.id === t.host);
	if (!host) throw new Error(`worker host ${t.host} is no longer configured`);
	if (input.remoteResult === undefined)
		return {
			output: {
				ticket: t.number,
				ran: false,
				host: host.id,
				paseoHost: host.paseoHost,
				command: [
					"node",
					`${host.cwd}/${config.cleanupCommand}`,
					input.worktreePath,
					t.branch,
					t.number,
				],
			},
		};
	const { ok, error } = input.remoteResult;
	if (typeof ok !== "boolean")
		throw new Error("remoteResult.ok must be a boolean");
	const failure = ok
		? {}
		: { error: String(error ?? "remote cleanup failed").trim() };
	t.cleanup = { at: new Date().toISOString(), ok, host: host.id, ...failure };
	return {
		state,
		output: { ticket: t.number, ran: true, ok, host: host.id, ...failure },
	};
}
function worktreeBranch(worktree) {
	try {
		return execFileSync("git", ["symbolic-ref", "--short", "-q", "HEAD"], {
			cwd: worktree,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}
const CLEANUP_TIMEOUT = 120_000;
// Runs the repository's cleanupCommand against one ticket's worktree, e.g. to
// remove Compose projects a worker or review started there. A failure is
// recorded and reported but never changes the ticket's lifecycle state. The
// hook runs outside the state mutex so a slow teardown does not block others.
function cleanup(path, input, options) {
	const number = String(input.number ?? "").replace(/^#/, "");
	const prepared = transaction(path, (state) => {
		if (!state) throw new Error("initialize batch first");
		assertLease(state, input.token);
		const t = state.tickets[number];
		if (!t?.branch) throw new Error("reserve ticket first");
		const config = repositoryConfigFor(state);
		if (!config?.cleanupCommand)
			return { output: { ticket: t.number, ran: false } };
		if (t.host) return remoteCleanup(state, t, config, input);
		if (
			typeof input.worktreePath !== "string" ||
			!isAbsolute(input.worktreePath)
		)
			throw new Error("worktreePath must be an absolute path");
		const worktree = realpathSync(input.worktreePath);
		if (!statSync(worktree).isDirectory())
			throw new Error("worktreePath must be a directory");
		const branch = worktreeBranch(worktree);
		if (branch !== t.branch)
			throw new Error(
				`worktree is on ${branch || "a detached HEAD"}, not ${t.branch}`,
			);
		return {
			output: {
				ticket: t.number,
				branch: t.branch,
				worktree,
				script: checkoutScript(
					state.cwd,
					config.cleanupCommand,
					"cleanup command",
				),
			},
		};
	});
	if (!prepared.script) return prepared;
	let error = null;
	try {
		execFileSync(
			process.execPath,
			[
				prepared.script,
				prepared.worktree,
				prepared.branch,
				String(prepared.ticket),
			],
			{
				cwd: prepared.worktree,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: options.cleanupTimeout ?? CLEANUP_TIMEOUT,
			},
		);
	} catch (failure) {
		error = (
			failure.signal
				? `timed out or killed (${failure.signal})`
				: failure.stderr || failure.message
		).trim();
	}
	return transaction(path, (state) => {
		assertLease(state, input.token);
		state.tickets[number].cleanup = {
			at: new Date().toISOString(),
			ok: !error,
			...(error ? { error } : {}),
		};
		return {
			state,
			output: {
				ticket: prepared.ticket,
				ran: true,
				ok: !error,
				...(error ? { error } : {}),
			},
		};
	});
}
export function execute(command, path, input = {}, options = {}) {
	if (command === "cleanup") return cleanup(path, input, options);
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
					{ returnToTriage: true },
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
				// Recheck approval for every ticket that could start: an edit after
				// ready-for-agent returns it to needs-triage, and a missing trusted
				// brief keeps it blocked for readiness until one exists.
				for (const t of Object.values(state.tickets)) {
					const issue = issues[t.number];
					if (
						(t.status !== "queued" &&
							!["readiness", "dependency"].includes(t.blockKind)) ||
						issue.state !== "OPEN" ||
						!issue.labels.includes("ready-for-agent")
					)
						continue;
					const { refusal, brief } = checkApproval(api, t.number, {
						returnToTriage: true,
						beforeWrite: () => assertLease(state, input.token),
					});
					if (refusal)
						issue.approvalRefusal = `${refusal.reason}: ${refusal.detail}${refusal.returnedToTriage ? "; returned to needs-triage" : ""}`;
					else issue.brief = brief;
				}
				const baseUpdates = [];
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
						const merge = pr.state === "OPEN" ? mergeState(pr) : null;
						if (merge?.state === "conflicting" || merge?.state === "behind")
							baseUpdates.push({
								number: t.number,
								pr: pr.number,
								status: t.status,
								agentId: t.agentId ?? null,
								mergeState: merge.state,
								reason: merge.reason,
							});
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
					const workerHost = workerHostFor(path, state, t, issue);
					const runtime = resolveWorkerRuntime(issue.recommendation, input, {
						statePath: options.fallbackStatePath,
					});
					output = {
						...changeTicket(state, input.number, "reserve", runtime),
						brief: issue.brief,
						workerHost,
					};
				} else {
					output = { ...disposition(state), issues, baseUpdates };
					output.resumable = output.resumable.filter(
						(n) => !claudeLimitPending(state.tickets[n], options),
					);
					const budget = capacity(path, state.repository, state);
					if (budget.limit !== null) {
						output.slots = Math.min(output.slots, budget.executionSlots);
						let local = 0;
						const used = {};
						output.launchable = output.launchable.filter((n) => {
							const host = state.tickets[n].host;
							if (!host) return local++ < output.slots;
							const summary = budget.hosts?.[host];
							if (!summary || summary.limit === null) return false;
							used[host] = (used[host] ?? 0) + 1;
							return used[host] <= summary.executionSlots;
						});
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
				requireMergeable(pr);
				if (command === "ready") {
					// requiredChecks and the local verification gate are enforced at
					// merge-ready instead: a check that only runs once the PR leaves
					// draft is legitimately missing or "skipped" here.
					requireNoReportedFailures(pr.statusCheckRollup ?? []);
					output = changeTicket(state, input.number, command, input);
				} else {
					if (t.status !== "awaiting_merge")
						throw new Error("ticket is not awaiting merge");
					if (pr.isDraft) throw new Error("PR is still a draft");
					const policy = readIntake(path);
					if (
						policy &&
						policy.repository.toLowerCase() !== state.repository.toLowerCase()
					)
						throw new Error("intake policy belongs to another repository");
					const repositoryConfig = repositoryConfigFor(state);
					let required =
						repositoryConfig?.requiredChecks ?? policy?.requiredChecks;
					if (required === undefined) {
						try {
							required = api.requiredStatusChecks(state.baseBranch);
						} catch (error) {
							throw new Error(
								error.code === "BRANCH_PROTECTION_UNAVAILABLE"
									? `required checks not configured: ${error.message}. Set requiredChecks in toolkit-intake.json; retrying will not help`
									: `required checks not configured and branch protection is unavailable: ${error.message}`,
							);
						}
					}
					requirePassingChecks(pr.statusCheckRollup ?? [], required);
					if (repositoryConfig?.localVerificationCommand) {
						const gate = checkoutScript(
							state.cwd,
							repositoryConfig.localVerificationCommand,
							"local verification gate",
						);
						try {
							execFileSync(
								process.execPath,
								[gate, String(pr.number), pr.headRefOid],
								{
									cwd: state.cwd,
									encoding: "utf8",
									timeout: 30_000,
								},
							);
						} catch (error) {
							throw new Error(
								`local verification gate refused PR #${pr.number} at ${pr.headRefOid}: ${(error.stderr || error.message).trim()}`,
							);
						}
					}
					output = {
						mergeReady: true,
						pr: pr.number,
						head: pr.headRefOid,
						requiredChecks: required,
					};
				}
			} else {
				const t = state.tickets[String(input.number).replace(/^#/, "")];
				if (
					command === "resume" &&
					input.evidence === undefined &&
					t &&
					claudeLimitPending(t, options)
				)
					throw new Error("Claude cooldown still active; wait for its reset");
				output = changeTicket(state, input.number, command, input);
			}
			if (["reserve", "resume", "fix", "update-base"].includes(command))
				enforceCapacity(path, state, previousActive);
			assertLease(state, input.token);
			return { state, output };
		});
	const mutatesCapacity =
		["reserve", "resume", "fix", "update-base"].includes(command) ||
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
