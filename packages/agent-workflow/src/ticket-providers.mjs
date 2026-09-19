import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_STATUS_PATTERN = /^\*\*Status:\*\*\s*(.+)$/im;

function localMarkdownStatus(ticketRef, config) {
	const pattern = config.statusPattern
		? new RegExp(config.statusPattern, "im")
		: DEFAULT_STATUS_PATTERN;
	const found = pattern.exec(readFileSync(ticketRef, "utf8"))?.[1]?.trim();
	if (!found) throw new Error(`ticket has no Status declaration: ${ticketRef}`);
	return found;
}

function defaultGhExec(args) {
	return execFileSync("gh", args, { encoding: "utf8" });
}

function githubIssueStatus(ticketRef, config, { exec = defaultGhExec } = {}) {
	const prefix = config.statusLabelPrefix ?? "status:";
	const raw = exec(["issue", "view", ticketRef, "--json", "labels,state"]);
	const data = JSON.parse(raw);
	const label = data.labels
		?.map((entry) => entry.name)
		.find((name) => name.startsWith(prefix));
	if (label) return label.slice(prefix.length);
	if (data.state === "CLOSED") return config.closedStatus ?? "closed";
	throw new Error(`github issue has no ${prefix} label: #${ticketRef}`);
}

export const providers = {
	"local-markdown": {
		resolveReference(reference, base) {
			return resolve(base, reference);
		},
		getStatus: localMarkdownStatus,
	},
	github: {
		resolveReference(reference) {
			return String(reference).replace(/^#/, "");
		},
		getStatus: githubIssueStatus,
	},
};

export function resolveProvider(config, overrides = {}) {
	const name = config.provider ?? "local-markdown";
	const provider = providers[name];
	if (!provider) throw new Error(`unknown ticket provider: ${name}`);
	return {
		resolveReference: provider.resolveReference,
		getStatus: (ticketRef, cfg) =>
			provider.getStatus(ticketRef, cfg, overrides),
	};
}
