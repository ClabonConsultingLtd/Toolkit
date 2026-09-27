import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	readRepositoryHandoffConfig,
	withinAllowedHours,
} from "../src/handoff-config.mjs";

function checkout(config) {
	const cwd = mkdtempSync(join(tmpdir(), "handoff-config-"));
	writeFileSync(join(cwd, "toolkit-handoff.json"), JSON.stringify(config));
	return cwd;
}

test("returns null when no config file exists", () => {
	assert.equal(
		readRepositoryHandoffConfig(mkdtempSync(join(tmpdir(), "no-config-"))),
		null,
	);
});

test("reads gates and allowedHours", () => {
	const config = readRepositoryHandoffConfig(
		checkout({
			version: 1,
			gates: ["scripts/gate.mjs"],
			allowedHours: { days: ["mon", "tue"], start: "08:00", end: "18:00" },
		}),
	);
	assert.deepEqual(config.gates, ["scripts/gate.mjs"]);
	assert.deepEqual(config.allowedHours.days, ["mon", "tue"]);
});

test("rejects an absolute or escaping gate path", () => {
	assert.throws(
		() => readRepositoryHandoffConfig(checkout({ version: 1, gates: ["/x.mjs"] })),
		/gates must be relative/,
	);
	assert.throws(
		() =>
			readRepositoryHandoffConfig(
				checkout({ version: 1, gates: ["../x.mjs"] }),
			),
		/gates must be relative/,
	);
});

test("rejects an invalid allowedHours window", () => {
	assert.throws(
		() =>
			readRepositoryHandoffConfig(
				checkout({
					version: 1,
					allowedHours: { days: ["mon"], start: "18:00", end: "08:00" },
				}),
			),
		/start before end/,
	);
	assert.throws(
		() =>
			readRepositoryHandoffConfig(
				checkout({
					version: 1,
					allowedHours: { days: ["someday"], start: "08:00", end: "18:00" },
				}),
			),
		/allowedHours\.days/,
	);
});

test("rejects an unknown field", () =>
	assert.throws(
		() => readRepositoryHandoffConfig(checkout({ version: 1, nope: true })),
		/unknown field/,
	));

test("withinAllowedHours checks UTC weekday and minute window", () => {
	const hours = { days: ["wed"], start: "08:00", end: "18:00" };
	assert.equal(
		withinAllowedHours(hours, new Date("2026-09-30T09:00:00Z")),
		true,
	);
	assert.equal(
		withinAllowedHours(hours, new Date("2026-09-30T19:00:00Z")),
		false,
	);
	assert.equal(
		withinAllowedHours(hours, new Date("2026-10-01T09:00:00Z")),
		false,
	);
	assert.equal(withinAllowedHours(undefined), true);
});
