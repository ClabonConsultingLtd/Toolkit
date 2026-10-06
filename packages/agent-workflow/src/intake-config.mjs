import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const fields = new Set([
	"version",
	"repository",
	"baseBranch",
	"codexModel",
	"count",
	"cron",
	"timezone",
	"excludeTickets",
	"requiredChecks",
	"specLabels",
	"fileOverlapCheck",
	"localVerificationCommand",
	"cleanupCommand",
	"schedulePromptAppend",
	"codexWorkerFullAccess",
	"selfAuthoredMerge",
	"controllerProvider",
	"controllerThinkingOptionId",
	"workerHosts",
]);

// The controller's own scheduled runtime: which provider/model runs the
// recurring intake schedule itself, independent of which provider a worker
// gets dispatched to per ticket. Unset keeps today's Codex default so
// existing repositories see no behavior change.
export const DEFAULT_CONTROLLER_PROVIDER = "codex/gpt-6-sol";
export const DEFAULT_CONTROLLER_THINKING_OPTION_ID = "medium";

export function normalizeControllerProvider(value, source = "intake request") {
	if (
		typeof value !== "string" ||
		!/^(claude|codex)\/[^/]+$/.test(value.trim())
	)
		throw new Error(
			`${source}: controllerProvider must be "claude/<model>" or "codex/<model>"`,
		);
	return value.trim();
}

export function normalizeRequiredChecks(value, source = "intake request") {
	if (
		!Array.isArray(value) ||
		value.some(
			(name) =>
				typeof name !== "string" || !name.trim() || name !== name.trim(),
		)
	)
		throw new Error(
			`${source}: requiredChecks must contain non-empty check names`,
		);
	if (new Set(value).size !== value.length)
		throw new Error(`${source}: duplicate requiredChecks`);
	return value;
}

function normalizeLabelList(value, source, field) {
	if (
		!Array.isArray(value) ||
		value.some(
			(name) =>
				typeof name !== "string" || !name.trim() || name !== name.trim(),
		)
	)
		throw new Error(`${source}: ${field} must contain non-empty label names`);
	return [...new Set(value)];
}

// Labels marking spec/umbrella issues that are implemented through other
// tickets; selection skips them alongside issues with sub-issues.
export function normalizeSpecLabels(value, source = "intake request") {
	return normalizeLabelList(value, source, "specLabels");
}

const hostFields = new Set([
	"id",
	"paseoHost",
	"cwd",
	"count",
	"excludeLabels",
	"passwordEnv",
]);

