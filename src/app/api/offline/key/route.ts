import { jsonPost } from "@/server/apiGuard";
import { leaseKey } from "@/server/offline";

/** Re-releases a lease key to its own holder (same staff + device, valid session). */
export async function POST(req: Request) {
  return jsonPost(req, "offline-key", 20, (s, b) => leaseKey(s, String(b.leaseId ?? "")));
}
