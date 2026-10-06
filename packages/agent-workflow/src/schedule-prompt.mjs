import { join, resolve } from "node:path";
import {
	DEFAULT_CONTROLLER_PROVIDER,
	readRepositoryIntakeConfig,
} from "./intake-config.mjs";
import { intakePath, readIntake } from "./ticket-intake.mjs";

// Which installed skill tree (claude/ or codex/) the generated prompt should
// point at: whichever provider is configured to run this controller itself,
// not the provider any individual worker gets dispatched to. The two skill
// trees are kept byte-identical, so this only changes which absolute paths
// the prompt names.
export function controllerProviderName(controllerProvider) {
	const name = String(controllerProvider ?? DEFAULT_CONTROLLER_PROVIDER).split(
		"/",
	)[0];
	return name === "claude" ? "claude" : "codex";
}

export function schedulePaths(checkout, settings) {
	const cwd = resolve(checkout),
		stateDirectory = join(cwd, ".toolkit", "orchestration");
	const resolvedSettings = settings ?? promptSettings(cwd);
	const skillDirectory = resolve(
		import.meta.dirname,
		"..",
		controllerProviderName(resolvedSettings.controllerProvider),
		"skills",
		"orchestrate-tickets",
	);
	return {
		checkout: cwd,
		skill: join(skillDirectory, "SKILL.md"),
		intakeReference: join(skillDirectory, "references", "intake.md"),
		intakeHelper: join(skillDirectory, "scripts", "intake.mjs"),
		orchestrateHelper: join(skillDirectory, "scripts", "orchestrate.mjs"),
		stateDirectory,
		policy: intakePath(join(stateDirectory, "intake-anchor.json")),
	};
}

function promptSettings(cwd) {
	const config = readRepositoryIntakeConfig(cwd);
	if (config) return config;
	const policy = readIntake(
		join(cwd, ".toolkit", "orchestration", "intake-anchor.json"),
	);
	if (!policy)
		throw new Error(
			"toolkit-intake.json or a configured intake policy is required",
		);
	return policy;
}

