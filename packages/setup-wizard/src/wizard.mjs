import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	ensureLines,
	ensureSection,
	formatJson,
	mergeClaudeSettings,
	mergeScripts,
	removeLines,
} from "./merge.mjs";

export const TRACKERS = ["local", "github", "both"];
const PACKAGES = [
	"toolkit-sync",
	"agent-workflow",
	"claude-token-optimisation",
];
// Runtime state is ignored, but committed overlays under .toolkit/overlays/
// must stay visible, so a bare ".toolkit/" directory ignore is replaced.
const IGNORE_LINES = [".toolkit/*", "!.toolkit/overlays/"];
const OLD_IGNORE_LINES = [".toolkit/", "/.toolkit/", ".toolkit", "/.toolkit"];
const TEMPLATES = join(import.meta.dirname, "..", "templates");
export const WINDOWS = process.platform === "win32";

// How to put each tool on PATH, for "not on PATH" messages.
const PATH_HINTS = WINDOWS
	? {
			git: 'If it is installed, re-run the Git installer and choose "Git from the command line and also from 3rd-party software".',
			claude:
				"If it is installed, add %USERPROFILE%\\.local\\bin to your user PATH.",
			pnpm: "If it is installed, add the folder npm prefix -g prints (normally %APPDATA%\\npm) to your user PATH.",
			gh: "If it is installed, add C:\\Program Files\\GitHub CLI to your user PATH.",
			paseo:
				"If Paseo Desktop is installed, add C:\\Program Files\\Paseo\\resources\\bin to your user PATH.",
		}
	: {};

export function notOnPath(tool, install) {
	const hint = PATH_HINTS[tool] ? ` ${PATH_HINTS[tool]}` : "";
	return `${tool} is not on PATH. ${install}${hint} Then open a new terminal and re-run the wizard.`;
}

const RELEASE_KEY_URL =
	"https://github.com/ClabonConsultingLtd/Toolkit/issues/154";

export const LABELS = {
	"needs-triage": "d4c5f9",
	"needs-info": "fbca04",
	"ready-for-agent": "0e8a16",
	"ready-for-human": "1d76db",
	wontfix: "ffffff",
	done: "5319e7",
};

const CONTEXT_SECTION = `Follow [.claude/CONTEXT-POLICY.md](.claude/CONTEXT-POLICY.md) for targeted reads and command output.`;

export function ticketConfigs(tracker) {
	const configs = {};
	if (tracker !== "github")
		configs["ticket-config.json"] = {
			provider: "local-markdown",
			readyStatus: "ready-for-agent",
			command: "node scripts/claude-ticket.mjs",
		};
	if (tracker !== "local")
		configs["ticket-config.github.json"] = {
			provider: "github",
			readyStatus: "ready-for-agent",
			command: "node scripts/claude-ticket.mjs",
			statusLabels: Object.keys(LABELS),
			closedStatus: "done",
		};
	return configs;
}

export function packageScripts(tracker, destRoot) {
	const src = `${destRoot}/agent-workflow/src`;
	const scripts = {};
	if (tracker !== "github")
		scripts["implement-ticket"] =
			`node ${src}/ticket-launch.mjs --config ticket-config.json`;
	if (tracker !== "local")
		scripts["implement-issue"] =
			`node ${src}/ticket-launch.mjs --config ticket-config.github.json`;
	scripts["implement-batch"] = `node ${src}/ticket-batch.mjs`;
	return scripts;
}

export function permissionRules(tracker, testCommand) {
	const rules = [
		"Bash(git status)",
		"Bash(git diff:*)",
		"Bash(git log:*)",
		"Bash(git add:*)",
		"Bash(git commit:*)",
	];
	if (testCommand) rules.unshift(`Bash(${testCommand}:*)`);
	if (tracker !== "local")
		for (const verb of ["view", "list", "edit", "comment"])
			rules.push(`Bash(gh issue ${verb}:*)`);
	return rules;
}

