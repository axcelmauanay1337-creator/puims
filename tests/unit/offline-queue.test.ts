import { describe, expect, it } from "vitest";
import { importLeaseKey, open, seal } from "@/offline/crypto";
import { aadFor, acknowledge, capture, MemoryStore, outgoing, StorageFullError, type Meta } from "@/offline/queue";

const rawKey = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const meta = (over: Partial<Meta> = {}): Meta => ({
  leaseId: "11111111-1111-4111-8111-111111111111",
  expiresIso: new Date(Date.now() + 3_600_000).toISOString(),
  issuedIso: new Date().toISOString(),
  staff: "RT Demo",
  snapshotTakenIso: new Date().toISOString(),
  snapshot: { iv: "", ct: "" },
  lastSyncIso: null,
  ...over,
});

describe("offline sealing", () => {
  it("round-trips and binds records to lease + id", async () => {
    const k = await importLeaseKey(rawKey());
    const s = await seal(k, { a: 1 }, "x");
    expect(Buffer.from(s.ct, "base64").toString("latin1")).not.toContain(`"a":1`);
    expect(await open(k, s, "x")).toEqual({ a: 1 });
    await expect(open(k, s, "y")).rejects.toThrow();
    await expect(open(await importLeaseKey(rawKey()), s, "x")).rejects.toThrow();
  });
  it("keys are not extractable", async () => {
    const k = await importLeaseKey(rawKey());
    expect(k.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", k)).rejects.toThrow();
    await expect(importLeaseKey("c2hvcnQ=")).rejects.toThrow(/Invalid/);
  });
});

describe("offline queue", () => {
  it("stores only ciphertext and refuses capture after lease expiry", async () => {
    const store = new MemoryStore();
    const key = await importLeaseKey(rawKey());
    await capture(store, key, meta(), { kind: "NEB_DOSE", payload: { patientNote: "Synthetic Name" } });
    expect(JSON.stringify([...store.map.values()])).not.toContain("Synthetic Name");
    await expect(capture(store, key, meta({ expiresIso: new Date(Date.now() - 1000).toISOString() }), { kind: "NEB_DOSE", payload: {} })).rejects.toThrow(
      /expired/,
    );
  });
  it("reports storage-full instead of pretending to save", async () => {
    const store = new MemoryStore();
    const key = await importLeaseKey(rawKey());
    store.failNextPut = Object.assign(new Error("quota"), { name: "QuotaExceededError" });
    await expect(capture(store, key, meta(), { kind: "NEB_DOSE", payload: {} })).rejects.toBeInstanceOf(StorageFullError);
    expect(await store.entries()).toHaveLength(0);
  });
  it("keeps entries whose lease key is unavailable, and removes only acknowledged ones", async () => {
    const store = new MemoryStore();
    const k1 = await importLeaseKey(rawKey());
    const m1 = meta();
    const m2 = meta({ leaseId: "22222222-2222-4222-8222-222222222222" });
    const a = await capture(store, k1, m1, { kind: "NEB_DOSE", payload: { n: 1 } });
    const b = await capture(store, k1, m1, { kind: "TUBING_REPLACEMENT", payload: { n: 2 } });
    await capture(store, await importLeaseKey(rawKey()), m2, { kind: "NEB_DOSE", payload: { n: 3 } });
    const { ready, lockedLeases } = await outgoing(store, new Map([[m1.leaseId, k1]]));
    expect(ready.map((r) => r.payload.n)).toEqual([1, 2]);
    expect(lockedLeases).toEqual([m2.leaseId]);
    // Server answered for `a` only (e.g. the response was cut short): `b` must stay queued.
    const ack = await acknowledge(store, ready, [
      { id: a.id, outcome: "CONFLICT", message: "x" },
      { id: "not-sent", outcome: "ACCEPTED", message: null },
    ]);
    expect(ack).toMatchObject({ removed: 1, kept: 1 });
    expect(ack.needsReview).toHaveLength(1);
    expect((await store.entries()).map((e) => e.id)).toContain(b.id);
    expect(aadFor("l", "i")).toBe("puims-offline:v1:l:i");
  });
});
