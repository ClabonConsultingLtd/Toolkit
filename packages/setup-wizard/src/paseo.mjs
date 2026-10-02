import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { ensureLines, formatJson } from "./merge.mjs";
import { LABELS, notOnPath, run, WINDOWS } from "./wizard.mjs";

export const SKILLS = [
	"orchestrate-tickets",
	"triage-tickets",
	"report-tickets",
];
export const DEFAULT_CRON = "*/30 8-19 * * *";
export const DEFAULT_TIMEZONE = "UTC";
// Paseo's Claude mode without permission prompts. Scheduled controllers run
// unattended, so the Toolkit skills require the provider's full-access mode.
export const CONTROLLER_MODE = "bypassPermissions";

export const MERGE_AUTHORIZATION =
	"The repository owner authorizes this scheduled controller to approve and merge a ticket's pull request, only after merge-ready returns mergeReady: true and every gate in the skill passes. Never use --admin or bypass branch protection.";

/** `owner/repo` from a GitHub HTTPS or SSH remote URL. */
export function parseGitHubRemote(url) {
	const match = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(
		url.trim(),
	);
	return match ? `${match[1]}/${match[2]}` : undefined;
}

/** A dependency install command for new Paseo worktrees, from the lockfile. */
export function worktreeSetupCommand(root) {
	if (existsSync(join(root, "pnpm-lock.yaml")))
		return "pnpm install --frozen-lockfile";
	if (existsSync(join(root, "package-lock.json"))) return "npm ci";
	if (existsSync(join(root, "yarn.lock")))
		return "yarn install --frozen-lockfile";
	return undefined;
}

export function intakeConfig({
	repository,
	baseBranch,
	model,
	thinking,
	count,
	requiredChecks,
	allowMerge,
	selfAuthoredMerge,
}) {
	return {
		version: 1,
		repository,
		baseBranch,
		// Audit metadata: the controller's own model, whatever its provider.
		codexModel: model,
		count,
		...(requiredChecks ? { requiredChecks } : {}),
		cron: DEFAULT_CRON,
		timezone: DEFAULT_TIMEZONE,
		excludeTickets: [],
		specLabels: [],
		controllerProvider: `claude/${model}`,
		controllerThinkingOptionId: thinking,
		...(allowMerge ? { schedulePromptAppend: MERGE_AUTHORIZATION } : {}),
		...(allowMerge && selfAuthoredMerge
			? { selfAuthoredMerge: "comment-review" }
			: {}),
	};
}

/** Forward slashes, so a path pasted into Git Bash keeps its separators. */
const portable = (path) => path.replaceAll("\\", "/");

export function triagePrompt({ skill, checkout, repository }) {
	return [
		`Run a triage sweep for ${repository} (schedule \`triage:${repository}\`).`,
		"",
		`Skill: ${portable(skill)}`,
		`Checkout: ${portable(checkout)}`,
		"",
		"Follow the skill: acquire the lock, run one full sweep of the current bucket, apply only the outcomes the skill may apply unattended, release the lock, and finish.",
		"Do not create a schedule; this run belongs to an existing one.",
	].join("\n");
}

export function reportPrompt({ skill, checkout, repository }) {
	return [
		`Write the ticket digest for ${repository} (schedule \`report-tickets:${repository}\`).`,
		"",
		`Skill: ${portable(skill)}`,
		`Checkout: ${portable(checkout)}`,
		"",
		"Follow the skill: sweep every batch state file under .toolkit/orchestration/, gather Paseo agent activity for the agents they reference, run the helper, and never change orchestrate-tickets state.",
		"Do not create a schedule; this run belongs to an existing one.",
	].join("\n");
}

/**
 * A request for a Claude agent inside Paseo to create schedules with Paseo's
 * own tools. Used where the Paseo CLI can't take a multi-line prompt as an
 * argument (a .cmd shim on Windows).
 */
