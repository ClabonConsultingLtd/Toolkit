import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function stripCdPrefix(command) {
	const match = command.match(
		/^cd\s+(?:"[^"`$\\]*"|'[^']*'|[\w./~-]+)\s*&&\s*([\s\S]*)$/,
	);
	return match ? match[1].trim() : command;
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

export function commandKind(command) {
	const forMatch = stripCdPrefix(command);
	const vitest = forMatch.match(
		/^(?:npx |pnpm exec |pnpm dlx )?vitest run ([\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?)$/,
	);
	if (forMatch === "git status") return { kind: "git-status" };
	if (forMatch === "pnpm -r list --depth -1") return { kind: "pnpm-list" };
	if (vitest) return { kind: "vitest-single-file", testPath: vitest[1] };
	return null;
}

export function summarize(kind, output, testPath) {
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
