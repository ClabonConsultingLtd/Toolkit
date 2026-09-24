import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ticketRecord } from "../src/digest.mjs";
import { execute } from "../src/orchestration-cli.mjs";
import { resolveWorkerRuntime } from "../src/orchestration-github.mjs";
import {
	parseClaudeLimit,
	readClaudeCooldown,
	recordClaudeLimit,
	resolveCodexFallback,
} from "../src/provider-fallback.mjs";

const claudeModels = [
	{ id: "claude-sonnet-5", label: "Sonnet 5", thinkingOptionIds: ["medium"] },
];
const codexModels = [
	{ id: "gpt-6-astra", thinkingOptionIds: ["low", "high", "ultra"] },
	{ id: "gpt-6-sol", thinkingOptionIds: ["low", "medium", "high"] },
	{ id: "gpt-6-luna", thinkingOptionIds: ["low", "medium"] },
];
function fixture(t) {
	const dir = mkdtempSync(join(tmpdir(), "provider-fallback-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return { dir, cooldownPath: join(dir, "shared", "claude.json") };
}

test("only explicit Claude usage-limit errors trigger a cooldown", (t) => {
	const f = fixture(t);
	for (const message of [
		"HTTP 429",
		"GitHub API rate limit exceeded",
		"Claude OAuth expired",
		"Claude overloaded",
	])
		assert.equal(parseClaudeLimit(message), null);
	assert.throws(
		() =>
			recordClaudeLimit(f.cooldownPath, "HTTP 429", { failureKey: "first" }),
		/explicit Claude/,
	);
	assert.equal(existsSync(f.cooldownPath), false);
	const now = Date.parse("2026-09-24T12:00:00Z");
	const state = recordClaudeLimit(
		f.cooldownPath,
		"You've hit your limit; resets at 2026-09-24T14:30:00Z",
		{ agentId: "worker-7", failureKey: "worker-7:turn-1", now },
	);
	assert.equal(state.resetAt, "2026-09-24T14:30:00.000Z");
	assert.equal(state.agentId, "worker-7");
	assert.equal(readClaudeCooldown(f.cooldownPath, now + 1).active, true);
	assert.equal(
		readClaudeCooldown(f.cooldownPath, Date.parse(state.resetAt)).active,
		false,
	);
	assert.equal(
		readFileSync(f.cooldownPath, "utf8").includes("You've hit"),
		false,
	);
});

test("Claude session-limit wording uses its stated UTC reset time", (t) => {
	const f = fixture(t);
	const now = Date.parse("2026-09-24T14:38:53Z");
	const message = "You've hit your session limit · resets 6:20pm (UTC)";
	assert.deepEqual(parseClaudeLimit(message, now), {
		resetAt: Date.parse("2026-09-24T18:20:00Z"),
	});
	const state = recordClaudeLimit(f.cooldownPath, message, {
		failureKey: "worker-166:activity-2284",
		now,
	});
	assert.equal(state.resetAt, "2026-09-24T18:20:00.000Z");
	assert.equal(readClaudeCooldown(f.cooldownPath, now).active, true);
	assert.equal(
		readClaudeCooldown(f.cooldownPath, Date.parse(state.resetAt)).active,
		false,
	);
	assert.deepEqual(
		parseClaudeLimit(message, Date.parse("2026-09-24T18:21:00Z")),
		{ resetAt: Date.parse("2026-09-25T18:20:00Z") },
	);
});

test("unknown reset uses one hour, repeated signals cannot shorten it, and a held lock fails safely", (t) => {
	const f = fixture(t);
	const now = Date.parse("2026-09-24T12:00:00Z");
	const first = recordClaudeLimit(
		f.cooldownPath,
		"You've reached your usage limit",
		{ failureKey: "worker-1:turn-1", now },
	);
	assert.equal(first.resetAt, "2026-09-24T13:00:00.000Z");
	const later = recordClaudeLimit(
		f.cooldownPath,
		"Claude usage limit reached; resets at 2026-09-24T12:15:00Z",
		{ failureKey: "worker-2:turn-1", now: now + 1000 },
	);
	assert.equal(later.resetAt, first.resetAt);
	mkdirSync(`${f.cooldownPath}.mutex`);
	assert.throws(
		() =>
			recordClaudeLimit(f.cooldownPath, "You've hit your limit", {
				failureKey: "worker-3:turn-1",
				now,
			}),
		/busy/,
	);
	assert.equal(readClaudeCooldown(f.cooldownPath, now).resetAt, first.resetAt);
	rmSync(`${f.cooldownPath}.mutex`, { recursive: true });
	assert.equal(
		recordClaudeLimit(f.cooldownPath, "You've hit your limit", {
			failureKey: "worker-1:turn-1",
			now: now + 2 * 3600000,
		}).active,
		false,
	);
	assert.equal(
		readClaudeCooldown(f.cooldownPath, now + 2 * 3600000).active,
		false,
	);
});

test("Codex fallback maps Claude capability and effort to advertised models", () => {
	assert.deepEqual(
		resolveCodexFallback({ model: "Opus 5", effort: "ultracode" }, codexModels),
		{
			provider: "codex/gpt-6-astra",
			thinkingOptionId: "ultra",
			fallbackFrom: "Opus 5 / ultracode",
		},
	);
	assert.equal(
		resolveCodexFallback({ model: "Fable 5.1", effort: "high" }, codexModels)
			.provider,
		"codex/gpt-6-astra",
	);
	assert.equal(
		resolveCodexFallback({ model: "Sonnet", effort: "medium" }, codexModels)
			.provider,
		"codex/gpt-6-sol",
	);
	assert.equal(
		resolveCodexFallback({ model: "Haiku", effort: "off" }, codexModels)
			.thinkingOptionId,
		"low",
	);
	assert.equal(
		resolveCodexFallback({ model: "Sonnet", effort: "medium" }, [
			{
				id: "gpt-6-sol",
				thinkingOptions: "low, medium, high",
				thinkingOptionIds: ["low", "medium", "high"],
			},
		]).provider,
		"codex/gpt-6-sol",
	);
	assert.throws(
		() =>
			resolveCodexFallback(
				{ model: "Haiku", effort: "ultracode" },
				codexModels,
			),
		/unsupported Codex fallback/,
	);
});

test("one shared cooldown changes new reservations in separate repositories and expires", (t) => {
	const f = fixture(t);
	const options = {
		fallbackStatePath: f.cooldownPath,
		github: () => ({
			listReady: () => [{ number: 7, created_at: "2026-01-01" }],
			issue: () => ({
				number: "7",
				state: "OPEN",
				labels: ["ready-for-agent"],
				assignees: [],
				dependencies: [],
				recommendation: { model: "Sonnet", effort: "medium" },
			}),
			hasImplementationPr: () => false,
			subTickets: () => [],
			snapshot: () => ({
				7: {
					number: "7",
					state: "OPEN",
					labels: ["ready-for-agent"],
					dependencies: [],
					recommendation: { model: "Sonnet", effort: "medium" },
				},
			}),
		}),
	};
	const batch = (repo, id) => ({
		repository: repo,
		batchId: id,
		cwd: f.dir,
		baseBranch: "main",
		codexModel: "gpt-6-sol",
		tickets: [7],
	});
	const pathA = join(f.dir, "repo-a", "batch.json"),
		pathB = join(f.dir, "repo-b", "batch.json");
	execute("init", pathA, batch("example/a", "a"), options);
	execute("init", pathB, batch("example/b", "b"), options);
	const tokenA = execute("acquire", pathA).token;
	const tokenB = execute("acquire", pathB).token;
	const error = "Claude usage limit reached; resets at 2099-01-01T00:00:00Z";
	execute(
		"record-claude-limit",
		pathA,
		{ error, agentId: "claude-worker", failureKey: "claude-worker:turn-1" },
		options,
	);
	assert.equal(execute("claude-cooldown", pathB, {}, options).active, true);
	const preview = execute(
		"select-next",
		join(f.dir, "repo-c", "batch.json"),
		{
			repository: "example/c",
			batchId: "c",
			cwd: f.dir,
			baseBranch: "main",
			codexModel: "gpt-6-sol",
			count: 1,
			codexModels,
		},
		options,
	);
	assert.deepEqual(preview.tickets, ["7"]);
	const req = { number: 7, models: claudeModels, codexModels };
	const a = execute("reserve", pathA, { ...req, token: tokenA }, options);
	const b = execute("reserve", pathB, { ...req, token: tokenB }, options);
	assert.equal(a.provider, "codex/gpt-6-sol");
	assert.equal(b.provider, "codex/gpt-6-sol");
	execute(
		"attach",
		pathA,
		{
			token: tokenA,
			number: 7,
			workspaceId: "worktree-a",
			agentId: "codex-worker-a",
		},
		options,
	);
	execute(
		"review",
		pathA,
		{
			token: tokenA,
			number: 7,
			evidence: "worker stopped; diff and tests inspected",
		},
		options,
	);
	assert.equal(execute("status", pathA).tickets[7].status, "reviewing");
	assert.equal(
		ticketRecord(a, {
			now: Date.now(),
			stuckHours: 24,
			recommendation: { model: "Sonnet", effort: "medium" },
		}).recommendationMismatch,
		false,
	);
	assert.equal(
		ticketRecord(a, { now: Date.now(), stuckHours: 24 }).codexFallback,
		true,
	);
	assert.equal(
		readClaudeCooldown(f.cooldownPath, Date.parse("2099-01-01T00:00:00Z"))
			.active,
		false,
	);
	assert.equal(
		resolveWorkerRuntime(
			{ model: "Sonnet", effort: "medium" },
			{ models: claudeModels, codexModels },
			{
				statePath: f.cooldownPath,
				now: Date.parse("2099-01-01T00:00:00Z"),
			},
		).provider,
		"claude/claude-sonnet-5",
	);
});
