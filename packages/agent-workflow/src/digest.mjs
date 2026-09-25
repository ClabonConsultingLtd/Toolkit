import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ACTIVE, atomicWrite } from "./orchestration.mjs";

export function discoverBatchFiles(orchestrationDir) {
	if (!existsSync(orchestrationDir)) return [];
	return readdirSync(orchestrationDir)
		.filter((name) => name.endsWith(".json"))
		.map((name) => join(orchestrationDir, name))
		.sort();
}
export function readBatches(orchestrationDir) {
	return discoverBatchFiles(orchestrationDir).map((path) =>
		JSON.parse(readFileSync(path, "utf8")),
	);
}
export function readCursor(path) {
	if (!existsSync(path)) return { lastDigestAt: null };
	return JSON.parse(readFileSync(path, "utf8"));
}
export function writeCursor(path, cursor) {
	atomicWrite(path, cursor);
}
function sinceCursor(updatedAt, cursorTime) {
	if (cursorTime == null) return true;
	if (!updatedAt) return false;
	return new Date(updatedAt).getTime() > cursorTime;
}
const FAMILIES = ["sonnet", "opus", "haiku"];
// Mirrors resolveRuntime's own matching in orchestration-github.mjs: an exact
// id/label match, or a bare family name resolving to any numbered model in
// that family (the digest has no model catalog to resolve a family to the
// exact id that was actually launched).
export function modelsMatch(recommendedModel, actualModel) {
	const wanted = recommendedModel.toLowerCase();
	const got = actualModel.toLowerCase();
	if (wanted === got) return true;
	return (
		FAMILIES.includes(wanted) &&
		new RegExp(`^claude-${wanted}-[\\d-]+$`).test(got)
	);
}
export function ticketRecord(
	ticket,
	{ now, stuckHours, cost, recommendation },
) {
	const actual = ticket.provider
		? {
				model: ticket.provider.replace(/^claude\//, ""),
				effort: ticket.thinkingOptionId ?? null,
			}
		: null;
	const codexFallback = ticket.provider?.startsWith("codex/") === true;
	const stuck =
		ticket.status !== "completed" &&
		!!ticket.updatedAt &&
		now - new Date(ticket.updatedAt).getTime() > stuckHours * 3_600_000;
	return {
		number: ticket.number,
		status: ticket.status,
		blockKind: ticket.blockKind ?? null,
		fixCycles: ticket.fixCycles ?? 0,
		updatedAt: ticket.updatedAt ?? null,
		tokenCost: cost?.tokenCost ?? null,
		turnCost: cost?.turnCost ?? null,
		recommendation: recommendation ?? null,
		actual,
		codexFallback,
		fixCycleCapped: (ticket.fixCycles ?? 0) >= 2,
		recommendationMismatch:
			!!recommendation &&
			!!actual &&
			(codexFallback
				? ticket.fallbackFrom?.toLowerCase() !==
					`${recommendation.model} / ${recommendation.effort}`.toLowerCase()
				: !modelsMatch(recommendation.model, actual.model) ||
					recommendation.effort !== actual.effort),
		anomalous: stuck,
	};
}
// A completed ticket's PR was verified merged into the batch base, so its
// worktree and agent can be archived. Report only; the user archives them.
export function archivableTickets(state) {
	return Object.values(state.tickets)
		.filter(
			(t) =>
				t.status === "completed" &&
				!!t.mergedAt &&
				!!(t.workspaceId || t.agentId),
		)
		.map((t) => ({
			number: t.number,
			pr: t.prUrl ?? t.pr ?? null,
			branch: t.branch ?? null,
			workspaceId: t.workspaceId ?? null,
			agentId: t.agentId ?? null,
			mergedAt: t.mergedAt,
		}));
}
export function batchDigest(state, options) {
	const tickets = Object.values(state.tickets).map((t) =>
		ticketRecord(t, {
			now: options.now,
			stuckHours: options.stuckHours,
			cost: t.agentId ? (options.activity?.(t.agentId) ?? null) : null,
			// Recommendation-vs-actual only means anything once a ticket has an
			// actual runtime; skip the gh lookup for queued/unreserved tickets.
			recommendation: t.provider
				? (options.recommendationFor?.(state, t) ?? null)
				: null,
		}),
	);
	const touched = (t) => sinceCursor(t.updatedAt, options.cursorTime);
	return {
		batchId: state.batchId,
		repository: state.repository,
		summary: {
			completed: tickets.filter((t) => t.status === "completed" && touched(t))
				.length,
			inFlight: tickets.filter(
				(t) =>
					(ACTIVE.has(t.status) || t.status === "awaiting_merge") && touched(t),
			).length,
			blockedOnYou: tickets.filter(
				(t) => t.status === "blocked" && t.blockKind === "human" && touched(t),
			).length,
		},
		tickets,
		archivable: archivableTickets(state),
	};
}
export function buildDigest(states, options = {}) {
	const now = options.now ?? Date.now();
	const cursorTime = options.cursor?.lastDigestAt
		? new Date(options.cursor.lastDigestAt).getTime()
		: null;
	const stuckHours = options.stuckHours ?? 24;
	return {
		generatedAt: new Date(now).toISOString(),
		since: options.cursor?.lastDigestAt ?? null,
		batches: states.map((state) =>
			batchDigest(state, {
				now,
				cursorTime,
				stuckHours,
				activity: options.activity,
				recommendationFor: options.recommendationFor,
			}),
		),
	};
}
export function renderMarkdown(digest) {
	const lines = [
		"# Ticket digest",
		"",
		`Generated ${digest.generatedAt}${digest.since ? ` (since ${digest.since})` : ""}`,
		"",
	];
	for (const batch of digest.batches) {
		lines.push(`## ${batch.repository} / ${batch.batchId}`, "");
		lines.push(
			`Completed: ${batch.summary.completed} · In-flight: ${batch.summary.inFlight} · Blocked on you: ${batch.summary.blockedOnYou}`,
			"",
		);
		if (!batch.tickets.length) {
			lines.push("_No tickets._", "");
			continue;
		}
		lines.push(
			"| # | Status | Fix cycles | Updated | Tokens | Turns | Recommendation | Actual | Flags |",
			"| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
		);
		const fmt = (rec) => (rec ? `${rec.model}/${rec.effort}` : "—");
		for (const t of batch.tickets) {
			const flags = [
				t.fixCycleCapped ? "fix-cap" : null,
				t.codexFallback ? "codex-fallback" : null,
				t.recommendationMismatch ? "model-mismatch" : null,
				t.anomalous ? "stuck" : null,
			]
				.filter(Boolean)
				.join(", ");
			lines.push(
				`| #${t.number} | ${t.status} | ${t.fixCycles} | ${t.updatedAt ?? "—"} | ${t.tokenCost ?? "—"} | ${t.turnCost ?? "—"} | ${fmt(t.recommendation)} | ${fmt(t.actual)} | ${flags || "—"} |`,
			);
		}
		lines.push("");
		if (batch.archivable?.length)
			lines.push(
				"Merged; worktrees can be archived (left to you):",
				"",
				...batch.archivable.map(
					(a) =>
						`- #${a.number}: ${[
							a.pr && `PR ${a.pr}`,
							a.branch && `branch \`${a.branch}\``,
							a.workspaceId && `workspace \`${a.workspaceId}\``,
							a.agentId && `agent \`${a.agentId}\``,
						]
							.filter(Boolean)
							.join(", ")}`,
				),
				"",
			);
	}
	return lines.join("\n");
}
