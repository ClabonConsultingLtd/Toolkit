import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { blockers, issueNumber } from "./orchestration.mjs";
import {
	readClaudeCooldown,
	resolveCodexFallback,
} from "./provider-fallback.mjs";

export function helperIdentity() {
	const source = fileURLToPath(import.meta.url);
	return {
		version: JSON.parse(
			readFileSync(new URL("../package.json", import.meta.url), "utf8"),
		).version,
		source,
		sourceSha256: createHash("sha256")
			.update(readFileSync(source))
			.digest("hex"),
	};
}

export function gh(args) {
	return execFileSync("gh", args, {
		encoding: "utf8",
		timeout: 60_000,
		maxBuffer: 64 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});
}
function dependencyError(message, declaration) {
	const error = new Error(message);
	error.code = "INVALID_DEPENDENCY_DECLARATION";
	error.declaration = declaration;
	return error;
}
export function fallbackDependencies(body = "", repository) {
	const line =
		/^\s*(?:\*\*)?Blocked by:(?:\*\*)?[^\S\n]*(.*)$/im.exec(body)?.[1] ??
		/^##\s+Blocked by[^\S\n]*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/im
			.exec(body)?.[1]
			?.trim() ??
		"";
	if (!line) return [];
	let normalized = line.replace(/^\s*[-*+]\s+/gm, "").trim();
	const localUrl =
		/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/([1-9]\d*)$/gim;
	normalized = normalized.replace(localUrl, (_match, owner, repo, number) => {
		if (
			!repository ||
			`${owner}/${repo}`.toLowerCase() !== repository.toLowerCase()
		)
			throw dependencyError(
				"cross-repository dependency declarations require native GitHub edges",
				line,
			);
		return `#${number}`;
	});
	if (/[\w/.-]+#\d+|https?:\/\//.test(normalized))
		throw dependencyError(
			"cross-repository dependency declarations require native GitHub edges",
			line,
		);
	const refs = [...normalized.matchAll(/#([1-9]\d*)/g)].map((m) => m[1]);
	if (!refs.length && !/^none(?:\s*\([^()\n]*\))?\.?$/i.test(normalized))
		throw dependencyError("cannot parse Blocked by declaration", line);
	return [...new Set(refs)];
}
// A split ticket names its parent spec in a "## Parent" section or "Parent:" line.
export function parentReference(body = "", repository) {
	const text =
		/^##\s+Parent[^\S\n]*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/im.exec(body)?.[1] ??
		/^\s*(?:\*\*)?Parent:(?:\*\*)?[^\S\n]*(.*)$/im.exec(body)?.[1] ??
		"";
	const url =
		/https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/issues\/([1-9]\d*)/i.exec(text);
	if (url)
		return repository && url[1].toLowerCase() === repository.toLowerCase()
			? url[2]
			: null;
	return /(?:^|[^\w/.-])#([1-9]\d*)/.exec(text)?.[1] ?? null;
}
export function recommendation(body = "") {
	const match = /\*\*Claude:\*\*\s*`?([^`\n]+?)\s*\/\s*([\w-]+)`?\s*$/im.exec(
		body,
	);
	return match ? { model: match[1].trim(), effort: match[2].trim() } : null;
}
export function github(repository, exec = gh) {
	const json = (args) => JSON.parse(exec(args));
	function issue(number, withDependencies = true) {
		const n = issueNumber(number);
		const data = json([
			"issue",
			"view",
			n,
			"--repo",
			repository,
			"--json",
			"number,title,body,comments,labels,state,stateReason,url,assignees",
		]);
		let dependencies = [];
		if (withDependencies) {
			try {
				dependencies = json([
					"api",
					"--paginate",
					"--slurp",
					`repos/${repository}/issues/${n}/dependencies/blocked_by`,
				])
					.flat()
					.map((d) => {
						if (
							d.repository_url &&
							!d.repository_url
								.toLowerCase()
								.endsWith(`/repos/${repository.toLowerCase()}`)
						)
							throw new Error(
								"cross-repository dependency is not supported in this single-repository batch",
							);
						return issueNumber(d.number);
					});
				if (!dependencies.length)
					dependencies = fallbackDependencies(data.body, repository);
			} catch (error) {
				// Authentication, rate limits and transport errors must not silently erase blockers.
				const message = `${error.message} ${error.stderr ?? ""}`;
				if (error.code === "INVALID_DEPENDENCY_DECLARATION") {
					error.message = `Issue #${n} has an invalid "Blocked by" declaration: ${JSON.stringify(error.declaration)}. Accepted forms are "None", "#123", a local issue URL, or native GitHub dependencies.`;
					throw error;
				}
				if (!/HTTP (404|410|422)/.test(message)) throw error;
				try {
					dependencies = fallbackDependencies(data.body, repository);
				} catch (fallbackError) {
					fallbackError.message = `Issue #${n} has an invalid "Blocked by" declaration: ${JSON.stringify(fallbackError.declaration)}. Accepted forms are "None", "#123", a local issue URL, or native GitHub dependencies.`;
					throw fallbackError;
				}
			}
		}
		return {
			...data,
			number: n,
			labels: data.labels.map((l) => l.name),
			dependencies,
			recommendation: recommendation(data.body),
		};
	}
	let parents;
	// Parent specs are implemented through their sub-tickets, never directly.
	// Closed children still count: a split spec stays a spec. Fails closed.
	function subTickets(number) {
		const n = issueNumber(number);
		try {
			if (!parents) {
				parents = { children: new Map(), native: new Set() };
				// Project in gh: full issue and PR bodies overflow the exec buffer.
				const all = exec([
					"api",
					"--paginate",
					"--jq",
					".[] | select(.pull_request | not) | {number, body, sub_issues_summary}",
					`repos/${repository}/issues?state=all&per_page=100`,
				])
					.split("\n")
					.filter((line) => line.trim())
					.map((line) => JSON.parse(line))
					.filter((item) => !item.pull_request);
				for (const item of all) {
					const child = String(item.number);
					const parent = parentReference(item.body ?? "", repository);
					if (parent && parent !== child) {
						if (!parents.children.has(parent))
							parents.children.set(parent, new Set());
						parents.children.get(parent).add(child);
					}
					if (item.sub_issues_summary?.total > 0) parents.native.add(child);
				}
			}
			const children = new Set(parents.children.get(n));
			if (parents.native.has(n))
				for (const item of json([
					"api",
					"--paginate",
					"--slurp",
					`repos/${repository}/issues/${n}/sub_issues?per_page=100`,
				]).flat())
					children.add(String(item.number));
			return [...children].sort((a, b) => Number(a) - Number(b));
		} catch (error) {
			parents = undefined;
			throw new Error(
				`issue #${n}: cannot inspect sub-tickets: ${error.message}`,
				{ cause: error },
			);
		}
	}
	function pr(number) {
		return json([
			"pr",
			"view",
			issueNumber(number),
			"--repo",
			repository,
			"--json",
			"number,state,mergedAt,baseRefName,headRefName,headRefOid,headRepository,headRepositoryOwner,url,isDraft,statusCheckRollup",
		]);
	}
	return {
		issue,
		pr,
		requiredStatusChecks(branch) {
			const data = json([
				"api",
				`repos/${repository}/branches/${encodeURIComponent(branch)}/protection/required_status_checks`,
			]);
			if (!Array.isArray(data.contexts) || !Array.isArray(data.checks))
				throw new Error("required checks response is invalid");
			return [
				...new Set([
					...data.contexts,
					...data.checks.map((check) => check.context),
				]),
			];
		},
		subTickets,
		listReady() {
			return json([
				"api",
				"--paginate",
				"--slurp",
				`repos/${repository}/issues?state=open&labels=ready-for-agent&sort=created&direction=asc&per_page=100`,
			])
				.flat()
				.filter((item) => !item.pull_request);
		},
		hasImplementationPr(number) {
			const ticketNumber = issueNumber(number);
			let events;
			try {
				events = json([
					"api",
					"--paginate",
					"--slurp",
					`repos/${repository}/issues/${ticketNumber}/timeline?per_page=100`,
				]).flat();
			} catch (error) {
				throw new Error(
					`issue #${ticketNumber}: cannot inspect PR timeline: ${error.message}`,
					{ cause: error },
				);
			}
			for (const event of events) {
				const source = event.source?.issue;
				if (event.event !== "cross-referenced" || !source?.pull_request)
					continue;
				// Read the exact referenced PR, including references originating in another repo.
				let url;
				try {
					url = new URL(source.pull_request.url);
				} catch {
					throw new Error(
						`issue #${ticketNumber}: referenced PR has no valid API URL`,
					);
				}
				if (
					url.origin !== "https://api.github.com" ||
					!/^\/repos\/[^/]+\/[^/]+\/pulls\/[1-9]\d*$/.test(url.pathname) ||
					url.search ||
					url.hash
				)
					throw new Error(
						`issue #${ticketNumber}: invalid referenced PR API URL: ${url.href}`,
					);
				const apiRepo = url.pathname.split("/").slice(2, 4).join("/");
				const prNumber = Number(url.pathname.split("/").at(-1));
				const prUrl = `https://github.com/${apiRepo}/pull/${prNumber}`;
				let pull;
				try {
					pull = json(["api", url.pathname.slice(1)]);
				} catch (error) {
					throw new Error(
						`issue #${ticketNumber}: cannot inspect referenced PR ${prUrl}: ${error.message}`,
						{ cause: error },
					);
				}
				if (
					!pull ||
					typeof pull !== "object" ||
					Array.isArray(pull) ||
					pull.number !== prNumber ||
					!["open", "closed"].includes(pull.state) ||
					!(
						pull.merged_at === null ||
						(typeof pull.merged_at === "string" && pull.merged_at)
					)
				)
					throw new Error(
						`issue #${ticketNumber}: cannot verify state or identity of referenced PR ${prUrl}`,
					);
				if (pull.state === "closed" && !pull.merged_at) continue;
				const headRepo = pull.head?.repo?.full_name;
				const baseRepo = pull.base?.repo?.full_name;
				const headRef = pull.head?.ref;
				if (
					typeof headRepo !== "string" ||
					!headRepo ||
					typeof baseRepo !== "string" ||
					!baseRepo ||
					typeof headRef !== "string" ||
					!headRef
				)
					throw new Error(
						`issue #${ticketNumber}: cannot verify head.ref and repository of referenced PR ${prUrl}`,
					);
				if (baseRepo.toLowerCase() !== apiRepo.toLowerCase())
					throw new Error(
						`issue #${ticketNumber}: repository mismatch for referenced PR ${prUrl}`,
					);
				if (
					apiRepo.toLowerCase() !== repository.toLowerCase() ||
					headRepo.toLowerCase() !== repository.toLowerCase() ||
					baseRepo.toLowerCase() !== repository.toLowerCase()
				)
					continue;
				const implementationBranch = new RegExp(
					`^tickets/[a-z0-9][a-z0-9-]{0,59}/${ticketNumber}$`,
				);
				if (implementationBranch.test(headRef))
					return {
						number: prNumber,
						url: prUrl,
						evidence: `same-repository head.ref ${headRef}`,
					};
			}
			return false;
		},
		snapshot(state) {
			const issues = {};
			for (const n of Object.keys(state.tickets)) {
				try {
					issues[n] = issue(n);
				} catch (error) {
					if (error.code !== "INVALID_DEPENDENCY_DECLARATION") throw error;
					issues[n] = {
						number: n,
						state: "OPEN",
						labels: [],
						dependencies: [],
						recommendation: null,
						dependencyError: error.message,
					};
				}
				issues[n].subTickets = subTickets(n);
			}
			for (const item of Object.values(issues))
				for (const dep of item.dependencies)
					if (!issues[dep]) issues[dep] = issue(dep, false);
			return issues;
		},
		finalize(state, ticket, beforeWrite = () => {}) {
			if (!ticket.pr) throw new Error("no linked PR");
			const pull = pr(ticket.pr);
			verifyPr(state, ticket, pull);
			if (pull.state !== "MERGED" || !pull.mergedAt)
				throw new Error("PR is not merged");
			beforeWrite();
			exec([
				"label",
				"create",
				"done",
				"--repo",
				repository,
				"--color",
				"0E8A16",
				"--description",
				"Merged implementation",
				"--force",
			]);
			const current = issue(ticket.number, false);
			beforeWrite();
			const edit = [
				"issue",
				"edit",
				ticket.number,
				"--repo",
				repository,
				"--add-label",
				"done",
			];
			if (current.labels.includes("ready-for-agent"))
				edit.push("--remove-label", "ready-for-agent");
			exec(edit);
			beforeWrite();
			if (current.state !== "CLOSED")
				exec([
					"issue",
					"close",
					ticket.number,
					"--repo",
					repository,
					"--reason",
					"completed",
				]);
			const after = issue(ticket.number, false);
			if (
				after.state !== "CLOSED" ||
				!after.labels.includes("done") ||
				after.labels.includes("ready-for-agent")
			)
				throw new Error(
					"completion update not yet consistent; retry reconciliation",
				);
			Object.assign(ticket, {
				status: "completed",
				workerActive: false,
				mergedAt: pull.mergedAt,
				reason: null,
				blockKind: null,
			});
			return ticket;
		},
	};
}
export function verifyPr(state, ticket, pull) {
	const repo = `${pull.headRepositoryOwner?.login}/${pull.headRepository?.name}`;
	if (
		pull.baseRefName !== state.baseBranch ||
		pull.headRefName !== ticket.branch ||
		repo.toLowerCase() !== state.repository.toLowerCase()
	)
		throw new Error(
			"PR does not match the reserved branch, repository and base",
		);
}
export function requireReady(state, ticket, issues) {
	const issue = issues[ticket.number];
	if (issue.state !== "OPEN" || !issue.labels.includes("ready-for-agent"))
		throw new Error("issue is not open and ready-for-agent");
	if (issue.subTickets?.length)
		throw new Error(
			`issue is a parent spec; implement its sub-tickets ${issue.subTickets.map((n) => `#${n}`).join(", ")}`,
		);
	if (blockers(state, issue, issues).length)
		throw new Error("issue has unresolved dependencies");
	if (!issue.recommendation)
		throw new Error("missing Claude model/effort recommendation");
	return issue;
}

