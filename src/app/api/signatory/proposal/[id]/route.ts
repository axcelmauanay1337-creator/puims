import { proposalImage } from "@/server/pft";
import { getSession } from "@/server/session";

/** Signature image of a staged proposal from the PFT guide (Chief RT only). */
export async function GET(_req: Request, ctx: RouteContext<"/api/signatory/proposal/[id]">) {
  const s = await getSession();
  if (!s) return new Response(null, { status: 401 });
  const { id } = await ctx.params;
  const img = await proposalImage(s, id).catch(() => null);
  if (!img) return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  return new Response(new Uint8Array(img.bytes), {
    headers: { "content-type": img.mime, "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'" },
  });
}
