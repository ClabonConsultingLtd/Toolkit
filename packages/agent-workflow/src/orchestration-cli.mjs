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
import {
	github,
	requireReady,
	resolveRuntime,
	verifyPr,
} from "./orchestration-github.mjs";

export function execute(command, path, input = {}, options = {}) {
	const makeGitHub = options.github ?? github;
	if (command === "status") return readState(path);
	return transaction(path, (state) => {
		if (command === "init") {
			if (state) throw new Error("batch already exists; resume it");
			state = newBatch(input);
			return { state, output: state };
		}
		if (!state) throw new Error("initialize batch first");
		if (command === "acquire") return { state, output: acquire(state) };
		assertLease(state, input.token);
		let output;
		const api = makeGitHub(state.repository);
		if (command === "renew") output = renew(state, input.token);
		else if (command === "release") {
			state.lease = null;
			output = { released: true };
		} else if (command === "sync" || command === "reserve") {
			const issues = api.snapshot(state);
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
							reason: "PR closed without merge; human reconciliation required",
						});
					else if (
						t.status === "awaiting_merge" &&
						t.reviewedHead !== pr.headRefOid
					) {
						t.status = "blocked";
						t.blockKind = "human";
						t.previousStatus = "reviewing";
						t.reason = "PR head changed after review; resume for a new review";
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
				const runtime = resolveRuntime(issue.recommendation, input.models);
				output = changeTicket(state, input.number, "reserve", runtime);
			} else output = { ...disposition(state), issues };
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
		} else if (command === "ready") {
			const t = state.tickets[String(input.number)];
			if (!t?.pr) throw new Error("link PR first");
			const pr = api.pr(t.pr);
			verifyPr(state, t, pr);
			if (pr.state !== "OPEN" || pr.headRefOid !== input.reviewedHead)
				throw new Error("review must match current open PR head");
			const checks = pr.statusCheckRollup ?? [];
			if (
				checks.some(
					(c) =>
						(c.status && c.status !== "COMPLETED") ||
						(c.status &&
							!["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion)) ||
						(c.state && c.state !== "SUCCESS"),
				)
			)
				throw new Error("PR checks are pending or unsuccessful");
			output = changeTicket(state, input.number, command, input);
		} else output = changeTicket(state, input.number, command, input);
		if (command !== "release") assertLease(state, input.token);
		return { state, output };
	});
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
