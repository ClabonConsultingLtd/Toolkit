import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const ONE_HOUR = 60 * 60 * 1000;

export function fallbackStatePath(env = process.env) {
	const root =
		env.TOOLKIT_STATE_DIR ??
		env.XDG_STATE_HOME ??
		join(homedir(), ".local", "state");
	return join(root, "toolkit", "agent-workflow", "claude-cooldown.json");
}

const MONTHS = [
	"jan",
	"feb",
	"mar",
	"apr",
	"may",
	"jun",
	"jul",
	"aug",
	"sep",
	"oct",
	"nov",
	"dec",
];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const LIMIT_KIND =
	"(?:claude|usage|session|weekly|daily|opus|sonnet|5.hour|five.hour|seven.day)";

export function parseClaudeLimit(message, now = Date.now()) {
	if (typeof message !== "string") return null;
	// A generic HTTP 429 may be transient or come from GitHub or another tool.
	if (
		!new RegExp(
			`you['’]ve (?:hit|reached) your (?:${LIMIT_KIND}[ -]){0,3}limit|claude (?:code )?usage limit (?:reached|exceeded)|(?:session|weekly|opus|sonnet|5.hour|seven.day) (?:usage )?limit (?:reached|exceeded)|usage limit (?:reached|exceeded).*(?:claude|anthropic)`,
			"i",
		).test(message)
	)
		return null;
	const iso =
		/(?:reset(?:s)?(?: at| on|:)?|until)\s+(\d{4}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d)?(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d))/i.exec(
			message,
		)?.[1];
	let resetAt = iso ? Date.parse(iso.replace(" ", "T")) : NaN;
	if (!Number.isFinite(resetAt)) resetAt = parseUtcClockReset(message, now);
	return { resetAt: Number.isFinite(resetAt) ? resetAt : null };
}

// Claude prints "resets 6:20pm (UTC)" within a day and may prefix a weekday or
// month/day ("resets Fri 1pm (UTC)", "resets Oct 3, 1pm (UTC)") for later resets.
function parseUtcClockReset(message, now) {
	const match =
		/(?:reset(?:s)?(?: at| on|:)?|until)\s+(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?,?\s+)?(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+)?(?:at\s+)?(\d{1,2})(?::(\d\d))?\s*(am|pm)\s*\((?:UTC|GMT)\)/i.exec(
			message,
		);
	if (!match) return NaN;
	const [, weekday, month, day, hourText, minuteText = "0", meridiem] = match;
	const hour = Number(hourText);
	const minute = Number(minuteText);
	if (hour < 1 || hour > 12 || minute > 59) return NaN;
	const hours = (hour % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0);
	const date = new Date(now);
	const year = date.getUTCFullYear();
	if (month) {
		const monthIndex = MONTHS.indexOf(month.toLowerCase());
		const dayOfMonth = Number(day);
		let resetAt = Date.UTC(year, monthIndex, dayOfMonth, hours, minute);
		if (new Date(resetAt).getUTCDate() !== dayOfMonth) return NaN;
		// A date well in the past is next year's (for example a December message
		// naming January); a recent past date is a stale message, left as is.
		if (resetAt < now - 180 * 24 * ONE_HOUR)
			resetAt = Date.UTC(year + 1, monthIndex, dayOfMonth, hours, minute);
		return resetAt;
	}
	let resetAt = Date.UTC(
		year,
		date.getUTCMonth(),
		date.getUTCDate(),
		hours,
		minute,
	);
	if (weekday) {
		const offset =
			(WEEKDAYS.indexOf(weekday.toLowerCase()) - date.getUTCDay() + 7) % 7;
		resetAt += offset * 24 * ONE_HOUR;
		if (resetAt <= now) resetAt += 7 * 24 * ONE_HOUR;
	} else if (resetAt <= now) resetAt += 24 * ONE_HOUR;
	return resetAt;
}

export function readClaudeCooldown(
	path = fallbackStatePath(),
	now = Date.now(),
) {
	if (!existsSync(path)) return { active: false, resetAt: null };
	const state = JSON.parse(readFileSync(path, "utf8"));
	if (
		state.version !== 1 ||
		state.provider !== "claude" ||
		!Number.isFinite(Date.parse(state.resetAt))
	)
		throw new Error(`invalid Claude cooldown state: ${path}`);
	return { ...state, active: Date.parse(state.resetAt) > now };
}

