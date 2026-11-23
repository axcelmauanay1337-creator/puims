import { searchPatients } from "@/server/data";
import { rateLimit } from "@/server/rateLimit";
import { AuthenticationError, AuthorizationError, getSession } from "@/server/session";

/**
 * Patient search. POST-only so search terms (names, hospital numbers) never
 * appear in URLs, proxy/access logs or browser history. Responses are
 * no-store. Errors are generic and never echo the query.
 */
const NO_STORE = { "cache-control": "no-store" };

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthenticated" }, { status: 401, headers: NO_STORE });

  const rl = rateLimit(`search:${session.userId}`, 60, 60_000);
  if (!rl.ok) return Response.json({ error: "rate_limited" }, { status: 429, headers: { ...NO_STORE, "retry-after": String(rl.retryAfterSec) } });

  let q: unknown;
  try {
    const body = (await req.json()) as { q?: unknown };
    q = body?.q;
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }
  if (typeof q !== "string" || q.length > 64) return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });

  try {
    const hits = await searchPatients(q);
    return Response.json({ hits }, { headers: NO_STORE });
  } catch (e) {
    if (e instanceof AuthenticationError) return Response.json({ error: "unauthenticated" }, { status: 401, headers: NO_STORE });
    if (e instanceof AuthorizationError) return Response.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
    return Response.json({ error: "server_error" }, { status: 500, headers: NO_STORE });
  }
}
