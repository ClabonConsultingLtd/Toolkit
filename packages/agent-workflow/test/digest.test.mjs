import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { changeTicket, newBatch } from "../src/orchestration.mjs";
import {
	batchDigest,
	buildDigest,
	discoverBatchFiles,
	modelsMatch,
	readBatches,
	readCursor,
	renderMarkdown,
	ticketRecord,
	writeCursor,
} from "../src/digest.mjs";
import { fetchRecommendation, run } from "../src/digest-cli.mjs";

const runtime = { provider: "claude/claude-sonnet-5", thinkingOptionId: "medium" };
function fixtureState() {
	const s = newBatch({
		repository: "example/project",
		batchId: "pilot",
		cwd: "/tmp/project",
		baseBranch: "main",
		codexModel: "test-codex",
		tickets: [7, 8, 9],
	});
	changeTicket(s, 7, "reserve", runtime, 1_000);
	changeTicket(s, 7, "attach", { workspaceId: "w7", agentId: "a7" }, 1_000);
	changeTicket(s, 7, "review", { evidence: "tests" }, 2_000);
	changeTicket(s, 7, "fix", { reason: "flaky" }, 3_000);
	changeTicket(s, 7, "review", { evidence: "tests" }, 4_000);
	changeTicket(s, 7, "fix", { reason: "still flaky" }, 5_000);
	changeTicket(s, 7, "review", { evidence: "tests" }, 6_000);
	changeTicket(s, 7, "fix", { reason: "third strike" }, 7_000);
	changeTicket(s, 8, "reserve", { ...runtime, thinkingOptionId: "high" }, 7_000);
	changeTicket(s, 8, "attach", { workspaceId: "w8", agentId: "a8" }, 7_000);
	return s;
}
function fixtureDir(t) {
	const dir = mkdtempSync(join(tmpdir(), "digest-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("discoverBatchFiles finds batch state, ignores mutex/tmp artifacts", (t) => {
	const dir = fixtureDir(t);
	writeFileSync(join(dir, "pilot.json"), "{}");
	writeFileSync(join(dir, "pilot.json.abc.tmp"), "{}");
	mkdirSync(join(dir, "pilot.json.mutex"));
	assert.deepEqual(discoverBatchFiles(dir), [join(dir, "pilot.json")]);
	assert.deepEqual(discoverBatchFiles(join(dir, "missing")), []);
});
test("readBatches parses every discovered state file", (t) => {
	const dir = fixtureDir(t);
	const s = fixtureState();
	writeFileSync(join(dir, "pilot.json"), JSON.stringify(s));
	const [read] = readBatches(dir);
	assert.equal(read.batchId, "pilot");
	assert.equal(Object.keys(read.tickets).length, 3);
});
test("readCursor defaults when absent; round-trips through writeCursor", (t) => {
	const dir = fixtureDir(t);
	const path = join(dir, "cursor.json");
	assert.deepEqual(readCursor(path), { lastDigestAt: null });
	writeCursor(path, { lastDigestAt: "2026-09-20T00:00:00.000Z" });
	assert.deepEqual(readCursor(path), { lastDigestAt: "2026-09-20T00:00:00.000Z" });
});
test("ticketRecord flags fix-cycle cap, recommendation mismatch and stuck tickets", () => {
	const ticket = {
		number: "7",
		status: "blocked",
		fixCycles: 2,
		provider: "claude/claude-sonnet-5",
		thinkingOptionId: "medium",
		updatedAt: new Date(0).toISOString(),
	};
	const record = ticketRecord(ticket, {
		now: 25 * 3_600_000,
		stuckHours: 24,
		cost: { tokenCost: 1200, turnCost: 6 },
		recommendation: { model: "claude-sonnet-5", effort: "high" },
	});
	assert.equal(record.fixCycleCapped, true);
	assert.equal(record.recommendationMismatch, true);
	assert.equal(record.anomalous, true);
	assert.equal(record.tokenCost, 1200);
	assert.equal(record.turnCost, 6);
	const fresh = ticketRecord(ticket, {
		now: 1_000,
		stuckHours: 24,
		cost: null,
		recommendation: null,
	});
	assert.equal(fresh.anomalous, false);
	assert.equal(fresh.recommendationMismatch, false);
});
test("modelsMatch resolves a family-name recommendation against the resolved model id, exact ids elsewhere", () => {
	assert.equal(modelsMatch("Sonnet", "claude-sonnet-5"), true);
	assert.equal(modelsMatch("sonnet", "claude-sonnet-4-6"), true);
	assert.equal(modelsMatch("Sonnet", "claude-opus-5"), false);
	assert.equal(modelsMatch("claude-sonnet-5", "claude-sonnet-5"), true);
	assert.equal(modelsMatch("claude-sonnet-5", "claude-sonnet-4-6"), false);
});
test("ticketRecord does not flag a recommendation mismatch when the family-name recommendation matches the resolved model", () => {
	const record = ticketRecord(
		{
			number: "7",
			status: "reviewing",
			fixCycles: 0,
			provider: "claude/claude-sonnet-5",
			thinkingOptionId: "medium",
		},
		{
			now: 1_000,
			stuckHours: 24,
			cost: null,
			recommendation: { model: "Sonnet", effort: "medium" },
		},
	);
	assert.equal(record.recommendationMismatch, false);
});
test("ticketRecord treats a missing updatedAt as unknown, never anomalous", () => {
	const record = ticketRecord(
		{ number: "9", status: "blocked", fixCycles: 0 },
		{ now: 1_000_000_000, stuckHours: 1, cost: null, recommendation: null },
	);
	assert.equal(record.updatedAt, null);
	assert.equal(record.anomalous, false);
});
test("batchDigest summary counts respect the cursor; ticket list reports every ticket", () => {
	const s = fixtureState();
	const digest = batchDigest(s, {
		now: 6_000,
		cursorTime: 3_500,
		stuckHours: 24,
		activity: () => null,
		recommendationFor: () => null,
	});
	assert.equal(digest.tickets.length, 3);
	assert.equal(digest.summary.blockedOnYou, 1);
	assert.equal(digest.summary.inFlight, 1);
	const untouched = batchDigest(s, {
		now: 6_000,
		cursorTime: 8_000,
		stuckHours: 24,
		activity: () => null,
		recommendationFor: () => null,
	});
	assert.equal(untouched.summary.blockedOnYou, 0);
	assert.equal(untouched.summary.inFlight, 0);
});
test("buildDigest merges batches and carries the cursor forward into `since`", () => {
	const digest = buildDigest([fixtureState()], {
		now: 10_000,
		cursor: { lastDigestAt: new Date(1_000).toISOString() },
		stuckHours: 24,
		activity: () => null,
		recommendationFor: () => null,
	});
	assert.equal(digest.since, new Date(1_000).toISOString());
	assert.equal(digest.batches.length, 1);
	assert.equal(digest.batches[0].batchId, "pilot");
});
test("renderMarkdown produces a table per batch with flags", () => {
	const digest = buildDigest([fixtureState()], {
		now: 10_000,
		activity: () => null,
		recommendationFor: (_state, ticket) =>
			ticket.number === "7" ? { model: "claude-opus-5", effort: "max" } : null,
	});
	const markdown = renderMarkdown(digest);
	assert.match(markdown, /# Ticket digest/);
	assert.match(markdown, /example\/project \/ pilot/);
	assert.match(markdown, /#7 \| blocked/);
	assert.match(markdown, /model-mismatch/);
	assert.match(markdown, /fix-cap/);
});
test("renderMarkdown reports batches with no tickets", () => {
	const digest = buildDigest(
		[
			newBatch({
				repository: "example/project",
				batchId: "empty",
				cwd: "/tmp/project",
				baseBranch: "main",
				codexModel: "test-codex",
				tickets: [1],
			}),
		],
		{ now: 1_000 },
	);
	digest.batches[0].tickets = [];
	assert.match(renderMarkdown(digest), /_No tickets\._/);
});
test("digest-cli run reads batch files, merges injected activity/recommendations, and advances the cursor", (t) => {
	const checkout = fixtureDir(t);
	const orchestrationDir = join(checkout, ".toolkit", "orchestration");
	mkdirSync(orchestrationDir, { recursive: true });
	writeFileSync(join(orchestrationDir, "pilot.json"), JSON.stringify(fixtureState()));
	const recommendationCalls = [];
	const result = run(
		checkout,
		{ now: 20_000, stuckHours: 24, activity: { a7: { tokenCost: 500, turnCost: 3 } } },
		{
			recommendationFor: (state, ticket) => {
				recommendationCalls.push(ticket.number);
				return ticket.number === "7"
					? { model: "claude-sonnet-5", effort: "medium" }
					: null;
			},
		},
	);
	assert.equal(result.batches[0].tickets.find((t) => t.number === "7").tokenCost, 500);
	assert.ok(recommendationCalls.includes("7"));
	assert.equal(
		recommendationCalls.includes("9"),
		false,
		"never reserved ticket 9 has no actual runtime to compare, so it should not trigger a gh lookup",
	);
	assert.match(result.markdown, /# Ticket digest/);
	const jsonOut = JSON.parse(
		readFileSync(join(checkout, ".toolkit", "report-tickets", "digest.json"), "utf8"),
	);
	assert.equal(jsonOut.batches[0].batchId, "pilot");
	const mdOut = readFileSync(
		join(checkout, ".toolkit", "report-tickets", "digest.md"),
		"utf8",
	);
	assert.match(mdOut, /# Ticket digest/);
	const cursor = readCursor(join(checkout, ".toolkit", "report-tickets", "cursor.json"));
	assert.equal(cursor.lastDigestAt, result.generatedAt);
});
test("fetchRecommendation parses the issue body via the injected gh executor", () => {
	const exec = (args) => {
		assert.deepEqual(args, [
			"issue",
			"view",
			"7",
			"--repo",
			"example/project",
			"--json",
			"body",
		]);
		return JSON.stringify({ body: "- **Claude:** `Sonnet / medium`" });
	};
	assert.deepEqual(fetchRecommendation("example/project", 7, exec), {
		model: "Sonnet",
		effort: "medium",
	});
});
