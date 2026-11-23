import "server-only";
import { headers } from "next/headers";
import type { RequestMeta } from "./service";

/** Client IP only when explicitly behind a trusted reverse proxy; otherwise not recorded. */
export async function requestMeta(deviceId: string | null): Promise<RequestMeta> {
  const h = await headers();
  const ip = process.env.PUIMS_TRUST_PROXY === "true" ? (h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null) : null;
  const validIp = ip && /^[0-9a-fA-F:.]{3,45}$/.test(ip) ? ip : null;
  return { ip: validIp, userAgent: h.get("user-agent"), deviceId };
}
