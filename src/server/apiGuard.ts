import "server-only";
import { ClinicalError } from "./clinical";
import { rateLimit } from "./rateLimit";
import { getSession, type Session } from "./session";

const NO_STORE = { "cache-control": "no-store" };

/** JSON POST endpoint guard: same-origin only, signed-in session, rate-limited, sanitized errors. */
export async function jsonPost<T>(
  req: Request,
  bucket: string,
  limit: number,
  fn: (s: Session, body: Record<string, unknown>) => Promise<T>,
): Promise<Response> {
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (!origin || !host || new URL(origin).host !== host) return Response.json({ error: "Cross-site request refused." }, { status: 403, headers: NO_STORE });
  const s = await getSession();
  if (!s) return Response.json({ error: "Not signed in." }, { status: 401, headers: NO_STORE });
  const rl = rateLimit(`${bucket}:${s.userId}`, limit, 60_000);
  if (!rl.ok) return Response.json({ error: "Too many requests. Wait a minute." }, { status: 429, headers: NO_STORE });
  let body: Record<string, unknown>;
  try {
    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > 2 * 1024 * 1024) return Response.json({ error: "Request too large." }, { status: 413, headers: NO_STORE });
    body = (await req.json()) as Record<string, unknown>;
    if (!body || typeof body !== "object") throw new Error();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400, headers: NO_STORE });
  }
  try {
    return Response.json(await fn(s, body), { headers: NO_STORE });
  } catch (e) {
    if (e instanceof ClinicalError) {
      const status = e.kind === "FORBIDDEN" ? 403 : e.kind === "NOT_FOUND" ? 404 : e.kind === "CONFLICT" ? 409 : 400;
      return Response.json({ error: e.message }, { status, headers: NO_STORE });
    }
    return Response.json({ error: "Server error. Nothing was changed." }, { status: 500, headers: NO_STORE });
  }
}
