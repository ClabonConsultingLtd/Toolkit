import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

export const ACTIVE = new Set(["implementing", "reviewing"]);
export function issueNumber(value) {
	const text = String(value).replace(/^#/, "");
	if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text)))
		throw new Error(`invalid issue number: ${value}`);
	return text;
}
export function newBatch(input) {
	if (!/^[\w.-]+\/[\w.-]+$/.test(input.repository ?? ""))
		throw new Error("repository must be owner/name");
	if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(input.batchId ?? ""))
		throw new Error("batchId must be a lowercase slug");
	if (!Array.isArray(input.tickets) || !input.tickets.length)
		throw new Error("tickets must be a nonempty array");
	const tickets = input.tickets.map(issueNumber);
	if (new Set(tickets).size !== tickets.length)
		throw new Error("duplicate tickets");
	if (!input.baseBranch || !input.cwd || !input.codexModel)
		throw new Error("baseBranch, cwd and initiating codexModel are required");
	const concurrency = input.concurrency ?? 3;
	if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3)
		throw new Error("concurrency must be 1..3");
	return {
		version: 1,
		ticketOrder: tickets,
		repository: input.repository,
		batchId: input.batchId,
		cwd: resolve(input.cwd),
		baseBranch: input.baseBranch,
		codexModel: input.codexModel,
		concurrency,
		scheduleId: null,
		scheduleName: `tickets:${input.repository}:${input.batchId}`,
		cron: "*/30 8-19 * * *",
		timezone: "UTC",
		lease: null,
		tickets: Object.fromEntries(
			tickets.map((n) => [n, { number: n, status: "queued", fixCycles: 0 }]),
		),
	};
}
export function atomicWriteText(path, text) {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, text, { mode: 0o600 });
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}
export function atomicWrite(path, value) {
	atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`);
}
export function readState(path) {
	const state = JSON.parse(readFileSync(path, "utf8"));
	if (state.version !== 1 || !state.tickets)
		throw new Error("unsupported batch state");
	return state;
}
// Short filesystem mutex protects lease acquisition and every state transaction.
// Never steal this mutex automatically: a killed writer requires explicit operator recovery.
export function transaction(path, action) {
	const guard = `${path}.mutex`;
	mkdirSync(dirname(path), { recursive: true });
	try {
		mkdirSync(guard);
	} catch (error) {
		if (error.code === "EEXIST")
			throw new Error(
				`state busy; if a writer crashed, verify it exited before removing ${guard}`,
			);
		throw error;
	}
	try {
		const state = existsSync(path) ? readState(path) : null;
		const result = action(state);
		if (result.state) atomicWrite(path, result.state);
		return result.output;
	} finally {
		rmSync(guard, { recursive: true, force: true });
	}
}
export function assertLease(state, token, now = Date.now()) {
	if (!token || state.lease?.token !== token || state.lease.expiresAt <= now)
		throw new Error("lease missing, expired or owned by another run");
}
export function acquire(state, now = Date.now()) {
	if (state.lease?.expiresAt > now) return { acquired: false };
	state.lease = { token: randomUUID(), expiresAt: now + 600_000 };
	return { acquired: true, ...state.lease };
}
export function renew(state, token, now = Date.now()) {
	assertLease(state, token, now);
	state.lease.expiresAt = now + 600_000;
	return state.lease;
}
export function checkCycles(issues) {
	const visiting = new Set(),
		visited = new Set();
	function visit(n) {
		if (visiting.has(n)) throw new Error(`dependency cycle includes #${n}`);
		if (visited.has(n) || !issues[n]) return;
		visiting.add(n);
		for (const dep of issues[n].dependencies) visit(String(dep));
		visiting.delete(n);
		visited.add(n);
	}
	for (const n of Object.keys(issues)) visit(n);
}
export function blockers(state, issue, issues) {
	return issue.dependencies.filter((n) =>
		state.tickets[n]
			? state.tickets[n].status !== "completed"
			: issues[n]?.state !== "CLOSED",
	);
}
export function reconcile(state, issues) {
	checkCycles(issues);
	for (const ticket of Object.values(state.tickets)) {
		const issue = issues[ticket.number];
		if (!issue) throw new Error(`missing issue #${ticket.number}`);
		if (ticket.status === "completed") continue;
		if (
			ticket.status === "queued" ||
			ticket.blockKind === "readiness" ||
			ticket.blockKind === "dependency"
		) {
			const deps = blockers(state, issue, issues);
			const children = issue.subTickets ?? [];
			const reason =
				issue.state === "CLOSED"
					? "Issue closed without verified PR merge"
					: !issue.labels.includes("ready-for-agent")
						? "Issue is not ready-for-agent"
						: children.length
							? `Parent spec; implemented through sub-tickets ${children.map((n) => `#${n}`).join(", ")}`
							: deps.length
								? `Waiting for ${deps.map((n) => `#${n}`).join(", ")}`
								: null;
			ticket.status = reason ? "blocked" : "queued";
			ticket.reason = reason;
			ticket.blockKind =
				issue.state === "CLOSED"
					? "human"
					: children.length
						? "readiness"
						: deps.length
							? "dependency"
							: reason
								? "readiness"
								: null;
		}
	}
	return disposition(state);
}
export function disposition(state) {
	const tickets = (state.ticketOrder ?? Object.keys(state.tickets)).map(
		(n) => state.tickets[n],
	);
	const slots = Math.max(
		0,
		state.concurrency -
			tickets.filter((t) => ACTIVE.has(t.status) || t.workerActive).length,
	);
	const launchable = tickets
		.filter((t) => t.status === "queued")
		.slice(0, slots)
		.map((t) => t.number);
	function canProgress(t, seen = new Set()) {
		if (seen.has(t.number)) return false;
		if (t.status === "completed") return false;
		if (
			t.workerActive ||
			["queued", "implementing", "reviewing", "awaiting_merge"].includes(
				t.status,
			)
		)
			return true;
		if (t.blockKind !== "dependency") return false;
		// External dependencies may change without intervention in this batch.
		seen.add(t.number);
		return (t.dependencies ?? []).some(
			(n) => !state.tickets[n] || canProgress(state.tickets[n], seen),
		);
	}
	return {
		launchable,
		slots,
		pauseSchedule:
			tickets.every((t) => t.status === "completed") ||
			!tickets.some((t) => canProgress(t)),
		tickets: tickets.map(({ number, status, reason }) => ({
			number,
			status,
			reason,
		})),
	};
}
export function changeTicket(
	state,
	number,
	action,
	data = {},
	now = Date.now(),
) {
	const t = state.tickets[issueNumber(number)];
	if (!t) throw new Error("ticket outside selected batch");
	const requireStatus = (...statuses) => {
		if (!statuses.includes(t.status))
			throw new Error(`${action} invalid in ${t.status}`);
	};
	const requireText = (name) => {
		if (typeof data[name] !== "string" || !data[name].trim())
			throw new Error(`${name} required`);
	};
	if (action === "reserve") {
		requireStatus("queued");
		requireText("provider");
		requireText("thinkingOptionId");
		if (!data.provider.startsWith("claude/"))
			throw new Error("Claude provider/model required");
		if (!disposition(state).launchable.includes(t.number))
			throw new Error("no execution slot");
		Object.assign(t, {
			status: "implementing",
			workerActive: true,
			launchUncertain: true,
			provider: data.provider,
			thinkingOptionId: data.thinkingOptionId,
			branch: `tickets/${state.batchId}/${t.number}`,
			launchKey: `${state.repository}:${state.batchId}:${t.number}`,
			updatedAt: new Date(now).toISOString(),
		});
	} else if (action === "attach") {
		requireStatus("implementing", "blocked");
		if (data.workspaceId) {
			if (t.workspaceId && t.workspaceId !== data.workspaceId)
				throw new Error("workspace already attached");
			t.workspaceId = data.workspaceId;
		}
		if (data.agentId) {
			if (!t.workspaceId) throw new Error("attach workspace first");
			if (t.agentId && t.agentId !== data.agentId)
				throw new Error("agent already attached");
			t.agentId = data.agentId;
			t.launchUncertain = false;
		}
		if (data.workerActive === true) {
			if (!t.agentId) throw new Error("agent must be attached");
			t.workerActive = true;
			t.updatedAt = new Date(now).toISOString();
		}
	} else if (action === "review") {
		requireStatus("implementing");
		requireText("evidence");
		if (!t.agentId) throw new Error("agent must be attached");
		Object.assign(t, {
			status: "reviewing",
			workerActive: false,
			evidence: data.evidence,
			updatedAt: new Date(now).toISOString(),
		});
	} else if (action === "fix") {
		requireStatus("reviewing");
		requireText("reason");
		if (t.fixCycles >= 2)
			Object.assign(t, {
				status: "blocked",
				previousStatus: "reviewing",
				blockKind: "human",
				repairLimitReached: true,
				reason: data.reason,
				updatedAt: new Date(now).toISOString(),
			});
		else {
			t.fixCycles++;
			Object.assign(t, {
				status: "implementing",
				workerActive: true,
				reason: data.reason,
				updatedAt: new Date(now).toISOString(),
			});
		}
	} else if (action === "ready") {
		requireStatus("reviewing");
		requireText("evidence");
		requireText("reviewedHead");
		if (!t.pr) throw new Error("verified PR must be attached first");
		Object.assign(t, {
			status: "awaiting_merge",
			workerActive: false,
			evidence: data.evidence,
			reviewedHead: data.reviewedHead,
			reason: null,
			updatedAt: new Date(now).toISOString(),
		});
	} else if (action === "block") {
		if (t.status === "completed")
			throw new Error("completed ticket cannot be blocked");
		requireText("reason");
		Object.assign(t, {
			previousStatus: t.status === "blocked" ? t.previousStatus : t.status,
			status: "blocked",
			blockKind: "human",
			reason: data.reason,
			updatedAt: new Date(now).toISOString(),
		});
		// A permission wait or uncertain launch still consumes a slot until confirmed stopped.
		if (data.workerStopped === true) t.workerActive = false;
	} else if (action === "resume") {
		requireStatus("blocked");
		requireText("evidence");
		if (t.launchUncertain)
			throw new Error("reconcile the uncertain launch before resuming");
		const repairLimitBlock =
			t.repairLimitReached === true ||
			(t.fixCycles >= 2 && t.previousStatus !== "implementing");
		if (repairLimitBlock && data.resetFixCycles !== true)
			throw new Error("explicit resetFixCycles required after repair limit");
		if (data.resetFixCycles) t.fixCycles = 0;
		const next = t.previousStatus ?? (t.agentId ? "reviewing" : "queued");
		if (ACTIVE.has(next) && !t.workerActive && disposition(state).slots === 0)
			throw new Error("no execution slot to resume");
		t.status = next;
		t.blockKind = null;
		t.reason = null;
		delete t.repairLimitReached;
		t.updatedAt = new Date(now).toISOString();
	} else throw new Error(`unknown ticket action: ${action}`);
	return t;
}
