import { ClinicalError } from "@/server/clinical";
import { originalWorkbook } from "@/server/importer";
import { getSession } from "@/server/session";

/** The retained original workbook (Chief RT; requires a recent password confirmation). Audited. */
export async function GET(_req: Request, ctx: RouteContext<"/api/import/[id]/original">) {
  const session = await getSession();
  if (!session) return new Response("Sign in again.", { status: 401, headers: { "cache-control": "no-store" } });
  const { id } = await ctx.params;
  try {
    const { fileName, bytes } = await originalWorkbook(session, id);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="${fileName.replace(/[^\w.() -]/g, "_")}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (e) {
    if (e instanceof ClinicalError) {
      const status = e.kind === "REAUTH_REQUIRED" ? 403 : e.kind === "FORBIDDEN" ? 403 : 404;
      return new Response(e.kind === "REAUTH_REQUIRED" ? "Confirm your password first." : e.message, {
        status,
        headers: { "cache-control": "no-store" },
      });
    }
    return new Response("Not available.", { status: 500, headers: { "cache-control": "no-store" } });
  }
}
