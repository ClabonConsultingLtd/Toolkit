#!/usr/bin/env node
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { nextSteps, runSetup, TRACKERS } from "./src/wizard.mjs";

const USAGE = `usage: node setup.mjs [TARGET_REPOSITORY] [options]

Sets up a repository to use Toolkit with Claude Code: vendors agent-workflow
and claude-token-optimisation with toolkit-sync, installs token optimisation,
and configures the Claude ticket runner. Run it from a Toolkit clone checked
out at a release tag.

Options:
  --tracker local|github|both  Where tickets live (asked if omitted)
  --tag vX.Y.Z                 Toolkit release (default: the clone's checked-out tag)
  --dest-root DIR              Where packages are vendored (default: tools)
  --repo URL                   Toolkit repository toolkit-sync fetches from
  --yes                        Accept every default; never prompt
  --no-branch                  Don't offer to create chore/toolkit-setup
  --labels / --no-labels       Create (or skip) the GitHub triage labels
  --skills / --no-skills       Run (or skip) the Matt Pocock skills installer
  --help                       Show this help`;

export function parseArgs(argv) {
	const options = {};
	const valueFlags = {
		"--tracker": "tracker",
		"--tag": "tag",
		"--dest-root": "destRoot",
		"--repo": "repo",
	};
	const switches = {
		"--yes": ["yes", true],
		"--no-branch": ["branch", false],
		"--labels": ["labels", true],
		"--no-labels": ["labels", false],
		"--skills": ["skills", true],
		"--no-skills": ["skills", false],
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
	if (options.tracker && !TRACKERS.includes(options.tracker))
		throw new Error(`--tracker must be one of ${TRACKERS.join(", ")}`);
	return options;
}

function terminalIo(yes) {
	const interactive = process.stdin.isTTY && !yes;
	let rl;
	const prompt = async (question) => {
		rl ??= createInterface({ input: process.stdin, output: process.stdout });
		return (await rl.question(question)).trim();
	};
	return {
		log: (message) => console.log(message),
		warn: (message) => console.warn(`WARNING: ${message}`),
		async ask(question, choices, fallback) {
			if (!interactive) {
				if (yes) return fallback;
				throw new Error(
					`${question} (run in a terminal or pass the matching option)`,
				);
			}
			for (;;) {
				const answer = (await prompt(`${question} [${fallback}] `)) || fallback;
				if (choices.includes(answer)) return answer;
				console.log(`Please answer one of: ${choices.join(", ")}`);
			}
		},
		async confirm(question, fallback) {
			if (!interactive) return fallback;
			const answer = (
				await prompt(`${question} [${fallback ? "Y/n" : "y/N"}] `)
			).toLowerCase();
			return answer === "" ? fallback : answer.startsWith("y");
		},
		close: () => rl?.close(),
	};
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		console.log(USAGE);
		return;
	}
	const io = terminalIo(options.yes);
	try {
		const result = await runSetup(
			{ ...options, toolkitRoot: resolve(import.meta.dirname, "..", "..") },
			io,
		);
		console.log(`\nDone. Toolkit ${result.tag} is set up in ${result.root}.`);
		console.log(`Wrote or updated: ${result.written.join(", ")}`);
		if (result.kept.length > 0)
			console.log(`Kept existing files: ${result.kept.join(", ")}`);
		if (result.warnings.length > 0)
			console.log(
				`\n${result.warnings.length} warning(s) above need attention.`,
			);
		console.log(`\n${nextSteps(result)}`);
	} finally {
		io.close();
	}
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
	main().catch((error) => {
		console.error(`setup failed: ${error.message}`);
		process.exitCode = 1;
	});