// Other Paseo daemons the controller may place admitted tickets on, each with
// its own active-ticket limit. A ticket carrying one of a host's excludeLabels
// is never placed there, which is how a repository keeps work that needs
// tooling only the controller's host has (an asset pipeline, a mounted
// dataset) off a host without it.
export function normalizeWorkerHosts(value, source = "intake request") {
	if (value === undefined) return [];
	if (!Array.isArray(value))
		throw new Error(`${source}: workerHosts must be an array`);
	const ids = new Set();
	return value.map((host, index) => {
		const name = `${source}: workerHosts[${index}]`;
		if (!host || typeof host !== "object" || Array.isArray(host))
			throw new Error(`${name} must be an object`);
		for (const field of Object.keys(host))
			if (!hostFields.has(field))
				throw new Error(`${name}: unknown field ${field}`);
		if (
			typeof host.id !== "string" ||
			!/^[a-z0-9][a-z0-9-]{0,31}$/.test(host.id) ||
			host.id === "local"
		)
			throw new Error(`${name}.id must be a lowercase slug other than "local"`);
		if (ids.has(host.id))
			throw new Error(`${source}: duplicate workerHosts id ${host.id}`);
		ids.add(host.id);
		// The endpoint is committed with the config, so a password or pairing
		// token in it would be too. The daemon password travels only through
		// the environment variable passwordEnv names.
		const endpoint =
			typeof host.paseoHost === "string" ? host.paseoHost.trim() : "";
		if (!endpoint || /[\s?#]/.test(endpoint))
			throw new Error(
				`${name}.paseoHost must be a daemon endpoint with no query, fragment or whitespace`,
			);
		if (
			typeof host.cwd !== "string" ||
			!host.cwd.startsWith("/") ||
			host.cwd.split("/").includes("..")
		)
			throw new Error(`${name}.cwd must be an absolute path on that host`);
		if (!Number.isSafeInteger(host.count) || host.count < 1)
			throw new Error(`${name}.count must be a positive integer`);
		if (
			host.passwordEnv !== undefined &&
			(typeof host.passwordEnv !== "string" ||
				!/^[A-Z_][A-Z0-9_]*$/.test(host.passwordEnv))
		)
			throw new Error(
				`${name}.passwordEnv must be an environment variable name`,
			);
		return {
			id: host.id,
			paseoHost: endpoint,
			cwd: host.cwd,
			count: host.count,
			excludeLabels: normalizeLabelList(
				host.excludeLabels ?? [],
				name,
				"excludeLabels",
			),
			...(host.passwordEnv ? { passwordEnv: host.passwordEnv } : {}),
		};
	});
}

// Keeps tickets whose declared files overlap in-flight work out of a batch.
// On unless a repository turns it off.
export function normalizeFileOverlapCheck(value, source = "intake request") {
	if (value === undefined) return true;
	if (typeof value !== "boolean")
		throw new Error(`${source}: fileOverlapCheck must be a boolean`);
	return value;
}

export function normalizeExcludeTickets(value, source = "intake request") {
	if (
		!Array.isArray(value) ||
		value.some(
			(n) => !/^[1-9]\d*$/.test(String(n)) || !Number.isSafeInteger(Number(n)),
		)
	)
		throw new Error(`${source}: excludeTickets must contain issue numbers`);
	const numbers = value.map(String);
	if (new Set(numbers).size !== numbers.length)
		throw new Error(`${source}: duplicate excludeTickets`);
	return numbers;
}

export function readRepositoryIntakeConfig(cwd) {
	const path = join(cwd, "toolkit-intake.json");
	if (!existsSync(path)) return null;
	let config;
	try {
		config = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`invalid toolkit-intake.json: ${error.message}`);
	}
	if (!config || typeof config !== "object" || Array.isArray(config))
		throw new Error("invalid toolkit-intake.json: expected an object");
	for (const field of Object.keys(config))
		if (!fields.has(field))
			throw new Error(`invalid toolkit-intake.json: unknown field ${field}`);
	if (config.version !== 1)
		throw new Error("invalid toolkit-intake.json: version must be 1");
	for (const field of ["repository", "baseBranch", "codexModel"])
		if (typeof config[field] !== "string" || !config[field].trim())
			throw new Error(`invalid toolkit-intake.json: ${field} is required`);
	if (!Number.isSafeInteger(config.count) || config.count < 1)
		throw new Error(
			"invalid toolkit-intake.json: count must be a positive integer",
		);
	for (const field of ["cron", "timezone"])
		if (
			config[field] !== undefined &&
			(typeof config[field] !== "string" || !config[field].trim())
		)
			throw new Error(`invalid toolkit-intake.json: ${field} must be nonempty`);
	for (const field of ["localVerificationCommand", "cleanupCommand"])
		if (
			config[field] !== undefined &&
			(typeof config[field] !== "string" ||
				!/^[-\w./]+\.mjs$/.test(config[field]) ||
				config[field].startsWith("/") ||
				config[field].split("/").includes(".."))
		)
			throw new Error(
				`invalid toolkit-intake.json: ${field} must be a relative .mjs path inside the checkout`,
			);
	const append = config.schedulePromptAppend;
	if (
		append !== undefined &&
		!(typeof append === "string" && append.trim()) &&
		!(
			Array.isArray(append) &&
			append.length &&
			append.every((line) => typeof line === "string" && line.trim())
		)
	)
		throw new Error(
			"invalid toolkit-intake.json: schedulePromptAppend must be a nonempty string or array of strings",
		);
	if (
		config.codexWorkerFullAccess !== undefined &&
		typeof config.codexWorkerFullAccess !== "boolean"
	)
		throw new Error(
			"invalid toolkit-intake.json: codexWorkerFullAccess must be a boolean",
		);
	// Opt-in for single-account setups, where GitHub always refuses the
	// controller's approval of a PR its own account opened.
	if (
		config.selfAuthoredMerge !== undefined &&
		config.selfAuthoredMerge !== "comment-review"
	)
		throw new Error(
			'invalid toolkit-intake.json: selfAuthoredMerge must be "comment-review"',
		);
	if (config.controllerProvider !== undefined)
		normalizeControllerProvider(
			config.controllerProvider,
			"invalid toolkit-intake.json",
		);
	if (
		config.controllerThinkingOptionId !== undefined &&
		(typeof config.controllerThinkingOptionId !== "string" ||
			!config.controllerThinkingOptionId.trim())
	)
		throw new Error(
			"invalid toolkit-intake.json: controllerThinkingOptionId must be a nonempty string",
		);
	normalizeFileOverlapCheck(
		config.fileOverlapCheck,
		"invalid toolkit-intake.json",
	);
	const excludeTickets = normalizeExcludeTickets(
		config.excludeTickets ?? [],
		"invalid toolkit-intake.json",
	);
	const requiredChecks =
		config.requiredChecks === undefined
			? undefined
			: normalizeRequiredChecks(
					config.requiredChecks,
					"invalid toolkit-intake.json",
				);
	const specLabels =
		config.specLabels === undefined
			? undefined
			: normalizeSpecLabels(config.specLabels, "invalid toolkit-intake.json");
	const workerHosts =
		config.workerHosts === undefined
			? undefined
			: normalizeWorkerHosts(config.workerHosts, "invalid toolkit-intake.json");
	return {
		...config,
		excludeTickets,
		...(specLabels === undefined ? {} : { specLabels }),
		...(requiredChecks === undefined ? {} : { requiredChecks }),
		...(workerHosts === undefined ? {} : { workerHosts }),
	};
}
