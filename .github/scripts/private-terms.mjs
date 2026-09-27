// Redacts private terms from issue, pull request and comment text as soon as
// it is posted. The terms come from the FORBIDDEN_TERMS secret (an extended
// regex) and are never printed.
import { readFileSync } from "node:fs";

export const LABEL = "privacy-review";
export const REDACTED = "[redacted]";

export function termPattern(source) {
	return new RegExp(source, "gi");
}

/** Replace every match; `count` is how many were replaced. */
export function redact(text, pattern) {
	if (!text) return { text, count: 0 };
	let count = 0;
	const redacted = text.replace(pattern, () => {
		count++;
		return REDACTED;
	});
	return { text: redacted, count };
}

/**
 * What the event lets us check: the API object to update, its text fields,
 * the issue or pull request to label, and text we can flag but not edit.
 */
export function target(eventName, event) {
	switch (eventName) {
		case "issues":
			return {
				url: event.issue.url,
				method: "PATCH",
				fields: { title: event.issue.title, body: event.issue.body },
				number: event.issue.number,
			};
		case "issue_comment":
			return {
				url: event.comment.url,
				method: "PATCH",
				fields: { body: event.comment.body },
				number: event.issue.number,
			};
		case "pull_request_target":
			return {
				url: event.pull_request.url,
				method: "PATCH",
				fields: {
					title: event.pull_request.title,
					body: event.pull_request.body,
				},
				number: event.pull_request.number,
				readOnly: [event.pull_request.head.ref],
			};
		case "pull_request_review_comment":
			return {
				url: event.comment.url,
				method: "PATCH",
				fields: { body: event.comment.body },
				number: event.pull_request.number,
			};
		case "pull_request_review":
			return {
				url: `${event.pull_request.url}/reviews/${event.review.id}`,
				method: "PUT",
				fields: { body: event.review.body },
				number: event.pull_request.number,
			};
		default:
			throw new Error(`unsupported event: ${eventName}`);
	}
}

/** Redacted fields to send back, the total match count, and read-only hits. */
export function plan(found, pattern) {
	const update = {};
	let count = 0;
	for (const [name, value] of Object.entries(found.fields)) {
		const result = redact(value, pattern);
		if (result.count > 0) {
			update[name] = result.text;
			count += result.count;
		}
	}
	const readOnlyHits = (found.readOnly ?? []).filter((value) =>
		termPattern(pattern.source).test(value),
	).length;
	return { update, count, readOnlyHits };
}

async function api(url, method, body) {
	const response = await fetch(url, {
		method,
		headers: {
			authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
			accept: "application/vnd.github+json",
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	});
	if (!response.ok)
		throw new Error(`${method} ${url} failed: ${response.status}`);
}

async function main() {
	const source = process.env.FORBIDDEN_TERMS;
	if (!source) {
		console.log(
			"::notice::FORBIDDEN_TERMS is not available to this run; skipping",
		);
		return;
	}
	const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
	const found = target(process.env.GITHUB_EVENT_NAME, event);
	const { update, count, readOnlyHits } = plan(found, termPattern(source));
	if (count === 0 && readOnlyHits === 0) return;
	if (count > 0) await api(found.url, found.method, update);
	const repo = process.env.GITHUB_REPOSITORY;
	await api(
		`${process.env.GITHUB_API_URL}/repos/${repo}/issues/${found.number}/labels`,
		"POST",
		{ labels: [LABEL] },
	);
	if (count > 0)
		console.log(
			`::error::Redacted ${count} private term(s) in #${found.number}`,
		);
	if (readOnlyHits > 0)
		console.log(
			`::error::The branch name of #${found.number} contains a private term`,
		);
	process.exitCode = 1;
}

if (process.argv[1] === import.meta.filename) await main();
