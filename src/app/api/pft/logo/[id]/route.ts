import { templateLogo } from "@/server/pft";
import { getSession } from "@/server/session";

/** Hospital logo for a PFT template version. Not patient data; template versions never change, so it may be cached privately. */
export async function GET(_req: Request, ctx: RouteContext<"/api/pft/logo/[id]">) {
  const session = await getSession();
  if (!session) return new Response(null, { status: 401 });
  const { id } = await ctx.params;
  const logo = await templateLogo(session, id).catch(() => null);
  if (!logo) return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  return new Response(new Uint8Array(logo.bytes), {
    headers: {
      "content-type": logo.mime,
      "cache-control": "private, max-age=86400, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
    },
  });
}