/** The repository's test command, if package.json declares one. */
export function detectTestCommand(root) {
	const pkgPath = join(root, "package.json");
	if (!existsSync(pkgPath)) return undefined;
	try {
		if (!JSON.parse(readFileSync(pkgPath, "utf8")).scripts?.test)
			return undefined;
	} catch {
		return undefined;
	}
	if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm test";
	if (existsSync(join(root, "yarn.lock"))) return "yarn test";
	return "npm test";
}

/**
 * Run a command. On Windows, tools installed as .cmd shims (npx, and
 * sometimes claude or gh) resolve only through a shell, so the command line
 * is passed as one string of simple, space-free arguments.
 */
export function run(
	command,
	args,
	{ cwd, inherit = false, shell = false, raw = false, input } = {},
) {
	const useShell = shell && WINDOWS;
	const stdio = inherit ? "inherit" : "pipe";
	const options = {
		cwd,
		encoding: "utf8",
		...(input === undefined
			? { stdio }
			: { input, stdio: ["pipe", stdio, stdio] }),
	};
	const result = useShell
		? spawnSync([command, ...args].join(" "), { ...options, shell: true })
		: spawnSync(command, args, options);
	return {
		ok: !result.error && result.status === 0,
		stdout: raw ? (result.stdout ?? "") : (result.stdout?.trim() ?? ""),
		stderr: result.stderr?.trim() ?? "",
		error: result.error,
	};
}

function git(cwd, args, { raw = false } = {}) {
	const result = run("git", args, { cwd, raw });
	if (!result.ok)
		throw new Error(
			`git ${args.join(" ")} failed: ${result.stderr || result.error?.message}`,
		);
	return result.stdout;
}

function writeText(path, text) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

