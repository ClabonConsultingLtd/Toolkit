#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { terminalIo } from "./setup.mjs";
import { paseoNextSteps, runPaseoSetup } from "./src/paseo.mjs";

const USAGE = `usage: node paseo-setup.mjs [STABLE_CHECKOUT] [options]

Configures a checkout, already set up with setup.mjs, to run Toolkit's
ticket skills on Paseo schedules with a Claude controller: Paseo's agent
tools, toolkit-intake.json, paseo.json, skill links, GitHub labels, the intake
policy, and the ticket-intake schedule (plus optional triage and report
schedules). Run it in the checkout the schedules will use.

Options:
  --repository OWNER/NAME      GitHub repository (default: from the origin remote)
  --base-branch NAME           Branch tickets merge into (default: GitHub's default)
  --model ID                   Claude model for the controller (asked if omitted)
  --thinking ID                Controller thinking level (default: medium)
  --count N                    Tickets in progress at once (asked if omitted)
  --required-checks A,B        CI checks a PR must pass ("" for none)
  --allow-merge / --no-merge   Let the controller approve and merge passing PRs
  --self-authored-merge / --no-self-authored-merge
                               Workers and controller share a GitHub account
  --worktree-setup CMD         Command paseo.json runs in each new worktree
  --triage / --no-triage       Also schedule triage-tickets
  --report / --no-report       Also schedule report-tickets
  --no-schedules               Configure files only; create no schedules
  --activate                   Leave new schedules running (default: paused)
  --dest-root DIR              Where packages are vendored (default: tools)
  --yes                        Accept every default without prompting
  --help                       Show this help`;

export function parsePaseoArgs(argv) {
	const options = {};
	const valueFlags = {
		"--repository": "repository",
		"--base-branch": "baseBranch",
		"--model": "model",
		"--thinking": "thinking",
		"--count": "count",
		"--required-checks": "requiredChecks",
		"--worktree-setup": "worktreeSetup",
		"--dest-root": "destRoot",
	};
	const switches = {
		"--yes": ["yes", true],
		"--allow-merge": ["allowMerge", true],
		"--no-merge": ["allowMerge", false],
		"--self-authored-merge": ["selfAuthoredMerge", true],
		"--no-self-authored-merge": ["selfAuthoredMerge", false],
		"--triage": ["triage", true],
		"--no-triage": ["triage", false],
		"--report": ["report", true],
		"--no-report": ["report", false],
		"--no-schedules": ["schedules", false],
		"--activate": ["activate", true],
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") options.help = true;
		else if (valueFlags[arg]) {
			const value = argv[++i];
			if (value === undefined || value.startsWith("--"))
				throw new Error(`${arg} needs a value`);
			options[valueFlags[arg]] = value;
		} else if (switches[arg]) {
			const [key, value] = switches[arg];
			options[key] = value;
		} else if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
		else if (options.target === undefined) options.target = arg;
		else throw new Error(`unexpected argument: ${arg}`);
	}
	if (options.requiredChecks !== undefined)
		options.requiredChecks = options.requiredChecks
			.split(",")
			.map((name) => name.trim())
			.filter(Boolean);
	if (options.repository && !/^[\w.-]+\/[\w.-]+$/.test(options.repository))
		throw new Error("--repository must look like owner/name");
	return options;
}

async function main() {
	const options = parsePaseoArgs(process.argv.slice(2));
	if (options.help) {
		console.log(USAGE);
		return;
	}
	const io = terminalIo(options.yes);
	try {
		const result = await runPaseoSetup(options, io);
		console.log(
			`\nDone. ${result.repository} is configured for Paseo in ${result.root}.`,
		);
		if (result.written.length > 0)
			console.log(`Wrote or updated: ${result.written.join(", ")}`);
		if (result.kept.length > 0)
			console.log(`Kept existing files: ${result.kept.join(", ")}`);
		if (result.handoff)
			console.log(
				`\nSend this to a Claude agent in Paseo, started in this checkout:\n\n${result.handoff}`,
			);
		if (result.warnings.length > 0)
			console.log(
				`\n${result.warnings.length} warning(s) above need attention.`,
			);
		console.log(`\n${paseoNextSteps(result)}`);
	} finally {
		io.close();
	}
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
	main().catch((error) => {
		console.error(`paseo setup failed: ${error.message}`);
		process.exitCode = 1;
	});
