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
]);

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
		config.excludeTickets !== undefined &&
		(!Array.isArray(config.excludeTickets) ||
			config.excludeTickets.some(
				(n) =>
					!/^[1-9]\d*$/.test(String(n)) || !Number.isSafeInteger(Number(n)),
			))
	)
		throw new Error(
			"invalid toolkit-intake.json: excludeTickets must contain issue numbers",
		);
	const excludeTickets = (config.excludeTickets ?? []).map(String);
	if (new Set(excludeTickets).size !== excludeTickets.length)
		throw new Error("invalid toolkit-intake.json: duplicate excludeTickets");
	return { ...config, excludeTickets };
}
