import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, type ConstructT3LinkInfo } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import {
  type ConstructConnectPairing,
  type ConstructLinkBridge,
  constructPairedRouteUrl,
  constructPairingLinkToken,
  relinkConstructInstance,
} from "./constructInstances.link.ts";
import { pairedEntry, withLearnedLanRoute } from "./constructInstances.test-fixtures.ts";

const ENV = EnvironmentId.make("env-haus");
const BASE = "https://standpc.example.net:2301";
const NOW = () => "2026-10-16T15:00:00.000Z";

function harness(minted: Awaited<ReturnType<ConstructLinkBridge["linkConstructInstance"]>>, result: Awaited<ReturnType<ConstructConnectPairing>>) {
  const calls: { pairing: Array<Parameters<ConstructConnectPairing>[0]>; markers: Array<[string, ConstructT3LinkInfo]>; minted: string[] } = {
    pairing: [],
    markers: [],
    minted: [],
  };
  const bridge: ConstructLinkBridge = {
    linkConstructInstance: async (name) => {
      calls.minted.push(name);
      return minted;
    },
    recordConstructInstanceT3Link: async (name, link) => {
      calls.markers.push([name, link]);
      return true;
    },
  };
  const connectPairing: ConstructConnectPairing = async (input) => {
    calls.pairing.push(input);
    return result;
  };
  return { bridge, connectPairing, calls };
}

describe("constructPairingLinkToken", () => {
  it("reads the one-time token from the link's fragment", () => {
    assert.equal(constructPairingLinkToken("https://host.example:2301/pair#token=S5JA6Q4CTSG2"), "S5JA6Q4CTSG2");
    assert.equal(constructPairingLinkToken("https://host.example:2301/pair?token=QUERY"), "QUERY");
    assert.isNull(constructPairingLinkToken("https://host.example:2301/pair"));
    assert.isNull(constructPairingLinkToken("not a url"));
  });
});

describe("constructPairedRouteUrl", () => {
  it("is the paired route's address, also behind a learned LAN route that borrows its credential", () => {
    const paired = pairedEntry(ENV, "https://t3haus.example.net:8443/");
    assert.equal(constructPairedRouteUrl(paired), "https://t3haus.example.net:8443/");
    const learned = withLearnedLanRoute(paired, "http://172.30.1.5:5177/");
    assert.isTrue(String(learned.target._tag === "BearerConnectionTarget" && learned.target.connectionId).startsWith("learned:"));
    assert.equal(constructPairedRouteUrl(learned), "https://t3haus.example.net:8443/");
  });
});

describe("relinkConstructInstance", () => {
  it("redeems the new token at the remote's own address, for the same environment, and records the link", async () => {
    // The script's link names another origin; the saved connection's address wins.
    const { bridge, connectPairing, calls } = harness(
      { ok: true, pairUrl: "https://t3haus.example.net:8443/pair#token=NEWTOKEN", scopes: "administrative" },
      AsyncResult.success(ENV),
    );
    const outcome = await relinkConstructInstance({ bridge, name: "haus-vm", environmentId: ENV, baseUrl: BASE, connectPairing, now: NOW });
    assert.deepEqual(outcome, { ok: true, environmentId: "env-haus", baseUrl: BASE });
    assert.deepEqual(calls.minted, ["haus-vm"]);
    assert.deepEqual(calls.pairing, [{ host: BASE, pairingCode: "NEWTOKEN", expectedEnvironmentId: ENV }]);
    assert.deepEqual(calls.markers, [
      ["haus-vm", { status: "linked", at: NOW(), environmentId: "env-haus", baseUrl: BASE, error: null }],
    ]);
  });

  it("reports a failed mint without pairing or touching the marker", async () => {
    const { bridge, connectPairing, calls } = harness({ ok: false, error: "ssh: connection refused" }, AsyncResult.success(ENV));
    const outcome = await relinkConstructInstance({ bridge, name: "haus-vm", environmentId: ENV, baseUrl: BASE, connectPairing, now: NOW });
    assert.deepEqual(outcome, { ok: false, error: "ssh: connection refused", interrupted: false });
    assert.deepEqual(calls.pairing, []);
    assert.deepEqual(calls.markers, []);
  });

  it("reports a link without a token", async () => {
    const { bridge, connectPairing, calls } = harness({ ok: true, pairUrl: "https://t3haus.example.net:8443/pair", scopes: "standard" }, AsyncResult.success(ENV));
    const outcome = await relinkConstructInstance({ bridge, name: "haus-vm", environmentId: ENV, baseUrl: BASE, connectPairing, now: NOW });
    assert.deepEqual(outcome, { ok: false, error: "The pairing link carried no token.", interrupted: false });
    assert.deepEqual(calls.pairing, []);
  });

  it("reports a failed pairing without touching the marker, and an interruption as such", async () => {
    const failed = harness(
      { ok: true, pairUrl: `${BASE}/pair#token=NEWTOKEN`, scopes: "administrative" },
      AsyncResult.failure(Cause.fail(new Error("That address reaches other-vm, a different machine."))),
    );
    assert.deepEqual(
      await relinkConstructInstance({ ...failed, name: "haus-vm", environmentId: ENV, baseUrl: BASE, now: NOW }),
      { ok: false, error: "That address reaches other-vm, a different machine.", interrupted: false },
    );
    assert.deepEqual(failed.calls.markers, []);

    const interrupted = harness(
      { ok: true, pairUrl: `${BASE}/pair#token=NEWTOKEN`, scopes: "administrative" },
      AsyncResult.failure(Cause.interrupt()),
    );
    const outcome = await relinkConstructInstance({ ...interrupted, name: "haus-vm", environmentId: ENV, baseUrl: BASE, now: NOW });
    assert.isTrue(!outcome.ok && outcome.interrupted);
    assert.deepEqual(interrupted.calls.markers, []);
  });
});