// Canonical prompt for the shared intake schedule. Keep it free of timestamps,
// counts and other runtime values so a live prompt can be compared exactly.
export function schedulePrompt(checkout) {
	const cwd = resolve(checkout);
	const settings = promptSettings(cwd);
	const paths = schedulePaths(cwd, settings);
	const helper = `node ${paths.intakeHelper}`;
	const workerMode = settings.codexWorkerFullAccess
		? "This schedule authorizes `full-access` for Codex workers only when that preflight fails; record the sandbox error and the fallback in the run report."
		: "This schedule does not authorize `full-access` for Codex workers: when that preflight fails, block the Codex reservation with the recorded sandbox error instead of launching or changing its mode.";
	const selfAuthored =
		settings.selfAuthoredMerge === "comment-review"
			? " When GitHub refuses the approval only because the controller's account opened the PR, post the independent review as a PR comment naming the reviewed head SHA instead, then merge; never use `--admin` or otherwise bypass branch protection, so a merge GitHub rejects stays awaiting a human."
			: "";
	const cleanup = settings.cleanupCommand
		? ` Run \`node ${paths.orchestrateHelper} cleanup STATE.json\` with the lease token, ticket number and absolute \`worktreePath\` after each review, when a ticket is blocked, when a stopped or finished worker is reconciled, and after \`sync\` finalizes a merge; report any \`ok: false\` result as a warning.`
		: "";
	// Only when hosts are configured, so repositories without them keep an
	// unchanged prompt and see no drift.
	const workerHosts = settings.workerHosts?.length
		? "12. Worker hosts are configured. `tick` returns a `placement` for each admitted ticket, the batch ticket carries `host`, and `reserve` returns `workerHost` (`id`, `paseoHost`, `cwd`, optional `passwordEnv`). Launch and inspect such a ticket only through that daemon with the Paseo CLI (`paseo --host <paseoHost> workspace create --isolation worktree --path <cwd> ...`, `paseo --host <paseoHost> agent run --workspace <id> ...`, then `inspect`, `logs`, `wait`, `send`), as the skill's Dispatch and review section describes, never through this daemon's MCP tools; never launch a ticket without `host` on a worker host. Export PASEO_PASSWORD from the variable `passwordEnv` names for those commands only; the endpoint, request files and the report never carry it. Run `cleanup` for such a ticket in two steps: first without `remoteResult` to get the command, run it in a terminal on that daemon, then again with `remoteResult: {ok, error?}`."
		: null;
	const lines = [
		`Run the ticket intake controller for ${settings.repository} (schedule \`ticket-intake:${settings.repository}\`).`,
		"",
		"Paths:",
		`- Skill: ${paths.skill}`,
		`- Intake reference: ${paths.intakeReference}`,
		`- Intake helper: ${paths.intakeHelper}`,
		`- Orchestration helper: ${paths.orchestrateHelper}`,
		`- Checkout: ${paths.checkout}`,
		`- Batch state directory: ${paths.stateDirectory}`,
		`- Intake policy: ${paths.policy}`,
		"",
		"Instructions:",
		"1. Read the skill and intake reference above and follow the intake reference's controller steps exactly. They take precedence over any summary here.",
		`2. If toolkit-intake.json exists, run \`${helper} sync-config ${paths.checkout}\` first; stop on invalid settings or a limit below active work. Read N from the saved policy, never from this prompt.`,
		`3. Inspect the saved Paseo schedule by ID, reading only id, name, status/paused, cron, timezone, provider/model, mode and prompt, not run history. Pipe \`paseo schedule inspect ID --json\` into \`${helper} schedule-summary ${paths.checkout} -\` for that projection instead of reading the full \`inspect_schedule\` output. A missing schedule, ID/name mismatch or unknown paused state stops new admission. Report cron, timezone or model drift against the policy.`,
		`4. Compare the live schedule prompt with \`${helper} schedule-prompt ${paths.checkout}\` (the summary's \`promptMatches\`, or \`schedule-prompt ${paths.checkout} --check -\`). Report drift with the regenerate command; do not rewrite this prompt yourself.`,
		`5. Reconcile all existing batches under normal orchestration leases before admission; renew leases at least every five minutes and immediately before external mutations, and release them in cleanup. Review completed workers and PRs independently, at most two fix cycles per ticket. Tear down any containers, volumes and networks this run started while verifying.${cleanup}`,
		"6. Check `claude-cooldown`, pass the raw Paseo model catalogs, then re-fetch the schedule and pass `schedule: {id, name, paused}` to `tick`. Process admitted batches with the orchestration workflow; `managedByIntake` batches get no per-batch schedule, and this shared schedule is not paused when a batch completes.",
		`7. Before launching a Codex worker in \`auto-review\`, run the sandbox preflight from the skill (for example \`codex sandbox true\`). Errors such as \`bwrap: No permissions to create a new namespace\` mean the sandbox is unavailable. ${workerMode}`,
		"8. Workers implement only their ticket and open draft PRs. They never merge, close issues, change labels or batch state, create schedules or launch other workers. Preserve each worker's selected mode; never widen permissions or batch scope beyond this prompt.",
		`9. Approve or merge only where this prompt explicitly authorizes it, and only after \`merge-ready\` returns \`mergeReady: true\` for the exact linked PR head.${selfAuthored} Otherwise leave PRs awaiting a human merge.`,
		"10. Keep this schedule running when capacity is full or nothing qualifies. Pause it only on explicit user request or a systemic error that prevents safe reconciliation, recording the reason. Report the run type, new selections, active count, PR links, blockers, prompt drift, and the live schedule state and next run.",
		"11. This scheduled run can be archived as soon as its turn ends, which stops anything it still has running in the background. Run every subagent, review, verification, test run or timer in the foreground and collect its result within the same turn; never end the turn while any of them is in progress, and never call a tool meant only for an interactive session's self-paced dynamic loop (one that ends the current turn to schedule a future resumption). If background work cannot be avoided, wait for the automatic completion notification within the same turn. Never wait for a lease held by another run to expire: report its holder and expiry, finish this run cleanly, and let the next scheduled run reconcile. Launched workers are separate agents and keep running after this run ends.",
		...(workerHosts ? [workerHosts] : []),
	];
	const append = settings.schedulePromptAppend;
	if (append)
		lines.push(
			"",
			"Repository additions:",
			...(Array.isArray(append) ? append : [append]),
		);
	return `${lines.join("\n")}\n`;
}

