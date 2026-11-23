import { ClinicalError } from "@/server/clinical";
import { MAX_FILE_BYTES, MAX_UPLOAD_MB, stageWorkbook } from "@/server/importer";
import { rateLimit } from "@/server/rateLimit";
import { getSession } from "@/server/session";

/**
 * Workbook upload for the import wizard (Chief RT). A route handler rather than a server action so the
 * 10 MB limit applies here only. The file is parsed in memory and never written to disk.
 * Same-origin only (the session cookie is SameSite, and Origin is checked as defence in depth).
 */
const NO_STORE = { "cache-control": "no-store" };

export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (!origin || !host || new URL(origin).host !== host) return Response.json({ error: "Cross-site request refused." }, { status: 403, headers: NO_STORE });
  const session = await getSession();
  if (!session) return Response.json({ error: "Your session has ended. Sign in again." }, { status: 401, headers: NO_STORE });
  if (session.role !== "CHIEF_RT_ADMIN") return Response.json({ error: "Only the Chief RT can import records." }, { status: 403, headers: NO_STORE });
  const rl = rateLimit(`import:${session.userId}`, 10, 60_000);
  if (!rl.ok) return Response.json({ error: "Too many uploads. Wait a minute." }, { status: 429, headers: NO_STORE });
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_FILE_BYTES + 64 * 1024) return Response.json({ error: `The file is larger than ${MAX_UPLOAD_MB} MB.` }, { status: 413, headers: NO_STORE });
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "Upload could not be read." }, { status: 400, headers: NO_STORE });
  }
  const f = form.get("file");
  if (!(f instanceof File)) return Response.json({ error: "Choose a workbook file." }, { status: 400, headers: NO_STORE });
  const svc = String(form.get("service") ?? "PFT");
  try {
    const { batchId } = await stageWorkbook(session, {
      fileName: f.name,
      bytes: Buffer.from(await f.arrayBuffer()),
      service: svc === "ABG" || svc === "SPUTUM_INDUCTION" ? svc : "PFT",
    });
    return Response.json({ batchId }, { headers: NO_STORE });
  } catch (e) {
    if (e instanceof ClinicalError)
      return Response.json({ error: e.message, detail: e.detail }, { status: e.kind === "CONFLICT" ? 409 : 400, headers: NO_STORE });
    return Response.json({ error: "The workbook could not be staged. Nothing was saved." }, { status: 500, headers: NO_STORE });
  }
}
