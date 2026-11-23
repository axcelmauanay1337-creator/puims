import { jsonPost } from "@/server/apiGuard";
import { syncEntries, type SyncEntry } from "@/server/offline";

/** Idempotent sync of offline-captured entries; returns one result per entry. */
export async function POST(req: Request) {
  return jsonPost(req, "sync", 30, (s, b) =>
    syncEntries(s, String(b.leaseId ?? ""), String(b.deviceNow ?? ""), (Array.isArray(b.entries) ? b.entries : []) as SyncEntry[]),
  );
}
