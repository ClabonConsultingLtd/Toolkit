import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	describeAllowedHours,
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
		() =>
			readRepositoryHandoffConfig(checkout({ version: 1, gates: ["/x.mjs"] })),
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

test("accepts an array of allowedHours windows", () => {
	const config = readRepositoryHandoffConfig(
		checkout({
			version: 1,
			allowedHours: [
				{ days: ["mon"], start: "08:00", end: "12:00" },
				{ days: ["mon"], start: "13:00", end: "18:00" },
			],
		}),
	);
	assert.equal(config.allowedHours.length, 2);
});

test("rejects an empty allowedHours array", () => {
	assert.throws(
		() =>
			readRepositoryHandoffConfig(checkout({ version: 1, allowedHours: [] })),
		/non-empty array/,
	);
});

test("names the offending window's index in an array", () => {
	assert.throws(
		() =>
			readRepositoryHandoffConfig(
				checkout({
					version: 1,
					allowedHours: [
						{ days: ["mon"], start: "08:00", end: "12:00" },
						{ days: ["mon"], start: "18:00", end: "08:00" },
					],
				}),
			),
		/allowedHours\[1\]\.start\/end.*start before end/,
	);
	assert.throws(
		() =>
			readRepositoryHandoffConfig(
				checkout({
					version: 1,
					allowedHours: [{ days: ["someday"], start: "08:00", end: "12:00" }],
				}),
			),
		/allowedHours\[0\]\.days/,
	);
});

test("accepts end: 24:00 as the end of the day", () => {
	const config = readRepositoryHandoffConfig(
		checkout({
			version: 1,
			allowedHours: { days: ["mon"], start: "00:00", end: "24:00" },
		}),
	);
	assert.equal(config.allowedHours.end, "24:00");
});

test("rejects 24:00 as a start time", () => {
	assert.throws(
		() =>
			readRepositoryHandoffConfig(
				checkout({
					version: 1,
					allowedHours: { days: ["mon"], start: "24:00", end: "24:00" },
				}),
			),
		/start before end/,
	);
});

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

test("withinAllowedHours allows a time inside any window in an array", () => {
	const windows = [
		{ days: ["wed"], start: "08:00", end: "12:00" },
		{ days: ["wed"], start: "13:00", end: "18:00" },
	];
	assert.equal(
		withinAllowedHours(windows, new Date("2026-09-30T14:00:00Z")),
		true,
	);
	assert.equal(
		withinAllowedHours(windows, new Date("2026-09-30T12:30:00Z")),
		false,
	);
});

test("withinAllowedHours treats end: 24:00 as the end of the day", () => {
	const hours = { days: ["wed"], start: "00:00", end: "24:00" };
	assert.equal(
		withinAllowedHours(hours, new Date("2026-09-30T23:59:00Z")),
		true,
	);
});

test("describeAllowedHours lists every configured window", () => {
	assert.equal(
		describeAllowedHours([
			{ days: ["mon"], start: "08:00", end: "12:00" },
			{ days: ["fri"], start: "13:00", end: "24:00" },
		]),
		"UTC 08:00-12:00 on mon; UTC 13:00-24:00 on fri",
	);
});
