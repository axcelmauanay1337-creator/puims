import { ClinicalError } from "@/server/clinical";
import { exceptionReport } from "@/server/importer";
import { getSession } from "@/server/session";

/** Exception report CSV (sheet + row numbers and flags only — no patient values). Download is audited. */
export async function GET(_req: Request, ctx: RouteContext<"/api/import/[id]/report">) {
  const session = await getSession();
  if (!session) return new Response("Sign in again.", { status: 401, headers: { "cache-control": "no-store" } });
  const { id } = await ctx.params;
  try {
    const { fileName, csv } = await exceptionReport(session, id);
    return new Response("﻿" + csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${fileName}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (e) {
    const status = e instanceof ClinicalError ? (e.kind === "FORBIDDEN" ? 403 : 404) : 500;
    return new Response("Not available.", { status, headers: { "cache-control": "no-store" } });
  }
}