export function normalizeClaudeModels(models) {
	if (!Array.isArray(models) || models.length === 0)
		throw new Error("current Paseo Claude model catalog required");
	const catalog = models.map((model, index) => {
		if (!model || typeof model.id !== "string" || !model.id.trim())
			throw new Error(
				`invalid Paseo Claude model catalog: models[${index}].id required`,
			);
		// MCP list_models returns thinkingOptions as [{id, label}]; the CLI's
		// `provider models --json` returns it as a display string alongside a
		// thinkingOptionIds array. Prefer the structured array, then the IDs.
		let thinkingOptions = Array.isArray(model.thinkingOptions)
			? model.thinkingOptions
			: undefined;
		if (!thinkingOptions && Array.isArray(model.thinkingOptionIds))
			thinkingOptions = model.thinkingOptionIds.map((id) => ({ id }));
		// An entry advertising no effort metadata at all (e.g. a bare alias)
		// cannot satisfy any recommendation; keep it but make it unselectable
		// instead of rejecting the valid entries around it.
		if (
			!thinkingOptions &&
			model.thinkingOptions == null &&
			model.thinkingOptionIds == null
		)
			thinkingOptions = [];
		if (
			!Array.isArray(thinkingOptions) ||
			thinkingOptions.some(
				(option) =>
					!option || typeof option.id !== "string" || !option.id.trim(),
			)
		)
			throw new Error(
				`invalid Paseo Claude model catalog: models[${index}].thinkingOptions must be an array of {id} (or thinkingOptionIds an array of IDs)`,
			);
		return { ...model, thinkingOptions };
	});
	if (!catalog.some((model) => model.thinkingOptions.length))
		throw new Error(
			"invalid Paseo Claude model catalog: no model advertises thinkingOptions (or thinkingOptionIds)",
		);
	return catalog;
}

export function resolveRuntime(rec, models) {
	if (!rec) throw new Error("Claude recommendation required");
	const catalog = normalizeClaudeModels(models);
	const wanted = rec.model.toLowerCase();
	const capable = catalog.filter((m) =>
		m.thinkingOptions?.some((o) => o.id === rec.effort),
	);
	let model = capable.find(
		(m) => m.id.toLowerCase() === wanted || m.label?.toLowerCase() === wanted,
	);
	if (!model && ["sonnet", "opus", "haiku"].includes(wanted)) {
		model = capable
			.filter((m) => new RegExp(`^claude-${wanted}-[\\d-]+$`).test(m.id))
			.sort((a, b) => b.id.localeCompare(a.id, "en", { numeric: true }))[0];
	}
	if (!model)
		throw new Error(
			`unsupported Claude recommendation: ${rec.model} / ${rec.effort}`,
		);
	return { provider: `claude/${model.id}`, thinkingOptionId: rec.effort };
}

export function resolveWorkerRuntime(rec, input, options = {}) {
	const cooldown = readClaudeCooldown(options.statePath, options.now);
	return cooldown.active
		? resolveCodexFallback(rec, input.codexModels)
		: resolveRuntime(rec, input.models);
}
