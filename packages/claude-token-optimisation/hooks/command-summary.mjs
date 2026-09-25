import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const CD_PREFIX = /^cd\s+(?:"[^"`$\\]*"|'[^']*'|[\w./~-]+)\s*&&\s*/;
const PIPEFAIL_PREFIX = /^set\s+-o\s+pipefail\s*(?:;|&&)\s*/;
const TIMEOUT_PREFIX = /^timeout\s+\d+(?:\.\d+)?[smhd]?\s+/;
const OUTPUT_LIMIT_SUFFIX = /\s*\|\s*(tail|head)\s+(?:-n\s*|-)(\d+)$/;
const MERGE_STDERR_SUFFIX = /\s*2>&1$/;

// Common agent wrappers around an allowlisted command: a worktree `cd`, a
// `set -o pipefail` guard, a leading `timeout N`, and a trailing
// `2>&1 | tail -N` (or `head -N`). The pipeline is dropped from the command
// that actually runs, so the exit status is the command's own; the requested
// line limit applies only to failure output, alongside the full log.
export function normaliseCommand(command) {
	let rest = command.trim();
	let prefix = "";
	for (;;) {
		const cd = CD_PREFIX.exec(rest);
		const pipefail = cd ? null : PIPEFAIL_PREFIX.exec(rest);
		if (!cd && !pipefail) break;
		if (cd) prefix += cd[0];
		rest = rest.slice((cd ?? pipefail)[0].length);
	}
	const timeout = TIMEOUT_PREFIX.exec(rest);
	if (timeout) {
		prefix += timeout[0];
		rest = rest.slice(timeout[0].length);
	}
	const limit = OUTPUT_LIMIT_SUFFIX.exec(rest);
	const outputLimit = limit
		? { from: limit[1], lines: Number(limit[2]) }
		: undefined;
	if (limit) rest = rest.slice(0, limit.index);
	rest = rest.replace(MERGE_STDERR_SUFFIX, "").trim();
	return { core: rest, run: `${prefix}${rest}`, outputLimit };
}

export function limitOutput(output, outputLimit) {
	if (!outputLimit) return output;
	const lines = output.replace(/\n$/, "").split("\n");
	if (lines.length <= outputLimit.lines) return output;
	const kept =
		outputLimit.from === "head"
			? lines.slice(0, outputLimit.lines)
			: lines.slice(-outputLimit.lines);
	return `${kept.join("\n")}\n`;
}

// Opt-in only (TOOLKIT_BASH_SUMMARY_SURVEY=on): records which commands miss
// the allowlist so a project can mine its own log for candidates to propose
// upstream. Metadata only, and it never runs or touches the command itself -
// this always exits before the real Bash tool call, leaving execution
// completely unaffected either way.
export function surveyUnmatched(command, cwd) {
	if (process.env.TOOLKIT_BASH_SUMMARY_SURVEY !== "on") return;
	const stateRoot = resolve(
		cwd ?? process.cwd(),
		process.env.TOOLKIT_STATE_DIR ?? ".toolkit",
	);
	const logPath = join(
		stateRoot,
		"claude-token-optimisation",
		"bash-summary-survey.jsonl",
	);
	mkdirSync(dirname(logPath), { recursive: true });
	writeFileSync(
		logPath,
		`${JSON.stringify({ at: new Date().toISOString(), command })}\n`,
		{ flag: "a" },
	);
}

const VITEST_SINGLE_FILE =
	/^(?:npx |pnpm exec |pnpm dlx )?vitest run ([\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?)(?: (?:-t|--testNamePattern)(?: |=)("[^"`$\\]*"|'[^']*'|[\w.:-]+))?$/;
const TSC_NO_EMIT =
	/^(?:npx |pnpm exec )?tsc --noEmit(?: (?:-p|--project) [\w./-]+)?$/;

export function commandKind(command) {
	const { core, run, outputLimit } = normaliseCommand(command);
	const matched = { run, outputLimit };
	const vitest = VITEST_SINGLE_FILE.exec(core);
	if (core === "git status") return { kind: "git-status", ...matched };
	if (core === "pnpm -r list --depth -1")
		return { kind: "pnpm-list", ...matched };
	if (vitest)
		return {
			kind: "vitest-single-file",
			label: vitest[2] ? `${vitest[1]} -t ${vitest[2]}` : vitest[1],
			...matched,
		};
	if (TSC_NO_EMIT.test(core))
		return { kind: "tsc-no-emit", label: core, ...matched };
	return null;
}

export function summarize(kind, output, label) {
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
	if (kind === "tsc-no-emit") {
		const lines = output.split("\n").filter((line) => line.trim()).length;
		return lines
			? `${label}: exit 0, no type errors (${lines} other output line(s))`
			: `${label}: exit 0, no type errors`;
	}
	const summary = output
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => /^(Test Files|Tests|Duration|Start at)\s/.test(line));
	return summary.length
		? `${label}:\n${summary.map((line) => `  ${line}`).join("\n")}`
		: output.trim();
}
