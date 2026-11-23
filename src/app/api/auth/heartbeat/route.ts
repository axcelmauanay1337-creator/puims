import { getSession } from "@/server/session";

/** Called by IdleWatcher only on real user activity. Validating the session slides its idle expiry. */
export async function POST() {
  const s = await getSession();
  return new Response(null, { status: s ? 204 : 401, headers: { "cache-control": "no-store" } });
}
