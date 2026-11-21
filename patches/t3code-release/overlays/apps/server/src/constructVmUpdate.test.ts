import { assert, describe, it } from "@effect/vitest";

import {
  makeConstructVmUpdate,
  parseConstructVmUpdateRun,
  parseConstructVmUpdateStatus,
  type ConstructCliRunner,
} from "./constructVmUpdate.ts";

const status = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ newerPayload: true, availableCommit: "abcdef1234567", appliedCommit: "0123456789abc", hostUpdate: null, ...over });

/** A fake guest CLI: answers per subcommand, records every argument list. */
function fakeCli(answers: { status?: string | null; run?: string | null }) {
  const calls: Array<ReadonlyArray<string>> = [];
  const runner: ConstructCliRunner = async (args) => {
    calls.push(args);
    return args[1] === "status" ? (answers.status ?? null) : (answers.run ?? null);
  };
  return { runner, calls, answers };
}

describe("the VM's Construct update (web UI without Desktop)", () => {
  it("reads the engine's answer and nothing else", () => {
    assert.deepEqual(parseConstructVmUpdateStatus(status()), {
      available: true,
      version: "abcdef1",
      host: false,
      appliedCommit: "0123456",
    });
    assert.deepEqual(parseConstructVmUpdateStatus(status({ newerPayload: false, hostUpdate: { version: "2.1.0", commit: "ff" } })), {
      available: true,
      version: "2.1.0",
      host: true,
      appliedCommit: "0123456",
    });
    assert.equal(parseConstructVmUpdateStatus(status({ newerPayload: false }))?.available, false);
    assert.isNull(parseConstructVmUpdateStatus("construct: unknown command 'update'"));
    assert.isNull(parseConstructVmUpdateStatus(JSON.stringify({ newerPayload: "yes" })));
    assert.isTrue(parseConstructVmUpdateRun(JSON.stringify({ jobId: "j1", hostUpdateId: null, hostJobId: null })));
    assert.isFalse(parseConstructVmUpdateRun(JSON.stringify({ jobId: null, hostUpdateId: null, hostJobId: null })));
  });

  it("shows nothing for a missing command or a failure", async () => {
    const cli = fakeCli({ status: null });
    const update = makeConstructVmUpdate(cli.runner);
    assert.deepEqual(await update.status(), { available: false, running: false, version: null, host: false, appliedCommit: null });
    const run = await update.run();
    assert.isFalse(run.started);
    assert.isFalse(cli.calls.some((args) => args[1] === "run"));
  });

  it("runs fixed commands, once, and reports running until the VM moved", async () => {
    let now = 1_000_000;
    const cli = fakeCli({ status: status(), run: JSON.stringify({ jobId: "job-1", hostUpdateId: null, hostJobId: null }) });
    const update = makeConstructVmUpdate(cli.runner, () => now);
    assert.deepEqual(await update.status(), { available: true, running: false, version: "abcdef1", host: false, appliedCommit: "0123456" });
    const [first, second] = await Promise.all([update.run(), update.run()]);
    assert.deepEqual(first, { started: true, message: null });
    assert.deepEqual(second, { started: true, message: null });
    assert.isTrue((await update.run()).started);
    assert.deepEqual(
      cli.calls.filter((args) => args[1] === "run"),
      [["update", "run", "--json"]],
      "one run for any number of clicks",
    );
    assert.isTrue(cli.calls.every((args) => args.length === 3 && args[2] === "--json"));
    assert.isTrue((await update.status()).running);
    // The reprovision applied the payload: nothing on offer, nothing running.
    cli.answers.status = status({ newerPayload: false, appliedCommit: "abcdef1234567" });
    now += 61_000;
    assert.deepEqual(await update.status(), { available: false, running: false, version: null, host: false, appliedCommit: "abcdef1" });
  });

  it("reports a refused start and starts nothing without an offer", async () => {
    const refused = fakeCli({ status: status(), run: null });
    assert.deepEqual(await makeConstructVmUpdate(refused.runner).run(), {
      started: false,
      message: "The VM could not start its update. Try again later.",
    });
    const current = fakeCli({ status: status({ newerPayload: false }), run: JSON.stringify({ jobId: "x" }) });
    assert.isFalse((await makeConstructVmUpdate(current.runner).run()).started);
    assert.isFalse(current.calls.some((args) => args[1] === "run"));
  });
});
