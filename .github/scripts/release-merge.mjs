// Decides whether a push to main is the merge of the release PR, so the
// publish workflow only enters the release environment for a release.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

// The release PR merged as exactly this commit, from this repository's own
// release/next branch into main.
export function releasePullRequest(pulls, { sha, repository }) {
	return (
		pulls.find(
			(pr) =>
				pr.merged_at &&
				pr.merge_commit_sha === sha &&
				pr.base?.ref === "main" &&
				pr.head?.ref === "release/next" &&
				pr.head?.repo?.full_name === repository,
		) ?? null
	);
}

export function mergedPullNumber(subject) {
	const match = /^Merge pull request #(\d+) from /.exec(subject);
	return match ? Number(match[1]) : null;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const { GITHUB_REPOSITORY: repository, GITHUB_SHA: sha } = process.env;
	const api = (path) =>
		JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8" }));
	// The commit's associated PRs, plus the one its merge subject names, in
	// case the association isn't indexed yet.
	const pulls = api(`repos/${repository}/commits/${sha}/pulls`);
	const number = mergedPullNumber(
		execFileSync("git", ["log", "-1", "--format=%s", sha], {
			encoding: "utf8",
		}).trim(),
	);
	if (number !== null) pulls.push(api(`repos/${repository}/pulls/${number}`));
	const release = releasePullRequest(pulls, { sha, repository });
	console.log(
		release
			? `${sha} merges release PR #${release.number}`
			: `${sha} is not a release merge; the release job is skipped`,
	);
	appendFileSync(
		process.env.GITHUB_OUTPUT,
		`release=${release ? "true" : "false"}\n`,
	);
}
