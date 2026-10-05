// A ticket declares the paths it changes in a "## Files" or "## Touches"
// section, or a "Files:"/"Touches:" line. Without one, backticked paths in its
// acceptance criteria stand in. Returns null when nothing is declared, so the
// caller can tell blind admission from a ticket that changes no shared files.
const SECTION = (heading) =>
	new RegExp(
		`^##[^\\S\\n]+(?:${heading})\\b[^\\n]*\\n([\\s\\S]*?)(?=^##?\\s|$(?![\\s\\S]))`,
		"im",
	);
const FILES_SECTION = SECTION("Files|Touches");
const FILES_LINE = /^\s*(?:\*\*)?(?:Files|Touches):(?:\*\*)?[^\S\n]*(.+)$/im;
const CRITERIA_SECTION = SECTION("Acceptance criteria");
const PATH = /^[\w@.*?[\]{}/-]+$/;

function normalize(raw) {
	const path = raw
		.trim()
		.replace(/^[("'[]+|[)"',.;:\]]+$/g, "")
		.replaceAll("\\", "/")
		.replace(/^(?:\.\/)+/, "")
		.replace(/^\/+/, "")
		.replace(/\/{2,}/g, "/");
	if (!path || !PATH.test(path) || /^none$/i.test(path)) return null;
	// A glob covers the directory before its first wildcard segment.
	const segments = path.split("/");
	const wildcard = segments.findIndex((s) => /[*?[{]/.test(s));
	if (wildcard >= 0)
		return { path: segments.slice(0, wildcard).join("/"), dir: true };
	if (path.endsWith("/")) return { path: path.slice(0, -1), dir: true };
	return { path, dir: false };
}

function tokens(text) {
	const found = [];
	for (const line of text.split(/\r?\n/)) {
		const item = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "");
		if (!item.trim() || item.trimStart().startsWith("#")) continue;
		const quoted = [...item.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
		if (quoted.length) found.push(...quoted);
		else
			found.push(
				...item.split(",").map((part) => part.trim().split(/\s+/)[0] ?? ""),
			);
	}
	return found;
}

function unique(paths) {
	const seen = new Map();
	for (const p of paths)
		if (p && !seen.has(`${p.dir}:${p.path}`)) seen.set(`${p.dir}:${p.path}`, p);
	return [...seen.values()];
}

export function declaredFiles(body = "") {
	const text = body ?? "";
	const declared =
		FILES_SECTION.exec(text)?.[1] ?? FILES_LINE.exec(text)?.[1] ?? null;
	if (declared !== null) return unique(tokens(declared).map(normalize));
	const criteria = CRITERIA_SECTION.exec(text)?.[1];
	if (!criteria) return null;
	// Only backticked tokens with a directory separator count here, so method
	// names and commands in prose are not mistaken for files.
	const named = [...criteria.matchAll(/`([^`\n]+)`/g)]
		.map((m) => m[1])
		.filter((t) => t.includes("/") && !/^\w+:\/\//.test(t))
		.map(normalize);
	const paths = unique(named);
	return paths.length ? paths : null;
}

const covers = (dir, other) =>
	dir.path === "" ||
	other.path === dir.path ||
	other.path.startsWith(`${dir.path}/`);

function overlaps(a, b) {
	if (a.dir && covers(a, b)) return true;
	if (b.dir && covers(b, a)) return true;
	return a.path === b.path;
}

export const displayPath = (p) =>
	p.dir ? `${p.path ? `${p.path}/` : ""}**` : p.path;

// Paths from `mine` that overlap any path in `theirs`, for the skip report.
export function overlappingPaths(mine, theirs) {
	return mine
		.filter((a) => theirs.some((b) => overlaps(a, b)))
		.map(displayPath);
}
