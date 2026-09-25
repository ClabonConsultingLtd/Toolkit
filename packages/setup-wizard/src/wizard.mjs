import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	ensureLines,
	ensureSection,
	formatJson,
	mergeClaudeSettings,
	mergeScripts,
} from "./merge.mjs";

export const TRACKERS = ["local", "github", "both"];
const SYNC_FILES = ["cli", "git", "manifest", "package-sync", "pin-file"];
const PACKAGES = ["agent-workflow", "claude-token-optimisation"];
const UPGRADE_SKILL = "packages/toolkit-sync/claude/skills/toolkit-upgrade";
const TEMPLATES = join(import.meta.dirname, "..", "templates");
const WINDOWS = process.platform === "win32";

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
function run(
	command,
	args,
	{ cwd, inherit = false, shell = false, raw = false } = {},
) {
	const useShell = shell && WINDOWS;
	const result = useShell
		? spawnSync([command, ...args].join(" "), {
				cwd,
				encoding: "utf8",
				stdio: inherit ? "inherit" : "pipe",
				shell: true,
			})
		: spawnSync(command, args, {
				cwd,
				encoding: "utf8",
				stdio: inherit ? "inherit" : "pipe",
			});
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
	if (!run("git", ["--version"]).ok)
		throw new Error("git is not on PATH; install Git for Windows first");

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
	if (/\s/.test(root))
		warn(
			"The repository path contains a space; the ticket runner passes ticket paths through a shell and will break. Move it to a path such as C:\\src\\<name>.",
		);

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
		warn("claude is not on PATH. Install Claude Code before running tickets.");
	if (!run("pnpm", ["--version"], { shell: true }).ok)
		warn(
			"pnpm is not on PATH; install it (npm install -g pnpm@11) to use the pnpm implement-* commands.",
		);
	const githubReady =
		tracker !== "local" && run("gh", ["auth", "status"], { shell: true }).ok;
	if (tracker !== "local" && !githubReady)
		warn(
			"gh is missing or not signed in; run gh auth login. GitHub labels were not created.",
		);
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
	for (const [file, lines] of [
		[".gitignore", [".toolkit/"]],
		[".gitattributes", [`${destRoot}/** -text`]],
	]) {
		const path = join(root, file);
		const result = ensureLines(readText(path), lines);
		if (result.changed) {
			writeText(path, result.text);
			summary.written.push(file);
		}
	}

	// toolkit-sync
	step(
		`Vendoring toolkit-sync, agent-workflow and claude-token-optimisation (${tag})`,
	);
	const syncDir = join(root, destRoot, "toolkit-sync");
	for (const name of SYNC_FILES)
		writeText(
			join(syncDir, `${name}.mjs`),
			git(
				toolkitRoot,
				["show", `${tag}:packages/toolkit-sync/src/${name}.mjs`],
				{
					raw: true,
				},
			),
		);
	summary.written.push(`${destRoot}/toolkit-sync/`);
	const cli = join(syncDir, "cli.mjs");
	const repoArgs = repo ? ["--repo", repo] : [];
	const sync = (args) => {
		const result = run(process.execPath, [cli, ...args, ...repoArgs], {
			cwd: root,
			inherit: true,
		});
		if (!result.ok)
			throw new Error(`toolkit-sync ${args[0]} failed; see the output above`);
	};
	for (const name of PACKAGES)
		sync(["pin", name, tag, "--dest", `${destRoot}/${name}`]);
	sync(["sync"]);
	sync(["check"]);
	summary.written.push(
		"toolkit-pins.json",
		...PACKAGES.map((name) => `${destRoot}/${name}/`),
	);

	for (const file of git(toolkitRoot, [
		"ls-tree",
		"-r",
		"--name-only",
		tag,
		"--",
		UPGRADE_SKILL,
	]).split("\n")) {
		if (!file) continue;
		writeText(
			join(
				root,
				".claude/skills/toolkit-upgrade",
				file.slice(UPGRADE_SKILL.length + 1),
			),
			git(toolkitRoot, ["show", `${tag}:${file}`], { raw: true }),
		);
	}
	summary.written.push(".claude/skills/toolkit-upgrade/");

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

	// Matt Pocock's skills
	if (
		options.skills === true ||
		(options.skills !== false &&
			!yes &&
			(await io.confirm(
				"Install Matt Pocock's skills now (npx skills@latest add mattpocock/skills)? Choose Claude Code, project scope and copy when asked.",
				true,
			)))
	) {
		step("Installing Matt Pocock's skills");
		const skills = run("npx", ["skills@latest", "add", "mattpocock/skills"], {
			cwd: root,
			inherit: true,
			shell: true,
		});
		if (!skills.ok)
			warn("The skills installer did not finish; run it again by hand.");
		summary.skills = skills.ok;
	}

	return { root, tag, tracker, ...summary };
}

export function nextSteps(result) {
	const steps = [
		"Review permissions.allow in .claude/settings.json and add the test, lint and build commands tickets need.",
	];
	if (!result.skills)
		steps.push(
			"Install Matt Pocock's skills: npx skills@latest add mattpocock/skills (choose Claude Code, project scope and copy).",
		);
	const tracker = {
		local: "local Markdown",
		github: "GitHub",
		both: "issue tracker you use most",
	}[result.tracker];
	steps.push(
		`Start claude and run /setup-matt-pocock-skills. Choose AGENTS.md, and the ${tracker} tracker.`,
		"Review the changes with git status and git diff, then commit them.",
	);
	return ["Next steps:", ...steps.map((text, i) => `${i + 1}. ${text}`)].join(
		"\n",
	);
}
