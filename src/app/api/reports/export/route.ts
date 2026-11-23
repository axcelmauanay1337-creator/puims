import { PERIODS, type Period } from "@/lib/metrics/periods";
import { ClinicalError } from "@/server/clinical";
import { exportReport, type ExportKind } from "@/server/reports";
import { rateLimit } from "@/server/rateLimit";
import { getSession } from "@/server/session";

/** Audited CSV export (Chief RT). Query carries only codes and a date — never patient data. */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return new Response("Sign in again.", { status: 401, headers: { "cache-control": "no-store" } });
  const rl = rateLimit(`export:${session.userId}`, 20, 60_000);
  if (!rl.ok) return new Response("Too many exports. Wait a minute.", { status: 429, headers: { "cache-control": "no-store" } });
  const u = new URL(req.url);
  const kind = u.searchParams.get("kind") as ExportKind;
  const period = u.searchParams.get("period") as Period;
  const mode = u.searchParams.get("mode") === "calendar" ? "calendar" : "operational";
  const date = u.searchParams.get("date") ?? "";
  if (!["summary", "daily", "appointments"].includes(kind) || !PERIODS.includes(period) || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return new Response("Invalid request.", { status: 400, headers: { "cache-control": "no-store" } });
  try {
    const { fileName, csv } = await exportReport(session, kind, period, mode, date);
    return new Response("﻿" + csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${fileName}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (e) {
    const status = e instanceof ClinicalError && e.kind === "FORBIDDEN" ? 403 : 500;
    return new Response(status === 403 ? "Not permitted." : "Export failed.", { status, headers: { "cache-control": "no-store" } });
  }
}
