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
	"localVerificationCommand",
	"schedulePromptAppend",
	"codexWorkerFullAccess",
]);

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

// Labels marking spec/umbrella issues that are implemented through other
// tickets; selection skips them alongside issues with sub-issues.
export function normalizeSpecLabels(value, source = "intake request") {
	if (
		!Array.isArray(value) ||
		value.some(
			(name) =>
				typeof name !== "string" || !name.trim() || name !== name.trim(),
		)
	)
		throw new Error(`${source}: specLabels must contain non-empty label names`);
	return [...new Set(value)];
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
	if (
		config.localVerificationCommand !== undefined &&
		(typeof config.localVerificationCommand !== "string" ||
			!/^[-\w./]+\.mjs$/.test(config.localVerificationCommand) ||
			config.localVerificationCommand.startsWith("/") ||
			config.localVerificationCommand.split("/").includes(".."))
	)
		throw new Error(
			"invalid toolkit-intake.json: localVerificationCommand must be a relative .mjs path inside the checkout",
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
	return {
		...config,
		excludeTickets,
		...(specLabels === undefined ? {} : { specLabels }),
		...(requiredChecks === undefined ? {} : { requiredChecks }),
	};
}