export function recordClaudeLimit(
	path,
	message,
	{ agentId = null, failureKey, now = Date.now() } = {},
) {
	const limit = parseClaudeLimit(message, now);
	if (!limit) throw new Error("explicit Claude usage-limit error required");
	if (agentId !== null && (typeof agentId !== "string" || !agentId.trim()))
		throw new Error("agentId must be a nonempty string");
	if (typeof failureKey !== "string" || !failureKey.trim())
		throw new Error(
			"failureKey required for idempotent Claude limit recording",
		);
	const keyHash = createHash("sha256").update(failureKey).digest("hex");
	mkdirSync(dirname(path), { recursive: true });
	const mutex = `${path}.mutex`;
	try {
		mkdirSync(mutex);
	} catch (error) {
		if (error.code === "EEXIST")
			throw new Error(`Claude cooldown state busy: ${mutex}`);
		throw error;
	}
	try {
		const current = readClaudeCooldown(path, now);
		if (current.failureKeys?.includes(keyHash)) return current;
		const proposed =
			limit.resetAt && limit.resetAt > now ? limit.resetAt : now + ONE_HOUR;
		const resetAt = Math.max(
			proposed,
			current.active ? Date.parse(current.resetAt) : 0,
		);
		const state = {
			version: 1,
			provider: "claude",
			detectedAt: new Date(now).toISOString(),
			resetAt: new Date(resetAt).toISOString(),
			agentId,
			failureKeys: [...(current.failureKeys ?? []), keyHash],
		};
		const temporary = `${path}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
				mode: 0o600,
			});
			renameSync(temporary, path);
		} finally {
			rmSync(temporary, { force: true });
		}
		return { ...state, active: true };
	} finally {
		rmSync(mutex, { recursive: true, force: true });
	}
}

export function resolveCodexFallback(rec, models) {
	if (!rec || typeof rec.model !== "string" || typeof rec.effort !== "string")
		throw new Error("Claude recommendation required for Codex fallback");
	const name = rec.model.toLowerCase();
	const tier = /(?:^|[\s-])(opus|fable)(?:$|[\s-])/.test(name)
		? "astra"
		: /(?:^|[\s-])sonnet(?:$|[\s-])/.test(name)
			? "sol"
			: /(?:^|[\s-])haiku(?:$|[\s-])/.test(name)
				? "luna"
				: null;
	if (!tier)
		throw new Error(
			`unsupported Claude recommendation for Codex fallback: ${rec.model}`,
		);
	const effort =
		rec.effort === "off"
			? "low"
			: rec.effort === "ultracode"
				? "ultra"
				: rec.effort;
	const id = `gpt-6-${tier}`;
	const model = normalizeCodexModels(models).find((item) => item.id === id);
	const options = model?.thinkingOptionIds;
	if (!Array.isArray(options) || !options.includes(effort))
		throw new Error(`unsupported Codex fallback: ${id} / ${effort}`);
	return {
		provider: `codex/${id}`,
		thinkingOptionId: effort,
		fallbackFrom: `${rec.model} / ${rec.effort}`,
	};
}

export function normalizeCodexModels(models) {
	if (!Array.isArray(models) || !models.length)
		throw new Error(
			"current Paseo Codex model catalog required during Claude cooldown",
		);
	return models.map((model, index) => {
		const options = Array.isArray(model?.thinkingOptions)
			? model.thinkingOptions.map((option) => option?.id)
			: Array.isArray(model?.thinkingOptionIds)
				? model.thinkingOptionIds
				: model?.thinkingOptions == null && model?.thinkingOptionIds == null
					? []
					: null;
		if (
			typeof model?.id !== "string" ||
			!model.id.trim() ||
			!Array.isArray(options) ||
			options.some((id) => typeof id !== "string" || !id.trim())
		)
			throw new Error(
				`invalid Paseo Codex model catalog: models[${index}] requires id and thinking options`,
			);
		return { ...model, thinkingOptionIds: options };
	});
}
