import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const fields = new Set(["version", "gates", "allowedHours"]);
const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const time = /^([01]\d|2[0-3]):([0-5]\d)$/;

function minutes(value) {
	const [, h, m] = time.exec(value);
	return Number(h) * 60 + Number(m);
}

export function readRepositoryHandoffConfig(cwd) {
	const path = join(cwd, "toolkit-handoff.json");
	if (!existsSync(path)) return null;
	let config;
	try {
		config = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`invalid toolkit-handoff.json: ${error.message}`);
	}
	if (!config || typeof config !== "object" || Array.isArray(config))
		throw new Error("invalid toolkit-handoff.json: expected an object");
	for (const field of Object.keys(config))
		if (!fields.has(field))
			throw new Error(`invalid toolkit-handoff.json: unknown field ${field}`);
	if (config.version !== 1)
		throw new Error("invalid toolkit-handoff.json: version must be 1");
	if (
		config.gates !== undefined &&
		(!Array.isArray(config.gates) ||
			!config.gates.length ||
			config.gates.some(
				(gate) =>
					typeof gate !== "string" ||
					!/^[-\w./]+\.mjs$/.test(gate) ||
					gate.startsWith("/") ||
					gate.split("/").includes(".."),
			))
	)
		throw new Error(
			"invalid toolkit-handoff.json: gates must be relative .mjs paths inside the checkout",
		);
	const hours = config.allowedHours;
	if (hours !== undefined) {
		if (!hours || typeof hours !== "object" || Array.isArray(hours))
			throw new Error(
				"invalid toolkit-handoff.json: allowedHours must be an object",
			);
		if (
			!Array.isArray(hours.days) ||
			!hours.days.length ||
			hours.days.some((day) => !days.includes(day)) ||
			new Set(hours.days).size !== hours.days.length
		)
			throw new Error(
				`invalid toolkit-handoff.json: allowedHours.days must be unique values from ${days.join(", ")}`,
			);
		if (
			typeof hours.start !== "string" ||
			!time.test(hours.start) ||
			typeof hours.end !== "string" ||
			!time.test(hours.end) ||
			minutes(hours.start) >= minutes(hours.end)
		)
			throw new Error(
				'invalid toolkit-handoff.json: allowedHours.start/end must be "HH:MM" (UTC, 24h) with start before end',
			);
	}
	return config;
}

// UTC only, matching the config's documented window.
export function withinAllowedHours(hours, now = new Date()) {
	if (!hours) return true;
	const day = days[now.getUTCDay()];
	if (!hours.days.includes(day)) return false;
	const current = now.getUTCHours() * 60 + now.getUTCMinutes();
	return current >= minutes(hours.start) && current < minutes(hours.end);
}
