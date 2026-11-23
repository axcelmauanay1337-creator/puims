/**
 * On-device sealing for the offline queue and worklist snapshot (Milestone 7).
 *
 * AES-256-GCM via WebCrypto. The key comes from the server's offline lease and is imported as a
 * NON-EXTRACTABLE CryptoKey held in memory only — it is never written to IndexedDB, localStorage or
 * the service-worker cache. Each record is bound to its lease and id through additional authenticated
 * data, so records cannot be swapped between leases or entries without detection.
 *
 * Honest limits (see docs/OFFLINE_BEHAVIOR_MATRIX.md): this protects data at rest in the browser
 * profile against someone who copies the storage without the key; it does not protect against
 * malware or a person using the unlocked browser session while the key is in memory.
 */
export interface Sealed {
  iv: string;
  ct: string;
}

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function importLeaseKey(rawBase64: string): Promise<CryptoKey> {
  const raw = unb64(rawBase64);
  if (raw.length !== 32) throw new Error("Invalid lease key.");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function seal(key: CryptoKey, value: unknown, aad: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
    key,
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return { iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

export async function open<T>(key: CryptoKey, sealed: Sealed, aad: string): Promise<T> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(sealed.iv), additionalData: new TextEncoder().encode(aad) }, key, unb64(sealed.ct));
  return JSON.parse(new TextDecoder().decode(pt)) as T;
}
