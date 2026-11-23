/**
 * Unauthenticated liveness probe used by the connectivity indicator.
 * Returns NO patient or user data — only server time (for clock-skew
 * detection) and the deployment profile (to distinguish LAN vs cloud).
 */
const PROFILES = new Set(["development", "uat", "lan", "cloud"]);

export function GET() {
  const raw = process.env.PUIMS_DEPLOYMENT_PROFILE ?? "development";
  const profile = PROFILES.has(raw) ? raw : "development";
  return Response.json({ status: "ok", serverTime: new Date().toISOString(), profile, timeZone: "Asia/Manila" }, { headers: { "cache-control": "no-store" } });
}
