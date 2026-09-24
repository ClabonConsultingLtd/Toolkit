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

export function parseClaudeLimit(message, now = Date.now()) {
	if (typeof message !== "string") return null;
	// A generic HTTP 429 may be transient or come from GitHub or another tool.
	if (
		!/(?:you['’]ve (?:hit|reached) your (?:claude )?(?:usage |session )?limit|claude (?:code )?usage limit (?:reached|exceeded)|(?:session|weekly|5.hour|seven.day) (?:usage )?limit (?:reached|exceeded)|usage limit (?:reached|exceeded).*(?:claude|anthropic))/i.test(
			message,
		)
	)
		return null;
	const iso =
		/(?:reset(?:s)?(?: at| on|:)?|until)\s+(\d{4}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d)?(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d))/i.exec(
			message,
		)?.[1];
	let resetAt = iso ? Date.parse(iso.replace(" ", "T")) : NaN;
	if (!Number.isFinite(resetAt)) {
		const utcTime =
			/(?:reset(?:s)?(?: at| on|:)?|until)\s+(\d{1,2}):(\d\d)\s*(am|pm)\s*\(UTC\)/i.exec(
				message,
			);
		if (utcTime) {
			const hour = Number(utcTime[1]);
			const minute = Number(utcTime[2]);
			if (hour >= 1 && hour <= 12 && minute <= 59) {
				const date = new Date(now);
				resetAt = Date.UTC(
					date.getUTCFullYear(),
					date.getUTCMonth(),
					date.getUTCDate(),
					(hour % 12) + (utcTime[3].toLowerCase() === "pm" ? 12 : 0),
					minute,
				);
				if (resetAt <= now) resetAt += 24 * ONE_HOUR;
			}
		}
	}
	return { resetAt: Number.isFinite(resetAt) ? resetAt : null };
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
