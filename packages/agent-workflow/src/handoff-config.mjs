import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const fields = new Set(["version", "gates", "allowedHours"]);
const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const time = /^([01]\d|2[0-3]):([0-5]\d)$/;

function minutes(value) {
	const [, h, m] = time.exec(value);
	return Number(h) * 60 + Number(m);
}

// "24:00" means end of day; it is only valid as an end time.
function isEnd(value) {
	return value === "24:00" || time.test(value);
}

function endMinutes(value) {
	return value === "24:00" ? 24 * 60 : minutes(value);
}

function validateWindow(window, prefix) {
	if (!window || typeof window !== "object" || Array.isArray(window))
		throw new Error(
			`invalid toolkit-handoff.json: ${prefix} must be an object`,
		);
	if (
		!Array.isArray(window.days) ||
		!window.days.length ||
		window.days.some((day) => !days.includes(day)) ||
		new Set(window.days).size !== window.days.length
	)
		throw new Error(
			`invalid toolkit-handoff.json: ${prefix}.days must be unique values from ${days.join(", ")}`,
		);
	if (
		typeof window.start !== "string" ||
		!time.test(window.start) ||
		typeof window.end !== "string" ||
		!isEnd(window.end) ||
		minutes(window.start) >= endMinutes(window.end)
	)
		throw new Error(
			`invalid toolkit-handoff.json: ${prefix}.start/end must be "HH:MM" (UTC, 24h; end may also be "24:00") with start before end`,
		);
}

export function describeAllowedHours(hours) {
	const windows = Array.isArray(hours) ? hours : [hours];
	return windows
		.map(
			(window) =>
				`UTC ${window.start}-${window.end} on ${window.days.join(", ")}`,
		)
		.join("; ");
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
		const windows = Array.isArray(hours) ? hours : [hours];
		if (!windows.length)
			throw new Error(
				"invalid toolkit-handoff.json: allowedHours must be a non-empty array of windows",
			);
		windows.forEach((window, index) => {
			validateWindow(
				window,
				Array.isArray(hours) ? `allowedHours[${index}]` : "allowedHours",
			);
		});
	}
	return config;
}

// UTC only, matching the config's documented window(s).
export function withinAllowedHours(hours, now = new Date()) {
	if (!hours) return true;
	const windows = Array.isArray(hours) ? hours : [hours];
	const day = days[now.getUTCDay()];
	const current = now.getUTCHours() * 60 + now.getUTCMinutes();
	return windows.some(
		(window) =>
			window.days.includes(day) &&
			current >= minutes(window.start) &&
			current < endMinutes(window.end),
	);
}
