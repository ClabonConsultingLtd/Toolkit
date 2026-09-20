import { readFileSync } from "node:fs";

export const CANONICAL_ROLES = [
	"needs-triage",
	"needs-info",
	"ready-for-agent",
	"ready-for-human",
	"wontfix",
];

const ROW_PATTERN = /^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/;

export function parseTriageLabels(markdown) {
	const mapping = {};
	for (const line of markdown.split("\n")) {
		const match = ROW_PATTERN.exec(line);
		if (!match) continue;
		const [, canonical, repoLabel] = match;
		if (CANONICAL_ROLES.includes(canonical)) mapping[canonical] = repoLabel;
	}
	const missing = CANONICAL_ROLES.filter((role) => !mapping[role]);
	if (missing.length)
		throw new Error(
			`triage-labels.md is missing a mapping for: ${missing.join(", ")}`,
		);
	return mapping;
}

export function readTriageLabels(path) {
	return parseTriageLabels(readFileSync(path, "utf8"));
}

export function statusLabels(mapping) {
	return CANONICAL_ROLES.map((role) => mapping[role]);
}
