import assert from "node:assert/strict";
import test from "node:test";
import { mergedPullNumber, releasePullRequest } from "./release-merge.mjs";

const sha = "a".repeat(40);
const repository = "owner/Toolkit";

function pull(overrides = {}) {
	return {
		number: 7,
		merged_at: "2026-09-29T12:00:00Z",
		merge_commit_sha: sha,
		base: { ref: "main" },
		head: { ref: "release/next", repo: { full_name: repository } },
		...overrides,
	};
}

test("the merge of the release PR into main is a release merge", () => {
	assert.equal(releasePullRequest([pull()], { sha, repository }).number, 7);
});

test("a push that isn't the release PR's merge is not a release merge", () => {
	const cases = {
		"no pull request": [],
		"another branch's PR": [
			pull({ head: { ref: "feat/x", repo: { full_name: repository } } }),
		],
		"an unmerged PR": [pull({ merged_at: null })],
		"a different merge commit": [pull({ merge_commit_sha: "b".repeat(40) })],
		"a PR into another base": [pull({ base: { ref: "develop" } })],
		"a fork's release/next": [
			pull({
				head: { ref: "release/next", repo: { full_name: "fork/Toolkit" } },
			}),
		],
		"a deleted head repository": [
			pull({ head: { ref: "release/next", repo: null } }),
		],
	};
	for (const [name, pulls] of Object.entries(cases))
		assert.equal(releasePullRequest(pulls, { sha, repository }), null, name);
});

test("mergedPullNumber reads the PR number from a merge commit's subject", () => {
	assert.equal(
		mergedPullNumber("Merge pull request #141 from owner/release/next"),
		141,
	);
	assert.equal(mergedPullNumber("Release v0.13.0"), null);
	assert.equal(mergedPullNumber("docs: see #12"), null);
});
