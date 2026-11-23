import { jsonPost } from "@/server/apiGuard";
import { issueLease } from "@/server/offline";

/** Issues an offline lease (key + minimal worklist snapshot) to an RT on an approved device. */
export async function POST(req: Request) {
  return jsonPost(req, "offline-lease", 10, (s) => issueLease(s));
}
