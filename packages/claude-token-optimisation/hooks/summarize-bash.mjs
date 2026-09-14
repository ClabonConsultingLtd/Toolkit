#!/usr/bin/env node

import { spawnSync } from "node:child_process";
/**
 * Summarize a narrow allowlist of successful routine commands. Failures always
 * retain their complete output so diagnostics are never hidden behind a log.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

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

function commandKind(command) {
	const vitest = command.match(
		/^(?:npx |pnpm exec |pnpm dlx )?vitest run ([\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?)$/,
	);
	if (command === "git status") return { kind: "git-status" };
	if (command === "pnpm -r list --depth -1") return { kind: "pnpm-list" };
	if (vitest) return { kind: "vitest-single-file", testPath: vitest[1] };
	return null;
}

function summarize(kind, output, testPath) {
	if (kind === "git-status") {
		const branch = /^On branch (\S+)/m.exec(output)?.[1];
		const detached = /^HEAD detached at (\S+)/m.exec(output)?.[1];
		const tracking = /^Your branch (.+)$/m.exec(output)?.[1];
		const header = branch
			? tracking
				? `branch ${branch}, ${tracking}`
				: `branch ${branch}`
			: detached
				? `detached HEAD at ${detached}`
				: "(unrecognised branch header)";
		const files = output
			.split("\n")
			.filter((line) => line.startsWith("\t"))
			.map((line) => line.trim());
		return files.length
			? `${header}, ${files.length} file(s):\n${files.map((file) => `  ${file}`).join("\n")}`
			: `${header}, working tree clean`;
	}
	if (kind === "pnpm-list") {
		const names = output
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => line.trim().split(/\s+/)[0]);
		return `${names.length} package(s): ${names.join(", ")}`;
	}
	const summary = output
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => /^(Test Files|Tests|Duration|Start at)\s/.test(line));
	return summary.length
		? `${testPath}:\n${summary.map((line) => `  ${line}`).join("\n")}`
		: output.trim();
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
const candidate = commandKind(command.trim());
if (!candidate) process.exit(0);

const result = spawnSync(`${command.trim()} 2>&1`, {
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
