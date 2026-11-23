/**
 * Offline capture queue. Storage-agnostic (IndexedDB in the browser, a Map in unit tests).
 * Rules: an entry is removed from the device ONLY after the server confirms it has recorded it
 * (any outcome — accepted, duplicate, conflict or rejected are all kept server-side for review).
 * A failed write (e.g. storage quota) is reported to the user; it never pretends to have saved.
 */
import { open, seal, type Sealed } from "./crypto";

export type EntryKind = "NEB_DOSE" | "TUBING_REPLACEMENT";
export interface EntryInput {
  kind: EntryKind;
  payload: Record<string, unknown>;
}
export interface StoredEntry {
  id: string;
  leaseId: string;
  kind: EntryKind;
  createdAt: string; // device time of capture (not clinical time)
  sealed: Sealed;
}
export interface Meta {
  leaseId: string;
  expiresIso: string;
  issuedIso: string;
  staff: string;
  snapshotTakenIso: string;
  snapshot: Sealed;
  lastSyncIso: string | null;
}
export interface Store {
  getMeta(): Promise<Meta | null>;
  putMeta(m: Meta): Promise<void>;
  clearMeta(): Promise<void>;
  putEntry(e: StoredEntry): Promise<void>;
  entries(): Promise<StoredEntry[]>;
  deleteEntry(id: string): Promise<void>;
}

export class StorageFullError extends Error {
  constructor() {
    super("This device's storage is full. The entry was NOT saved — document it on paper and tell the Chief RT.");
  }
}

export const aadFor = (leaseId: string, id: string) => `puims-offline:v1:${leaseId}:${id}`;

export async function capture(store: Store, key: CryptoKey, meta: Meta, input: EntryInput, now = new Date()): Promise<StoredEntry> {
  if (now.getTime() > Date.parse(meta.expiresIso)) throw new Error("The offline lease has expired. Reconnect and sign in to continue documenting.");
  const id = crypto.randomUUID();
  const entry: StoredEntry = {
    id,
    leaseId: meta.leaseId,
    kind: input.kind,
    createdAt: now.toISOString(),
    sealed: await seal(key, input.payload, aadFor(meta.leaseId, id)),
  };
  try {
    await store.putEntry(entry);
  } catch (e) {
    if ((e as { name?: string }).name === "QuotaExceededError") throw new StorageFullError();
    throw e;
  }
  // Read back: never report "saved" unless it really is.
  const saved = (await store.entries()).some((x) => x.id === id);
  if (!saved) throw new Error("The entry could not be confirmed as saved on this device. Document it on paper.");
  return entry;
}

export interface OutgoingEntry {
  id: string;
  kind: EntryKind;
  recordedAtDevice: string;
  payload: Record<string, unknown>;
}

/** Decrypts entries for sending. Entries of another lease use that lease's key (passed in `keys`). */
export async function outgoing(store: Store, keys: Map<string, CryptoKey>): Promise<{ ready: OutgoingEntry[]; lockedLeases: string[] }> {
  const ready: OutgoingEntry[] = [];
  const locked = new Set<string>();
  for (const e of await store.entries()) {
    const key = keys.get(e.leaseId);
    if (!key) {
      locked.add(e.leaseId);
      continue;
    }
    ready.push({ id: e.id, kind: e.kind, recordedAtDevice: e.createdAt, payload: await open<Record<string, unknown>>(key, e.sealed, aadFor(e.leaseId, e.id)) });
  }
  return { ready, lockedLeases: [...locked] };
}

export interface ServerResult {
  id: string;
  outcome: "ACCEPTED" | "DUPLICATE" | "CONFLICT" | "REJECTED";
  message: string | null;
}

/** Removes only entries the server explicitly acknowledged. Anything not in the response stays queued. */
export async function acknowledge(
  store: Store,
  sent: OutgoingEntry[],
  results: ServerResult[],
): Promise<{ removed: number; kept: number; needsReview: ServerResult[] }> {
  const sentIds = new Set(sent.map((s) => s.id));
  let removed = 0;
  for (const r of results) {
    if (!sentIds.has(r.id)) continue;
    await store.deleteEntry(r.id);
    removed++;
  }
  return { removed, kept: sent.length - removed, needsReview: results.filter((r) => r.outcome === "CONFLICT" || r.outcome === "REJECTED") };
}

export class MemoryStore implements Store {
  meta: Meta | null = null;
  map = new Map<string, StoredEntry>();
  failNextPut: Error | null = null;
  async getMeta() {
    return this.meta;
  }
  async putMeta(m: Meta) {
    this.meta = m;
  }
  async clearMeta() {
    this.meta = null;
  }
  async putEntry(e: StoredEntry) {
    if (this.failNextPut) {
      const err = this.failNextPut;
      this.failNextPut = null;
      throw err;
    }
    this.map.set(e.id, structuredClone(e));
  }
  async entries() {
    return [...this.map.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async deleteEntry(id: string) {
    this.map.delete(id);
  }
}
