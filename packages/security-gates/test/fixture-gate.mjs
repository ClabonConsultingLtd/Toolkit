// Runs one Gate, or the Suppression checker, over a committed fixture and
// checks the outcome. Used by the self-test workflow.
//
//   node fixture-gate.mjs <fixture> <gate|suppressions> --expect <pass|fail|warn> [options]
//
// The fixture is copied into a new git repository with a ".fixture" suffix
// stripped from each file name. The suffix keeps the planted findings out of
// Toolkit's own scans and lint. Its files are committed on top of an empty
// base commit, so the secrets Gate scans the same kind of commit range it
// scans on a pull request.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;
const SCRIPTS = new URL("../scripts/", import.meta.url).pathname;
const SUFFIX = ".fixture";

// Fixed identity and dates make the fixture commits, and so Gitleaks
// fingerprints, the same on every run.
const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "Fixture",
	GIT_AUTHOR_EMAIL: "fixture@example.invalid",
	GIT_COMMITTER_NAME: "Fixture",
	GIT_COMMITTER_EMAIL: "fixture@example.invalid",
	GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
	GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

function git(cwd, args) {
	const result = spawnSync("git", args, {
		cwd,
		env: GIT_ENV,
		encoding: "utf8",
	});
	if (result.status !== 0)
		throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
	return result.stdout.trim();
}

function stripSuffixes(dir) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) stripSuffixes(path);
		else if (entry.name.endsWith(SUFFIX))
			renameSync(path, path.slice(0, -SUFFIX.length));
	}
}

export function materialise(fixture) {
	const repo = mkdtempSync(join(tmpdir(), `security-gates-${fixture}-`));
	git(repo, ["init", "--quiet", "--initial-branch=main"]);
	git(repo, ["commit", "--quiet", "--allow-empty", "--message", "Base"]);
	const base = git(repo, ["rev-parse", "HEAD"]);
	cpSync(join(FIXTURES, fixture), repo, { recursive: true });
	stripSuffixes(repo);
	git(repo, ["add", "--all"]);
	git(repo, ["commit", "--quiet", "--message", `Add ${fixture} fixture`]);
	return { repo, base, head: git(repo, ["rev-parse", "HEAD"]) };
}

const PAST = { pass: "passed", fail: "failed", warn: "warned" };

function outcome(status, output) {
	if (status !== 0) return "fail";
	return /^::warning /m.test(output) ? "warn" : "pass";
}

function main() {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			expect: { type: "string" },
			bin: { type: "string" },
			today: { type: "string" },
			out: { type: "string" },
		},
	});
	const [fixture, gate] = positionals;
	if (!fixture || !gate || !["pass", "fail", "warn"].includes(values.expect)) {
		console.log(
			"usage: fixture-gate.mjs <fixture> <gate|suppressions> --expect <pass|fail|warn> [--bin <dir>] [--today YYYY-MM-DD] [--out <dir>]",
		);
		process.exit(2);
	}
	const { repo, base, head } = materialise(fixture);
	const today = values.today ? ["--today", values.today] : [];
	const runs =
		gate === "suppressions"
			? ["gitleaks", "opengrep", "osv-scanner"].map((tool) => [
					join(SCRIPTS, "check-suppressions.mjs"),
					"--tool",
					tool,
					"--root",
					repo,
					...today,
				])
			: [
					[
						join(SCRIPTS, "run-gate.mjs"),
						gate,
						"--target",
						repo,
						"--out",
						values.out ??
							mkdtempSync(join(tmpdir(), `security-gates-${fixture}-results-`)),
						"--base",
						base,
						"--head",
						head,
						...(values.bin ? ["--bin", values.bin] : []),
						...today,
					],
				];

	let failed = false;
	for (const args of runs) {
		const result = spawnSync(process.execPath, args, { encoding: "utf8" });
		const output = `${result.stdout}${result.stderr}`;
		const actual = outcome(result.status, result.stdout);
		const label = gate === "suppressions" ? `${gate} (${args[2]})` : gate;
		// Show the run's output without letting its annotations through: an
		// expected failure shouldn't appear as an error on this run.
		const token = `fixture-${process.pid}-${Date.now()}`;
		console.log(`::group::${fixture}: ${label}`);
		console.log(`::stop-commands::${token}`);
		console.log(output);
		console.log(`::${token}::`);
		console.log("::endgroup::");
		if (actual === values.expect) {
			console.log(`${fixture}: ${label} ${PAST[actual]} as expected`);
		} else {
			console.log(
				`::error::${fixture}: expected ${label} to ${values.expect}, but it ${PAST[actual]}`,
			);
			failed = true;
		}
	}
	process.exit(failed ? 1 : 0);
}

if (process.argv[1] === import.meta.filename) main();