function readText(path) {
	return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** True for `git version X.Y...` at 2.34 or later, the first with SSH signatures. */
export function gitSupportsSshSignatures(versionText) {
	const match = /(\d+)\.(\d+)/.exec(versionText);
	if (!match) return false;
	const [major, minor] = [Number(match[1]), Number(match[2])];
	return major > 2 || (major === 2 && minor >= 34);
}

/** SHA256 fingerprints of the keys in an allowed_signers file. */
function anchorFingerprints(path) {
	if (!existsSync(path)) return [];
	const keys = readFileSync(path, "utf8")
		.split("\n")
		.map((line) => /\b(ssh-\S+ \S+)/.exec(line)?.[1])
		.filter(Boolean);
	const dir = mkdtempSync(join(tmpdir(), "setup-anchor-"));
	try {
		return keys
			.map((key, n) => {
				const file = join(dir, `key${n}.pub`);
				writeFileSync(file, `${key}\n`);
				return /SHA256:\S+/.exec(run("ssh-keygen", ["-lf", file]).stdout)?.[0];
			})
			.filter(Boolean);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Set up a consuming repository for Claude Code. `io` supplies log, warn,
 * ask(question, choices, fallback) and confirm(question, fallback).
 */
export async function runSetup(options, io) {
	const { toolkitRoot, destRoot = "tools", repo, yes = false } = options;
	const summary = { written: [], kept: [], warnings: [] };
	const warn = (message) => {
		summary.warnings.push(message);
		io.warn(message);
	};
	const step = (message) => io.log(`\n== ${message}`);

	// Preflight
	step("Checking prerequisites");
	const nodeMajor = Number(process.versions.node.split(".")[0]);
	if (nodeMajor < 24)
		throw new Error(
			`Node.js 24 or later is required (found ${process.versions.node})`,
		);
	const gitVersion = run("git", ["--version"]);
	if (!gitVersion.ok)
		throw new Error(notOnPath("git", "Install Git for Windows."));
	if (!gitSupportsSshSignatures(gitVersion.stdout))
		throw new Error(
			`toolkit-sync verifies SSH-signed release tags, which needs git 2.34 or later (found: ${gitVersion.stdout}). Update Git and re-run the wizard.`,
		);

	const target = resolve(options.target ?? ".");
	if (!existsSync(target)) throw new Error(`target does not exist: ${target}`);
	if (!run("git", ["rev-parse", "--show-toplevel"], { cwd: target }).ok) {
		if (
			!(await io.confirm(
				`${target} is not a git repository. Run git init?`,
				true,
			))
		)
			throw new Error("the target must be a git repository");
		git(target, ["init"]);
		io.log(`Initialised a git repository in ${target}`);
	}
	const root = resolve(git(target, ["rev-parse", "--show-toplevel"]));
	io.log(`Repository: ${root}`);
	const tag =
		options.tag ??
		run("git", ["describe", "--tags", "--exact-match", "HEAD"], {
			cwd: toolkitRoot,
		}).stdout;
	if (!tag)
		throw new Error(
			"cannot tell which Toolkit release to install: check out a release tag in the Toolkit clone or pass --tag",
		);
	if (
		!run("git", ["rev-parse", "--verify", "--quiet", `${tag}^{commit}`], {
			cwd: toolkitRoot,
		}).ok
	)
		throw new Error(
			`tag ${tag} is not in the Toolkit clone at ${toolkitRoot}; run git fetch --tags there`,
		);
	io.log(`Toolkit release: ${tag}`);

	const tracker =
		options.tracker ??
		(yes
			? "local"
			: await io.ask(
					"Issue tracker: local (.scratch Markdown files), github (GitHub issues) or both?",
					TRACKERS,
					"local",
				));
	if (!TRACKERS.includes(tracker))
		throw new Error(`--tracker must be one of ${TRACKERS.join(", ")}`);
	io.log(`Tracker: ${tracker}`);

	if (!run("claude", ["--version"], { shell: true }).ok)
		warn(notOnPath("claude", "Tickets need Claude Code."));
	if (!run("pnpm", ["--version"], { shell: true }).ok)
		warn(
			notOnPath(
				"pnpm",
				"The implement-* commands need it: npm install -g pnpm@11.",
			),
		);
	let githubReady = false;
	if (tracker !== "local") {
		if (!run("gh", ["--version"], { shell: true }).ok)
			warn(notOnPath("gh", "The GitHub track needs the GitHub CLI."));
		else if (!run("gh", ["auth", "status"], { shell: true }).ok)
			warn("gh is not signed in; run gh auth login and gh auth setup-git.");
		else githubReady = true;
		if (!githubReady) warn("GitHub labels were not created.");
	}
	if (git(root, ["status", "--porcelain"]))
		warn(
			"The working tree has uncommitted changes; review the diff carefully before committing.",
		);

	// Branch
	const branch = run("git", ["branch", "--show-current"], { cwd: root }).stdout;
	if (
		options.branch !== false &&
		["main", "master"].includes(branch) &&
		(await io.confirm(
			`You are on ${branch}. Create branch chore/toolkit-setup?`,
			true,
		))
	) {
		git(root, ["switch", "-c", "chore/toolkit-setup"]);
		io.log("Switched to chore/toolkit-setup");
	}

	// Ignore rules
	step("Updating .gitignore and .gitattributes");
	const gitignorePath = join(root, ".gitignore");
	const withoutOld = removeLines(readText(gitignorePath), OLD_IGNORE_LINES);
	const gitignore = ensureLines(withoutOld.text, IGNORE_LINES);
	if (withoutOld.changed || gitignore.changed) {
		writeText(gitignorePath, gitignore.text);
		summary.written.push(".gitignore");
	}
	if (withoutOld.changed)
		io.log(
			"Replaced the .toolkit/ ignore so .toolkit/overlays/ can be committed",
		);
	const gitattributesPath = join(root, ".gitattributes");
	const gitattributes = ensureLines(readText(gitattributesPath), [
		`${destRoot}/** -text`,
	]);
	if (gitattributes.changed) {
		writeText(gitattributesPath, gitattributes.text);
		summary.written.push(".gitattributes");
	}

	// Vendored packages. The clone's toolkit-sync pins everything, itself
	// included; the vendored copy then checks the result.
	step(`Vendoring ${PACKAGES.join(", ")} (${tag})`);
	const repoArgs = repo ? ["--repo", repo] : [];
	const toolkitSync = (cli, args) => {
		const result = run(process.execPath, [cli, ...args, ...repoArgs], {
			cwd: root,
			inherit: true,
		});
		if (!result.ok)
			throw new Error(
				`toolkit-sync ${args[0]} failed; see the output above. It verifies each release tag's SSH signature, which needs git 2.34+ and ssh-keygen on PATH, and a release tag from v0.14.0 on. If the release adds a key to the Trust anchor, confirm the key with Toolkit's maintainers, then re-run with --accept-trust-anchor-change.`,
			);
	};
	// A repository that already vendors a verifying toolkit-sync checks the new
	// release against the key it already trusts. A first setup has no key yet:
	// it trusts the clone's, so a person confirms its fingerprint first.
	const vendored = join(root, destRoot, "toolkit-sync");
	const upgrading = existsSync(join(vendored, "allowed_signers"));
	const cli = upgrading
		? join(vendored, "src", "cli.mjs")
		: join(toolkitRoot, "packages", "toolkit-sync", "src", "cli.mjs");
	let acceptAnchor = options.acceptTrustAnchorChange === true;
	if (!upgrading) {
		const fingerprints = anchorFingerprints(
			join(toolkitRoot, "packages", "toolkit-sync", "allowed_signers"),
		);
		summary.fingerprints = fingerprints;
		for (const fingerprint of fingerprints)
			io.log(`Release signing key: ${fingerprint}`);
		acceptAnchor ||= await io.confirm(
			`Does ${fingerprints.join(" and ")} match the release key published at ${RELEASE_KEY_URL}?`,
			false,
		);
		if (!acceptAnchor)
			throw new Error(
				`Compare the release signing key above with ${RELEASE_KEY_URL}, then re-run and confirm it (with --yes, pass --accept-trust-anchor-change). Nothing was vendored.`,
			);
	}
	for (const name of PACKAGES)
		toolkitSync(cli, ["pin", name, tag, "--dest", `${destRoot}/${name}`]);
	toolkitSync(cli, [
		"sync",
		...(acceptAnchor ? ["--accept-trust-anchor-change"] : []),
	]);
	toolkitSync(join(root, destRoot, "toolkit-sync", "src", "cli.mjs"), [
		"check",
	]);
	summary.written.push(
		"toolkit-pins.json",
		...PACKAGES.map((name) => `${destRoot}/${name}/`),
	);

	cpSync(
		join(root, destRoot, "toolkit-sync", "claude", "skills", "toolkit-upgrade"),
		join(root, ".claude", "skills", "toolkit-upgrade"),
		{ recursive: true },
	);
	summary.written.push(".claude/skills/toolkit-upgrade/");

	// Matt Pocock's skills, before the settings merge below so that merge
	// keeps the plugin's enabledPlugins entry.
	if (
		options.skills === true ||
		(options.skills !== false &&
			(await io.confirm(
				"Install Matt Pocock's skills as a project plugin (claude plugin install mattpocock-skills --scope project)?",
				true,
			)))
	) {
		step("Installing Matt Pocock's skills");
		const skills = run(
			"claude",
			["plugin", "install", "mattpocock-skills", "--scope", "project"],
			{ cwd: root, inherit: true, shell: true },
		);
		if (!skills.ok)
			warn(
				"The plugin install did not finish; run claude plugin install mattpocock-skills --scope project by hand.",
			);
		summary.skills = skills.ok;
	}

	// Token optimisation
	step("Installing Claude token optimisation");
	const install = run(
		process.execPath,
		[join(root, destRoot, "claude-token-optimisation", "install.mjs"), root],
		{ cwd: root, inherit: true },
	);
	if (!install.ok)
		throw new Error("token optimisation install failed; see the output above");
	const fragmentPath = join(
		root,
		".claude",
		"settings.toolkit-token-optimisation.json",
	);
	const fragment = JSON.parse(readFileSync(fragmentPath, "utf8"));
	const settingsPath = join(root, ".claude", "settings.json");
	const settingsText = readText(settingsPath);
	const testCommand = detectTestCommand(root);
	const merged = mergeClaudeSettings(
		settingsText ? JSON.parse(settingsText) : {},
		{
			hooks: fragment.hooks,
			allow: permissionRules(tracker, testCommand),
		},
	);
	if (merged.changed) {
		writeText(settingsPath, formatJson(merged.settings, settingsText));
		summary.written.push(".claude/settings.json");
	}
	rmSync(fragmentPath);
	io.log(
		"Merged the hook settings and permission rules into .claude/settings.json",
	);
	if (!testCommand)
		warn(
			"No test script found in package.json. Add your test, lint and build commands to permissions.allow in .claude/settings.json so unattended tickets can run them.",
		);

	// Agent instructions
	const agentsPath = join(root, "AGENTS.md");
	const agents = ensureSection(
		readText(agentsPath),
		"## Context use",
		CONTEXT_SECTION,
	);
	if (agents.changed) {
		writeText(agentsPath, agents.text);
		summary.written.push("AGENTS.md");
	}
	if (existsSync(join(root, "CLAUDE.md")))
		warn(
			"CLAUDE.md exists, so Claude Code will not read AGENTS.md. Move its content into AGENTS.md and delete it.",
		);

	// Ticket runner
	step("Setting up the ticket runner");
	const writeIfMissing = (relative, text) => {
		const path = join(root, relative);
		if (!existsSync(path)) {
			writeText(path, text);
			summary.written.push(relative);
		} else if (readFileSync(path, "utf8") !== text) summary.kept.push(relative);
	};
	writeIfMissing(
		"scripts/claude-ticket.mjs",
		readFileSync(join(TEMPLATES, "claude-ticket.mjs"), "utf8"),
	);
	for (const [file, config] of Object.entries(ticketConfigs(tracker)))
		writeIfMissing(file, formatJson(config));

	const pkgPath = join(root, "package.json");
	const pkgText = readText(pkgPath);
	const scripts = mergeScripts(
		pkgText ? JSON.parse(pkgText) : { private: true },
		packageScripts(tracker, destRoot),
	);
	if (scripts.added.length > 0) {
		writeText(pkgPath, formatJson(scripts.pkg, pkgText));
		summary.written.push("package.json");
	}
	for (const name of scripts.conflicts)
		warn(`package.json already has a different "${name}" script; it was kept.`);

	// GitHub labels
	if (
		githubReady &&
		options.labels !== false &&
		(options.labels ||
			(await io.confirm("Create the triage labels on GitHub?", true)))
	) {
		step("Creating GitHub labels");
		for (const [label, color] of Object.entries(LABELS)) {
			const result = run(
				"gh",
				["label", "create", label, "--color", color, "--force"],
				{ cwd: root, shell: true },
			);
			if (result.ok) io.log(`label ${label}`);
			else warn(`Could not create label ${label}: ${result.stderr}`);
		}
	}

	return { root, tag, tracker, ...summary };
}

export function nextSteps(result) {
	const steps = [
		"Review permissions.allow in .claude/settings.json and add the test, lint and build commands tickets need.",
	];
	if (!result.skills)
		steps.push(
			"Install Matt Pocock's skills: claude plugin install mattpocock-skills --scope project.",
		);
	const tracker = {
		local: "local Markdown",
		github: "GitHub",
		both: "issue tracker you use most",
	}[result.tracker];
	steps.push(
		`Start claude and run /mattpocock-skills:setup-matt-pocock-skills. It edits AGENTS.md; choose the ${tracker} tracker and keep the default triage labels.`,
		"Review the changes with git status and git diff, then commit them.",
	);
	return ["Next steps:", ...steps.map((text, i) => `${i + 1}. ${text}`)].join(
		"\n",
	);
}
