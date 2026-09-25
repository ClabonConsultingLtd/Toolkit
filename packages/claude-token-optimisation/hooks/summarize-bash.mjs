#!/usr/bin/env node

import { spawnSync } from "node:child_process";
/**
 * Summarize a narrow allowlist of successful routine commands. Failures always
 * retain their complete output so diagnostics are never hidden behind a log.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { commandKind, summarize, surveyUnmatched } from "./command-summary.mjs";

async function readHookInput() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function deny(reason) {
	console.log(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: reason,
			},
		}),
	);
}

let input;
try {
	input = await readHookInput();
} catch {
	process.exit(0);
}
if (input.agent_id) process.exit(0);

const {
	command,
	run_in_background: background,
	timeout,
} = input.tool_input ?? {};
if (typeof command !== "string" || background) process.exit(0);
const trimmedCommand = command.trim();
const candidate = commandKind(trimmedCommand);
if (!candidate) {
	surveyUnmatched(trimmedCommand, input.cwd);
	process.exit(0);
}

const result = spawnSync(`${trimmedCommand} 2>&1`, {
	shell: true,
	cwd: input.cwd ?? process.cwd(),
	encoding: "utf8",
	timeout: typeof timeout === "number" && timeout > 0 ? timeout : 120_000,
	maxBuffer: 64 * 1024 * 1024,
});
const raw = result.stdout ?? "";
const failed =
	result.status !== 0 || result.signal !== null || Boolean(result.error);
if (failed) {
	deny(
		raw ||
			(result.error
				? `(command failed to start: ${result.error.message})`
				: `(command exited ${result.status ?? `on signal ${result.signal}`} with no output)`),
	);
	process.exit(0);
}

const stateRoot = resolve(
	input.cwd ?? process.cwd(),
	process.env.TOOLKIT_STATE_DIR ?? ".toolkit",
);
const logDirectory = join(
	stateRoot,
	"claude-token-optimisation",
	"bash-summary-logs",
);
mkdirSync(logDirectory, { recursive: true });
const logPath = join(logDirectory, `${Date.now()}-${candidate.kind}.log`);
writeFileSync(logPath, raw, "utf8");
deny(
	`${summarize(candidate.kind, raw, candidate.testPath)}\n\nFull raw output: ${logPath}`,
);