export function scheduleHandoff(specs, { intakeHelper, checkout }) {
	const lines = [
		'Create these Paseo schedules with your Paseo tools. For each one, first list schedules and keep an existing schedule with the same name instead of creating another. Otherwise create it with exactly these settings and isolation "local", then pause it.',
		"",
	];
	specs.forEach((spec, n) => {
		lines.push(
			`${n + 1}. Name \`${spec.name}\`, cron \`${spec.cron}\`, timezone ${spec.timezone}, provider \`${spec.provider}\`, thinking \`${spec.thinking}\`, mode \`${spec.mode}\`, cwd \`${portable(spec.cwd)}\`. Prompt: the exact contents of \`${portable(spec.promptFile)}\`.`,
		);
	});
	if (specs.some((spec) => spec.intake))
		lines.push(
			"",
			`Then register the ticket-intake schedule's ID by running \`node "${portable(intakeHelper)}" schedule "${portable(checkout)}" -\` with \`{"scheduleId":"<id>"}\` on stdin.`,
		);
	lines.push("", "Report each schedule's ID and settings.");
	return lines.join("\n");
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function parseJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/**
 * Configure a stable checkout to run Toolkit's ticket skills on Paseo
 * schedules with a Claude controller. `io` is the same interface setup.mjs
 * uses: log, warn, ask(question, choices, fallback), confirm(question, fallback).
 */
export async function runPaseoSetup(options, io) {
	const { destRoot = "tools", yes = false } = options;
	const summary = { written: [], kept: [], warnings: [], schedules: [] };
	const warn = (message) => {
		summary.warnings.push(message);
		io.warn(message);
	};
	const step = (message) => io.log(`\n== ${message}`);
	const paseo = (args, extra = {}) =>
		run("paseo", args, { shell: true, ...extra });

	// Preflight
	step("Checking prerequisites");
	const target = resolve(options.target ?? ".");
	const top = run("git", ["rev-parse", "--show-toplevel"], { cwd: target });
	if (!top.ok) throw new Error(`${target} is not a git repository`);
	const root = resolve(top.stdout);
	const awRoot = join(root, destRoot, "agent-workflow");
	const skillDir = (name) => join(awRoot, "claude", "skills", name);
	const intakeHelper = join(
		skillDir("orchestrate-tickets"),
		"scripts",
		"intake.mjs",
	);
	if (!existsSync(intakeHelper))
		throw new Error(
			`${portable(relative(root, intakeHelper))} is missing. Run setup.mjs first, so the repository vendors agent-workflow.`,
		);

	const remote = run("git", ["remote", "get-url", "origin"], { cwd: root });
	const repository =
		options.repository ??
		(remote.ok ? parseGitHubRemote(remote.stdout) : undefined);
	if (!repository)
		throw new Error(
			"The ticket skills run on GitHub issues: add a GitHub remote named origin, or pass --repository owner/name.",
		);
	io.log(`Repository: ${repository} in ${root}`);

	if (!run("gh", ["auth", "status"], { shell: true }).ok)
		throw new Error(
			"gh is missing or not signed in. Install the GitHub CLI, run gh auth login, then re-run.",
		);
	if (!paseo(["--version"]).ok)
		throw new Error(
			notOnPath("paseo", "Install Paseo Desktop or the Paseo CLI."),
		);
	if (!run("claude", ["--version"], { shell: true }).ok)
		warn(
			notOnPath(
				"claude",
				"Paseo starts Claude Code for the controller and workers.",
			),
		);

	const baseBranch =
		options.baseBranch ??
		(run(
			"gh",
			[
				"repo",
				"view",
				repository,
				"--json",
				"defaultBranchRef",
				"--jq",
				".defaultBranchRef.name",
			],
			{ shell: true },
		).stdout ||
			"main");
	const branch = run("git", ["branch", "--show-current"], { cwd: root }).stdout;
	if (branch !== baseBranch)
		warn(
			`This checkout is on ${branch || "a detached HEAD"}, not ${baseBranch}. Schedules run in this checkout, so keep it on ${baseBranch} and use another clone for day-to-day work.`,
		);
	if (/\s/.test(root))
		warn(
			"The checkout path contains a space. The generated schedule prompt names helper paths without quotes, so move the checkout to a path without spaces.",
		);

	// Paseo tools for agents that Paseo starts
	step("Checking Paseo's agent tools");
	const inject = parseJson(
		paseo(["daemon", "config", "get", "daemon.mcp.injectIntoAgents", "--json"])
			.stdout,
	);
	if (inject?.value === true)
		io.log("Paseo tools are already enabled for agents");
	else if (
		await io.confirm(
			"Enable Paseo tools for agents Paseo starts (daemon.mcp.injectIntoAgents)? The controller needs them to start workers and read schedules.",
			true,
		)
	) {
		if (
			paseo(["daemon", "config", "set", "daemon.mcp.injectIntoAgents", "true"])
				.ok
		)
			io.log("Enabled Paseo tools for agents");
		else
			warn(
				"Could not enable Paseo tools. In Paseo, open Settings, your host, Agents, and turn on Enable Paseo tools.",
			);
	} else
		warn("Paseo tools are off, so scheduled controllers can't start workers.");

	// Controller model
	step("Choosing the controller model");
	const models =
		parseJson(paseo(["provider", "models", "claude", "--json"]).stdout) ?? [];
	const ids = models.map((entry) => entry.id);
	const model =
		options.model ??
		(ids.length > 0
			? await io.ask("Claude model for the scheduled controller:", ids, ids[0])
			: undefined);
	if (!model)
		throw new Error(
			"Paseo listed no Claude models. Check paseo provider diagnostic claude, or pass --model.",
		);
	if (ids.length > 0 && !ids.includes(model))
		throw new Error(
			`Paseo has no Claude model ${model}. Choose one of: ${ids.join(", ")}`,
		);
	const thinkingIds =
		models.find((entry) => entry.id === model)?.thinkingOptionIds ?? [];
	const thinkingDefault = thinkingIds.includes("medium")
		? "medium"
		: (models.find((entry) => entry.id === model)?.defaultThinkingOptionId ??
			"medium");
	const thinking =
		options.thinking ??
		(thinkingIds.length > 0
			? await io.ask(
					"Thinking level for the controller:",
					thinkingIds,
					thinkingDefault,
				)
			: thinkingDefault);
	if (thinkingIds.length > 0 && !thinkingIds.includes(thinking))
		throw new Error(
			`${model} has no thinking option ${thinking}. Choose one of: ${thinkingIds.join(", ")}`,
		);

	// toolkit-intake.json
	step("Writing toolkit-intake.json");
	const intakePath = join(root, "toolkit-intake.json");
	let intake;
	if (existsSync(intakePath)) {
		intake = readJson(intakePath);
		summary.kept.push("toolkit-intake.json");
		io.log("Kept the existing toolkit-intake.json");
		if (intake.controllerProvider !== `claude/${model}`)
			warn(
				`toolkit-intake.json sets controllerProvider to ${intake.controllerProvider ?? "the default Codex controller"}; the wizard kept it. Edit the file to use claude/${model}.`,
			);
	} else {
		const countText =
			options.count ??
			(await io.ask(
				"How many tickets may be in progress at once (also the most admitted per hour)?",
				["1", "2", "3", "4", "5", "6"],
				"2",
			));
		const count = Number(countText);
		if (!Number.isSafeInteger(count) || count < 1)
			throw new Error("--count must be a positive whole number");

		let requiredChecks = options.requiredChecks;
		if (requiredChecks === undefined) {
			const detected = parseJson(
				run(
					"gh",
					[
						"api",
						`repos/${repository}/commits/${baseBranch}/check-runs`,
						"--jq",
						"[.check_runs[].name] | unique",
					],
					{ shell: true },
				).stdout,
			);
			if (Array.isArray(detected) && detected.length > 0) {
				if (
					await io.confirm(
						`Require these checks to pass before a ticket's PR can merge: ${detected.join(", ")}?`,
						true,
					)
				)
					requiredChecks = detected;
			}
			if (!requiredChecks)
				warn(
					"No required checks are set, so merges fall back to branch protection. List your CI check names under requiredChecks in toolkit-intake.json.",
				);
		}

		const allowMerge =
			options.allowMerge ??
			(await io.confirm(
				"Let the scheduled controller approve and merge PRs that pass every gate? (No keeps merging with you.)",
				false,
			));
		const selfAuthoredMerge =
			allowMerge &&
			(options.selfAuthoredMerge ??
				(await io.confirm(
					"Do the workers open PRs under the same GitHub account the controller uses? (GitHub won't let that account approve its own PRs.)",
					true,
				)));
		intake = intakeConfig({
			repository,
			baseBranch,
			model,
			thinking,
			count,
			requiredChecks,
			allowMerge,
			selfAuthoredMerge,
		});
		writeFileSync(intakePath, formatJson(intake));
		summary.written.push("toolkit-intake.json");
	}

	// Ignore rules, including the machine-specific skill links
	const gitignorePath = join(root, ".gitignore");
	const gitignore = ensureLines(
		existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "",
		[
			".toolkit/*",
			"!.toolkit/overlays/",
			...SKILLS.map((name) => `.claude/skills/${name}`),
		],
	);
	if (gitignore.changed) {
		writeFileSync(gitignorePath, gitignore.text);
		summary.written.push(".gitignore");
	}

	// Skill links. The helpers import the package's src/ relative to their real
	// path, so the skills must stay in the vendored package and be linked.
	step("Linking the ticket skills into .claude/skills");
	for (const name of SKILLS) {
		const link = join(root, ".claude", "skills", name);
		const targetDir = skillDir(name);
		let stat;
		try {
			stat = lstatSync(link);
		} catch {}
		if (!stat) {
			mkdirSync(dirname(link), { recursive: true });
			// A junction needs no Developer Mode on Windows; elsewhere the type
			// is ignored and a relative symlink survives moving the checkout.
			symlinkSync(
				WINDOWS ? targetDir : relative(dirname(link), targetDir),
				link,
				"junction",
			);
			summary.written.push(`.claude/skills/${name}`);
		} else if (
			!stat.isSymbolicLink() ||
			resolve(dirname(link), readlinkSync(link)) !== resolve(targetDir)
		)
			warn(
				`.claude/skills/${name} exists and isn't a link to ${portable(relative(root, targetDir))}; it was kept.`,
			);
	}

	// paseo.json: new worktrees start without dependencies.
	const paseoJsonPath = join(root, "paseo.json");
	if (existsSync(paseoJsonPath)) summary.kept.push("paseo.json");
	else {
		const setup = options.worktreeSetup ?? worktreeSetupCommand(root);
		if (
			setup &&
			(await io.confirm(
				`Add paseo.json so each ticket worktree runs "${setup}" when Paseo creates it?`,
				true,
			))
		) {
			writeFileSync(paseoJsonPath, formatJson({ worktree: { setup } }));
			summary.written.push("paseo.json");
		} else if (!setup)
			warn(
				"No lockfile found. If ticket worktrees need a setup step, add it to paseo.json under worktree.setup.",
			);
	}

	// Labels the skills read and write
	if (await io.confirm("Create or update the triage labels on GitHub?", true)) {
		step("Creating GitHub labels");
		for (const [label, color] of Object.entries(LABELS)) {
			const result = run(
				"gh",
				[
					"label",
					"create",
					label,
					"--color",
					color,
					"--force",
					"--repo",
					repository,
				],
				{ shell: true },
			);
			if (!result.ok) warn(`Could not create label ${label}: ${result.stderr}`);
		}
	}
	const labelsDoc = join(root, "docs", "agents", "triage-labels.md");
	if (existsSync(labelsDoc)) {
		const renamed = [
			...readFileSync(labelsDoc, "utf8").matchAll(
				/^\|\s*`([\w-]+)`\s*\|\s*`([^`]+)`\s*\|/gm,
			),
		]
			.filter(([, canonical, label]) => canonical !== label)
			.map(([, canonical, label]) => `${canonical} → ${label}`);
		if (renamed.length > 0)
			warn(
				`docs/agents/triage-labels.md renames labels (${renamed.join(", ")}). orchestrate-tickets uses the canonical names, so keep them the same.`,
			);
	}

	// Intake policy
	step("Configuring intake");
	const configure = run(process.execPath, [intakeHelper, "configure", root], {
		cwd: root,
	});
	if (!configure.ok)
		throw new Error(
			`intake configure failed: ${configure.stderr || configure.stdout}`,
		);
	for (const message of parseJson(configure.stdout)?.warnings ?? [])
		warn(message);

	// Schedules
	const specs = [];
	const provider = intake.controllerProvider ?? `claude/${model}`;
	const controllerThinking = intake.controllerThinkingOptionId ?? thinking;
	const common = {
		cron: intake.cron ?? DEFAULT_CRON,
		timezone: intake.timezone ?? DEFAULT_TIMEZONE,
		provider,
		thinking: controllerThinking,
		mode: CONTROLLER_MODE,
		cwd: root,
	};
	if (options.schedules !== false) {
		const prompt = run(
			process.execPath,
			[intakeHelper, "schedule-prompt", root],
			{
				cwd: root,
				raw: true,
			},
		);
		if (!prompt.ok) throw new Error(`schedule-prompt failed: ${prompt.stderr}`);
		specs.push({
			...common,
			name: `ticket-intake:${repository}`,
			prompt: prompt.stdout,
			intake: true,
		});
		const triage =
			options.triage ??
			(await io.confirm(
				"Also schedule triage sweeps (triage-tickets)?",
				false,
			));
		if (triage)
			specs.push({
				...common,
				name: `triage:${repository}`,
				prompt: triagePrompt({
					skill: join(skillDir("triage-tickets"), "SKILL.md"),
					checkout: root,
					repository,
				}),
			});
		const report =
			options.report ??
			(await io.confirm(
				"Also schedule progress digests (report-tickets)?",
				false,
			));
		if (report)
			specs.push({
				...common,
				name: `report-tickets:${repository}`,
				prompt: reportPrompt({
					skill: join(skillDir("report-tickets"), "SKILL.md"),
					checkout: root,
					repository,
				}),
			});
	}

	if (specs.length > 0) {
		step("Setting up Paseo schedules");
		const promptDir = join(root, ".toolkit", "paseo-setup");
		mkdirSync(promptDir, { recursive: true });
		const existing =
			parseJson(paseo(["schedule", "ls", "--json"]).stdout) ?? [];
		const handoff = [];
		for (const spec of specs) {
			spec.promptFile = join(
				promptDir,
				`${spec.name.replace(/[^\w.-]+/g, "-")}.md`,
			);
			writeFileSync(spec.promptFile, spec.prompt);
			const found = existing.find((schedule) => schedule.name === spec.name);
			if (found) {
				io.log(`Kept the existing schedule ${spec.name} (${found.id})`);
				summary.schedules.push({ name: spec.name, id: found.id, kept: true });
				if (spec.intake) {
					const inspect = paseo([
						"schedule",
						"inspect",
						found.id,
						"--json",
					]).stdout;
					const check = run(
						process.execPath,
						[intakeHelper, "schedule-prompt", root, "--check", "-"],
						{
							cwd: root,
							input: inspect,
						},
					);
					if (!check.ok) {
						if (WINDOWS)
							warn(
								`The prompt of ${spec.name} is out of date. Ask a Claude agent in Paseo to replace it with the contents of ${portable(spec.promptFile)}.`,
							);
						else if (
							await io.confirm(
								`The prompt of ${spec.name} is out of date. Replace it?`,
								true,
							)
						) {
							if (
								paseo(["schedule", "update", found.id, "--prompt", spec.prompt])
									.ok
							)
								io.log(`Updated the prompt of ${spec.name}`);
							else warn(`Could not update the prompt of ${spec.name}.`);
						}
					}
					registerIntake(found.id);
				}
				continue;
			}
			if (WINDOWS) {
				handoff.push(spec);
				continue;
			}
			const created = parseJson(
				run("paseo", [
					"schedule",
					"create",
					"--cron",
					spec.cron,
					"--timezone",
					spec.timezone,
					"--name",
					spec.name,
					"--provider",
					spec.provider,
					"--thinking",
					spec.thinking,
					"--mode",
					spec.mode,
					"--cwd",
					spec.cwd,
					"--json",
					spec.prompt,
				]).stdout,
			);
			if (!created?.id) {
				warn(`Could not create the schedule ${spec.name}.`);
				continue;
			}
			const paused =
				!options.activate && paseo(["schedule", "pause", created.id]).ok;
			io.log(`Created ${spec.name} (${created.id})${paused ? ", paused" : ""}`);
			summary.schedules.push({ name: spec.name, id: created.id, paused });
			if (spec.intake) registerIntake(created.id);
		}
		if (handoff.length > 0)
			summary.handoff = scheduleHandoff(handoff, {
				intakeHelper,
				checkout: root,
			});
	}

	function registerIntake(id) {
		const result = run(
			process.execPath,
			[intakeHelper, "schedule", root, "-"],
			{
				cwd: root,
				input: JSON.stringify({ scheduleId: id }),
			},
		);
		if (!result.ok && !/already registered/.test(result.stderr))
			warn(`Could not register the intake schedule: ${result.stderr}`);
	}

	return {
		root,
		repository,
		baseBranch,
		model,
		thinking: controllerThinking,
		...summary,
		yes,
	};
}

export function paseoNextSteps(result) {
	const steps = [
		"Commit and push toolkit-intake.json, paseo.json and .gitignore to the base branch. Paseo reads paseo.json from the committed base branch.",
	];
	if (result.handoff)
		steps.push(
			"In Paseo, start a Claude agent in this checkout and send it the request printed above. It creates the schedules with Paseo's own tools.",
		);
	if (result.schedules.some((schedule) => schedule.paused))
		steps.push(
			"The new schedules are paused. Resume them in Paseo's Schedules view (or with paseo schedule resume <id>) when tickets are ready.",
		);
	steps.push(
		"For each ticket: give it a **Claude:** `Model / effort` line, post its Agent Brief from an owner, member or collaborator account, and apply ready-for-agent last. Editing the ticket afterwards sends it back to needs-triage.",
	);
	return ["Next steps:", ...steps.map((text, i) => `${i + 1}. ${text}`)].join(
		"\n",
	);
}
