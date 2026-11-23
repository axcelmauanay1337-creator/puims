import { ClinicalError } from "@/server/clinical";
import { importPftGuide } from "@/server/pftGuide";
import { rateLimit } from "@/server/rateLimit";
import { getSession } from "@/server/session";

/** Loads the hospital PFT guide workbook as-is (Chief RT, recent step-up). The file is read in memory and not stored. */
const NO_STORE = { "cache-control": "no-store" };
export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (!origin || !host || new URL(origin).host !== host) return Response.json({ error: "Cross-site request refused." }, { status: 403, headers: NO_STORE });
  const s = await getSession();
  if (!s) return Response.json({ error: "Your session has ended. Sign in again." }, { status: 401, headers: NO_STORE });
  if (!rateLimit(`guide:${s.userId}`, 5, 60_000).ok) return Response.json({ error: "Too many uploads. Wait a minute." }, { status: 429, headers: NO_STORE });
  let f: FormDataEntryValue | null;
  try {
    f = (await req.formData()).get("file");
  } catch {
    return Response.json({ error: "Upload could not be read." }, { status: 400, headers: NO_STORE });
  }
  if (!(f instanceof File)) return Response.json({ error: "Choose the PFT guide workbook." }, { status: 400, headers: NO_STORE });
  try {
    return Response.json(await importPftGuide(s, Buffer.from(await f.arrayBuffer())), { headers: NO_STORE });
  } catch (e) {
    if (e instanceof ClinicalError)
      return Response.json({ error: e.message, reauth: e.kind === "REAUTH_REQUIRED" }, { status: e.kind === "FORBIDDEN" ? 403 : 400, headers: NO_STORE });
    return Response.json({ error: "The workbook could not be loaded. Nothing was changed." }, { status: 500, headers: NO_STORE });
  }
}
