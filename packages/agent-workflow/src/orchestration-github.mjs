import { execFileSync } from "node:child_process";
import { blockers, issueNumber } from "./orchestration.mjs";

export function gh(args) {
	return execFileSync("gh", args, {
		encoding: "utf8",
		timeout: 60_000,
		stdio: ["ignore", "pipe", "pipe"],
	});
}
export function fallbackDependencies(body = "") {
	const line =
		/^\s*(?:\*\*)?Blocked by:(?:\*\*)?[^\S\n]*(.*)$/im.exec(body)?.[1] ??
		/^##\s+Blocked by[^\S\n]*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/im
			.exec(body)?.[1]
			?.trim() ??
		"";
	if (!line) return [];
	if (/[\w/.-]+#\d+|https?:\/\//.test(line))
		throw new Error(
			"cross-repository dependency declarations require native GitHub edges",
		);
	const refs = [...line.matchAll(/#([1-9]\d*)/g)].map((m) => m[1]);
	if (!refs.length && !/^none\.?$/i.test(line.trim()))
		throw new Error("cannot parse Blocked by declaration");
	return [...new Set(refs)];
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
			"number,title,body,comments,labels,state,stateReason,url",
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
					dependencies = fallbackDependencies(data.body);
			} catch (error) {
				// Authentication, rate limits and transport errors must not silently erase blockers.
				const message = `${error.message} ${error.stderr ?? ""}`;
				if (!/HTTP (404|410|422)/.test(message)) throw error;
				dependencies = fallbackDependencies(data.body);
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
		snapshot(state) {
			const issues = {};
			for (const n of Object.keys(state.tickets)) issues[n] = issue(n);
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
	if (blockers(state, issue, issues).length)
		throw new Error("issue has unresolved dependencies");
	if (!issue.recommendation)
		throw new Error("missing Claude model/effort recommendation");
	return issue;
}

export function resolveRuntime(rec, models) {
	if (!rec || !Array.isArray(models))
		throw new Error("recommendation and Paseo model catalog required");
	const wanted = rec.model.toLowerCase();
	const capable = models.filter((m) =>
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
