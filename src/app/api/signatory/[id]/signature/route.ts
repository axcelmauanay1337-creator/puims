import { signatureImage } from "@/server/pft";
import { getSession } from "@/server/session";

/** Approved e-signature image (signed-in users; printed on PFT records). */
export async function GET(_req: Request, ctx: RouteContext<"/api/signatory/[id]/signature">) {
  const s = await getSession();
  if (!s) return new Response(null, { status: 401 });
  const { id } = await ctx.params;
  const img = await signatureImage(s, id).catch(() => null);
  if (!img) return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  return new Response(new Uint8Array(img.bytes), {
    headers: { "content-type": img.mime, "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'" },
  });
}
