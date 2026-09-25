// Pure, idempotent edits to files the wizard shares with the repository
// owner. Each returns the new content and whether anything changed.

/** Append each missing line to a line-based file such as .gitignore. */
export function ensureLines(text, lines) {
	const present = new Set(text.split(/\r?\n/).map((line) => line.trim()));
	const missing = lines.filter((line) => !present.has(line));
	if (missing.length === 0) return { text, changed: false };
	const base = text === "" || text.endsWith("\n") ? text : `${text}\n`;
	return { text: `${base}${missing.join("\n")}\n`, changed: true };
}

/** Append a Markdown section unless a heading with the same text exists. */
export function ensureSection(text, heading, body) {
	const title = heading.replace(/^#+\s*/, "").trim();
	const exists = text
		.split(/\r?\n/)
		.some(
			(line) =>
				/^#{1,6}\s/.test(line) && line.replace(/^#+\s*/, "").trim() === title,
		);
	if (exists) return { text, changed: false };
	const section = `${heading}\n\n${body.trim()}\n`;
	if (text.trim() === "") return { text: section, changed: true };
	const base = text.endsWith("\n") ? text : `${text}\n`;
	return { text: `${base}\n${section}`, changed: true };
}

/**
 * Merge hook groups and permission rules into Claude settings. A hook group is
 * added only when none of its commands is already registered for that event,
 * so repeated runs and hand-merged settings are left alone.
 */
export function mergeClaudeSettings(settings, { hooks = {}, allow = [] }) {
	const result = structuredClone(settings ?? {});
	let changed = false;
	for (const [event, groups] of Object.entries(hooks)) {
		result.hooks ??= {};
		result.hooks[event] ??= [];
		const registered = new Set(
			result.hooks[event].flatMap((group) =>
				(group?.hooks ?? []).map((hook) => hook?.command),
			),
		);
		for (const group of groups) {
			if (group.hooks.some((hook) => registered.has(hook.command))) continue;
			result.hooks[event].push(structuredClone(group));
			changed = true;
		}
	}
	if (allow.length > 0) {
		result.permissions ??= {};
		result.permissions.allow ??= [];
		for (const rule of allow) {
			if (result.permissions.allow.includes(rule)) continue;
			result.permissions.allow.push(rule);
			changed = true;
		}
	}
	return { settings: result, changed };
}

/**
 * Add package.json scripts. An existing script with a different command is
 * reported as a conflict and kept.
 */
export function mergeScripts(pkg, scripts) {
	const result = structuredClone(pkg ?? {});
	result.scripts ??= {};
	const added = [],
		conflicts = [];
	for (const [name, command] of Object.entries(scripts)) {
		if (result.scripts[name] === undefined) {
			result.scripts[name] = command;
			added.push(name);
		} else if (result.scripts[name] !== command) conflicts.push(name);
	}
	return { pkg: result, added, conflicts };
}

/** JSON with the indentation an existing file uses (tab by default). */
export function formatJson(value, previousText = "") {
	const indent = /^([ \t]+)"/m.exec(previousText)?.[1] ?? "\t";
	return `${JSON.stringify(value, null, indent)}\n`;
}
