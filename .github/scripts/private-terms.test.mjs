import assert from "node:assert/strict";
import test from "node:test";
import {
	plan,
	REDACTED,
	redact,
	target,
	termPattern,
} from "./private-terms.mjs";

const pattern = termPattern("secretproject|\\bhost\\b|other-repo");

test("redacts every match regardless of case and counts them", () => {
	assert.deepEqual(redact("From SecretProject and other-repo#12.", pattern), {
		text: `From ${REDACTED} and ${REDACTED}#12.`,
		count: 2,
	});
	assert.deepEqual(redact("hostname stays", pattern), {
		text: "hostname stays",
		count: 0,
	});
	assert.deepEqual(redact(null, pattern), { text: null, count: 0 });
});

test("updates only the fields that matched", () => {
	const found = target("issues", {
		issue: {
			url: "https://api/issues/5",
			number: 5,
			title: "Clean title",
			body: "Seen on the host",
		},
	});
	assert.deepEqual(plan(found, pattern), {
		update: { body: `Seen on the ${REDACTED}` },
		count: 1,
		readOnlyHits: 0,
	});
});

test("flags a pull request branch name it cannot edit", () => {
	const found = target("pull_request_target", {
		pull_request: {
			url: "https://api/pulls/7",
			number: 7,
			title: "Tidy",
			body: null,
			head: { ref: "fix/secretproject-gate" },
		},
	});
	assert.deepEqual(plan(found, pattern), {
		update: {},
		count: 0,
		readOnlyHits: 1,
	});
});

test("targets comments and reviews at their own API objects", () => {
	const pull_request = { url: "https://api/pulls/7", number: 7 };
	assert.equal(
		target("issue_comment", {
			issue: { number: 3 },
			comment: { url: "https://api/comments/9", body: "x" },
		}).number,
		3,
	);
	assert.equal(
		target("pull_request_review_comment", {
			pull_request,
			comment: { url: "https://api/pulls/comments/4", body: "x" },
		}).url,
		"https://api/pulls/comments/4",
	);
	const review = target("pull_request_review", {
		pull_request,
		review: { id: 11, body: "x" },
	});
	assert.equal(review.url, "https://api/pulls/7/reviews/11");
	assert.equal(review.method, "PUT");
	assert.throws(() => target("push", {}), /unsupported event/);
});
