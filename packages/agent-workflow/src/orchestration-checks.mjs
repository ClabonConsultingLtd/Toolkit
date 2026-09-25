// A check run has a name/status/conclusion; a commit status has a context/state.
function checkName(check) {
	return check.name ?? check.context;
}
function successful(check, required = false) {
	if (check.status !== undefined)
		return (
			check.status === "COMPLETED" &&
			(required ? check.conclusion === "SUCCESS" : ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.conclusion))
		);
	return check.state === "SUCCESS";
}

export function requirePassingChecks(rollup, requiredChecks = []) {
	if (!Array.isArray(rollup)) throw new Error("PR checks are unavailable");
	const missing = requiredChecks.filter(
		(name) => !rollup.some((check) => checkName(check) === name),
	);
	const unsuccessful = rollup
		.filter((check) => !successful(check, requiredChecks.includes(checkName(check))))
		.map((check) => checkName(check) ?? "unnamed check");
	if (missing.length || unsuccessful.length)
		throw new Error(
			[
				missing.length && `missing required checks: ${missing.join(", ")}`,
				unsuccessful.length &&
					`pending or unsuccessful checks: ${unsuccessful.join(", ")}`,
			]
				.filter(Boolean)
				.join("; "),
		);
}

// Classify GitHub's mergeable/mergeStateStatus pair. GitHub reports BEHIND only
// when the base branch requires up-to-date heads, so it blocks merging too.
export function mergeState(pr) {
	const { mergeable, mergeStateStatus } = pr ?? {};
	const detail = `mergeable ${mergeable ?? "missing"}, mergeStateStatus ${mergeStateStatus ?? "missing"}`;
	if (mergeable === "CONFLICTING" || mergeStateStatus === "DIRTY")
		return {
			state: "conflicting",
			reason: `PR conflicts with its base branch (${detail}); update from base, resolve conflicts, re-verify and push`,
		};
	if (mergeStateStatus === "BEHIND")
		return {
			state: "behind",
			reason: `PR head is behind a base branch that requires up-to-date branches (${detail}); update from base, re-verify and push`,
		};
	if (mergeable === "UNKNOWN" || mergeStateStatus === "UNKNOWN")
		return {
			state: "pending",
			reason: `PR merge state is still being computed by GitHub (${detail}); retry shortly`,
		};
	if (mergeable === undefined || mergeStateStatus === undefined)
		return { state: "unavailable", reason: "PR merge state is unavailable" };
	return { state: "mergeable", reason: null };
}

export function requireMergeable(pr) {
	const { state, reason } = mergeState(pr);
	if (state !== "mergeable") throw new Error(reason);
}
