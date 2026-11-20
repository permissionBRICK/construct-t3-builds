import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, type ConstructT3LinkInfo } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import {
  type ConstructConnectPairing,
  type ConstructLinkBridge,
  type ConstructSavedRoute,
  constructPairedRouteUrl,
  constructPairingLinkToken,
  constructServerEnvironmentId,
  linkConstructInstance,
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
    const learned = withLearnedLanRoute(paired, "https://172.30.1.5:5177/");
    assert.isTrue(String(learned.target._tag === "BearerConnectionTarget" && learned.target.connectionId).startsWith("learned:"));
    assert.equal(constructPairedRouteUrl(learned), "https://t3haus.example.net:8443/");
  });
});

/** A fetch that answers T3's descriptor request with this environment id (null: no server). */
function descriptorFetch(environmentId: string | null) {
  const urls: string[] = [];
  const fetchImpl = (async (url: URL | RequestInfo) => {
    urls.push(String(url));
    if (environmentId === null) throw new TypeError("fetch failed");
    return new Response(JSON.stringify({ environmentId, label: "vm-1" }), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, urls };
}

describe("constructServerEnvironmentId", () => {
  it("reads the environment id from the server's descriptor", async () => {
    const { fetchImpl, urls } = descriptorFetch(String(ENV));
    assert.equal(await constructServerEnvironmentId(BASE, fetchImpl), String(ENV));
    assert.deepEqual(urls, [`${BASE}/.well-known/t3/environment`]);
  });

  it("is null when the server does not answer with one", async () => {
    assert.isNull(await constructServerEnvironmentId(BASE, descriptorFetch(null).fetchImpl));
    const notFound = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
    assert.isNull(await constructServerEnvironmentId(BASE, notFound));
    const noId = (async () => new Response(JSON.stringify({ label: "x" }), { status: 200 })) as unknown as typeof fetch;
    assert.isNull(await constructServerEnvironmentId(BASE, noId));
  });
});

describe("linkConstructInstance", () => {
  const NEW = "https://vm-new.example.net";
  const OLD = "https://old.example.net:8443/";
  const minted = { ok: true as const, pairUrl: `${NEW}/pair#token=NEWTOKEN`, scopes: "administrative" as const };

  /** The user's answers to the route question, and the questions asked. */
  function answering(answer: boolean) {
    const asked: Array<ConstructSavedRoute> = [];
    const confirmRoute = async (route: ConstructSavedRoute) => {
      asked.push(route);
      return answer;
    };
    return { asked, confirmRoute };
  }

  it("pairs the link as a route of the environment the app saved under the VM's old address, once the user confirms", async () => {
    const saved = pairedEntry(ENV, OLD);
    const { bridge, connectPairing, calls } = harness(minted, AsyncResult.success(ENV));
    const { fetchImpl, urls } = descriptorFetch(String(ENV));
    const { asked, confirmRoute } = answering(true);
    const outcome = await linkConstructInstance({
      bridge,
      name: "vm-1",
      connectPairing,
      savedEnvironments: [saved],
      confirmRoute,
      fetch: fetchImpl,
      now: NOW,
    });
    assert.deepEqual(urls, [`${NEW}/.well-known/t3/environment`]);
    const route = { address: NEW, label: saved.target.label, previousAddress: OLD };
    assert.deepEqual(asked, [route]);
    // Upstream's "Add route": the pairing names the saved environment.
    assert.deepEqual(calls.pairing, [{ pairingUrl: minted.pairUrl, expectedEnvironmentId: ENV }]);
    assert.deepEqual(outcome, { ok: true, environmentId: String(ENV), baseUrl: NEW, savedRoute: route });
    assert.deepEqual(calls.markers, [
      ["vm-1", { status: "linked", at: NOW(), environmentId: String(ENV), baseUrl: NEW, error: null }],
    ]);
  });

  it("does nothing when the user declines, and records nothing", async () => {
    const { bridge, connectPairing, calls } = harness(minted, AsyncResult.success(ENV));
    const outcome = await linkConstructInstance({
      bridge,
      name: "vm-1",
      connectPairing,
      savedEnvironments: [pairedEntry(ENV, OLD)],
      confirmRoute: answering(false).confirmRoute,
      fetch: descriptorFetch(String(ENV)).fetchImpl,
      now: NOW,
    });
    assert.isTrue(!outcome.ok && outcome.interrupted);
    assert.deepEqual(calls.pairing, []);
    assert.deepEqual(calls.markers, []);
  });

  it("names the paired route's address, not a learned LAN route saved ahead of it", async () => {
    const { bridge, connectPairing } = harness(minted, AsyncResult.success(ENV));
    const { asked, confirmRoute } = answering(true);
    await linkConstructInstance({
      bridge,
      name: "vm-1",
      connectPairing,
      savedEnvironments: [withLearnedLanRoute(pairedEntry(ENV, OLD), "https://172.30.1.5:5177/")],
      confirmRoute,
      fetch: descriptorFetch(String(ENV)).fetchImpl,
      now: NOW,
    });
    assert.deepEqual(asked.map((route) => route.previousAddress), [OLD]);
  });

  it("pairs plainly, without a question, when a saved route already reaches the link's address", async () => {
    // Paired there, or behind a learned LAN route that hides it from the Providers rows.
    for (const saved of [pairedEntry(ENV, `${NEW}/`), withLearnedLanRoute(pairedEntry(ENV, `${NEW}/`), "https://172.30.1.5:5177/")]) {
      const { bridge, connectPairing, calls } = harness(minted, AsyncResult.success(ENV));
      const { asked, confirmRoute } = answering(false);
      const outcome = await linkConstructInstance({
        bridge,
        name: "vm-1",
        connectPairing,
        savedEnvironments: [saved],
        confirmRoute,
        fetch: descriptorFetch(String(ENV)).fetchImpl,
        now: NOW,
      });
      assert.deepEqual(asked, []);
      assert.deepEqual(calls.pairing, [{ pairingUrl: minted.pairUrl }]);
      assert.deepEqual(outcome, { ok: true, environmentId: String(ENV), baseUrl: NEW });
    }
  });

  it("links a new environment as before when the server is none of the saved ones, or does not answer", async () => {
    for (const reported of ["env-other", null]) {
      const { bridge, connectPairing, calls } = harness(minted, AsyncResult.success(EnvironmentId.make("env-new")));
      const { asked, confirmRoute } = answering(true);
      const outcome = await linkConstructInstance({
        bridge,
        name: "vm-1",
        connectPairing,
        savedEnvironments: [pairedEntry(ENV, OLD)],
        confirmRoute,
        fetch: descriptorFetch(reported).fetchImpl,
        now: NOW,
      });
      assert.deepEqual(asked, []);
      assert.deepEqual(calls.pairing, [{ pairingUrl: minted.pairUrl }]);
      assert.deepEqual(outcome, { ok: true, environmentId: "env-new", baseUrl: NEW });
    }
  });

  it("asks no server and pairs no route without a question to ask (the automatic link) or saved environments", async () => {
    for (const input of [
      { savedEnvironments: [pairedEntry(ENV, OLD)] },
      { savedEnvironments: [], confirmRoute: answering(true).confirmRoute },
    ]) {
      const { bridge, connectPairing, calls } = harness(minted, AsyncResult.success(ENV));
      const { fetchImpl, urls } = descriptorFetch(String(ENV));
      await linkConstructInstance({ bridge, name: "vm-1", connectPairing, ...input, fetch: fetchImpl, now: NOW });
      assert.deepEqual(urls, []);
      assert.deepEqual(calls.pairing, [{ pairingUrl: minted.pairUrl }]);
    }
  });

  it("records a refused route as a failed link", async () => {
    const { bridge, connectPairing, calls } = harness(
      minted,
      AsyncResult.failure(Cause.fail(new Error("The pairing code was refused."))),
    );
    const outcome = await linkConstructInstance({
      bridge,
      name: "vm-1",
      connectPairing,
      savedEnvironments: [pairedEntry(ENV, OLD)],
      confirmRoute: answering(true).confirmRoute,
      fetch: descriptorFetch(String(ENV)).fetchImpl,
      now: NOW,
    });
    assert.deepEqual(outcome, { ok: false, error: "The pairing code was refused.", interrupted: false });
    assert.deepEqual(calls.markers, [
      ["vm-1", { status: "failed", at: NOW(), environmentId: null, baseUrl: NEW, error: "The pairing code was refused." }],
    ]);
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
