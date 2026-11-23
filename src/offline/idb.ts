/** IndexedDB implementation of the offline Store (browser only). Holds ciphertext + non-PHI metadata. */
import type { Meta, Store, StoredEntry } from "./queue";

const DB = "puims-offline";
const VERSION = 1;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function done(t: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new DOMException("aborted", "AbortError"));
  });
}

export async function openStore(): Promise<Store> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => {
      r.result.createObjectStore("meta");
      r.result.createObjectStore("queue", { keyPath: "id" });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const tx = (name: "meta" | "queue", mode: IDBTransactionMode) => db.transaction(name, mode);
  return {
    async getMeta() {
      return ((await req(tx("meta", "readonly").objectStore("meta").get("current"))) as Meta | undefined) ?? null;
    },
    async putMeta(m) {
      const t = tx("meta", "readwrite");
      t.objectStore("meta").put(m, "current");
      await done(t);
    },
    async clearMeta() {
      const t = tx("meta", "readwrite");
      t.objectStore("meta").delete("current");
      await done(t);
    },
    async putEntry(e: StoredEntry) {
      const t = tx("queue", "readwrite");
      t.objectStore("queue").put(e);
      await done(t);
    },
    async entries() {
      const all = (await req(tx("queue", "readonly").objectStore("queue").getAll())) as StoredEntry[];
      return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async deleteEntry(id) {
      const t = tx("queue", "readwrite");
      t.objectStore("queue").delete(id);
      await done(t);
    },
  };
}
