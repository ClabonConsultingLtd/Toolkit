import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { atomicWrite, newBatch } from "../src/orchestration.mjs";
import {
	capacity,
	enforceCapacity,
	intakeCommand,
} from "../src/ticket-intake.mjs";

for (const remote of [false, true]) {
	test(`unchanged ${remote ? "worker host" : "local"} cap permits reconciliation above capacity`, () => {
		const cwd = mkdtempSync(join(tmpdir(), "intake-capacity-"));
		try {
			const config = {
				version: 1,
				repository: "example/consumer",
				baseBranch: "main",
				codexModel: "gpt-6.1-sol",
				count: 3,
				requiredChecks: [],
				workerHosts: remote
					? [{ id: "worker", paseoHost: "worker:6767", cwd, count: 3 }]
					: [],
			};
			const configPath = join(cwd, "toolkit-intake.json");
			atomicWrite(configPath, config);
			intakeCommand("configure", cwd);
			const batch = newBatch({
				...config,
				cwd,
				batchId: "over-capacity",
				tickets: [1, 2, 3, 4],
			});
			for (const ticket of Object.values(batch.tickets)) {
				ticket.status = "implementing";
				if (remote) ticket.host = "worker";
			}
			const batchPath = join(cwd, ".toolkit/orchestration/over-capacity.json");
			atomicWrite(batchPath, batch);
			assert.equal(intakeCommand("sync-config", cwd).count, 3);
			const slots = capacity(batchPath, config.repository);
			assert.equal((remote ? slots.hosts.worker : slots).executionSlots, 0);
			assert.throws(
				() => enforceCapacity(batchPath, batch, 3),
				/execution limit reached/,
			);
			if (remote) config.workerHosts[0].count = 2;
			else config.count = 2;
			atomicWrite(configPath, config);
			assert.throws(
				() => intakeCommand("sync-config", cwd),
				/below.*current active work/,
			);
			if (remote) config.workerHosts[0].count = 4;
			else config.count = 4;
			atomicWrite(configPath, config);
			assert.doesNotThrow(() => intakeCommand("sync-config", cwd));
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
}
