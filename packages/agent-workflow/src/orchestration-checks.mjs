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