function normalize(text) {
	return text
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

function scheduleRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value.schedule ?? value)
		: null;
}

// Accept either raw prompt text or a Paseo schedule JSON object.
export function livePrompt(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return text;
	}
	const schedule = scheduleRecord(parsed);
	if (!schedule) return text;
	if (typeof schedule.prompt !== "string")
		throw new Error("schedule JSON has no prompt");
	return schedule.prompt;
}

export function comparePrompt(expected, actual, limit = 5) {
	const want = normalize(expected),
		have = normalize(actual);
	if (want === have) return { matches: true, missing: [], unexpected: [] };
	const count = (lines) => {
		const counts = new Map();
		for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
		return counts;
	};
	const difference = (from, other) => {
		const remaining = count(other);
		return from.filter((line) => {
			const left = remaining.get(line) ?? 0;
			if (left) remaining.set(line, left - 1);
			return !left && line.trim();
		});
	};
	const wantLines = want.split("\n"),
		haveLines = have.split("\n");
	const missing = difference(wantLines, haveLines),
		unexpected = difference(haveLines, wantLines);
	return {
		matches: false,
		missingCount: missing.length,
		unexpectedCount: unexpected.length,
		missing: missing.slice(0, limit),
		unexpected: unexpected.slice(0, limit),
		...(!missing.length && !unexpected.length && { reordered: true }),
	};
}

export function driftSummary(result) {
	if (result.matches) return "schedule prompt matches";
	const lines = ["schedule prompt drift:"];
	if (result.reordered) lines.push("  lines are reordered");
	const show = (label, sign, items, total) => {
		if (!total) return;
		lines.push(`  ${total} ${label}`);
		for (const item of items)
			lines.push(
				`  ${sign} ${item.length > 120 ? `${item.slice(0, 117)}...` : item}`,
			);
		if (total > items.length) lines.push(`  ${sign} ...`);
	};
	show("expected line(s) missing", "-", result.missing, result.missingCount);
	show("unexpected line(s)", "+", result.unexpected, result.unexpectedCount);
	return lines.join("\n");
}

// Project only the schedule fields a controller needs; run history is dropped.
export function scheduleSummary(value, expectedPrompt) {
	const schedule = scheduleRecord(value);
	if (!schedule) throw new Error("schedule JSON must be an object");
	const config = schedule.target?.config ?? {};
	const status = typeof schedule.status === "string" ? schedule.status : null;
	const paused =
		typeof schedule.paused === "boolean"
			? schedule.paused
			: status === null
				? null
				: status === "paused";
	const summary = {
		id: schedule.id ?? null,
		name: schedule.name ?? null,
		status,
		paused,
		cron: schedule.cadence?.expression ?? schedule.cron ?? null,
		timezone: schedule.cadence?.timezone ?? schedule.timezone ?? null,
		provider: config.provider ?? schedule.provider ?? null,
		model: config.model ?? schedule.model ?? null,
		thinkingOptionId:
			config.thinkingOptionId ?? schedule.thinkingOptionId ?? null,
		mode: config.modeId ?? schedule.modeId ?? schedule.mode ?? null,
		cwd: config.cwd ?? schedule.cwd ?? null,
		nextRunAt: schedule.nextRunAt ?? null,
	};
	if (expectedPrompt === undefined) return summary;
	if (typeof schedule.prompt !== "string")
		return { ...summary, promptMatches: null };
	const drift = comparePrompt(expectedPrompt, schedule.prompt);
	return {
		...summary,
		promptMatches: drift.matches,
		...(!drift.matches && { promptDrift: driftSummary(drift) }),
	};
}
