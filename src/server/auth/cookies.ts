import "server-only";

/**
 * Cookie names and flags. `__Host-` prefix (requires Secure, Path=/, no Domain)
 * except for local plain-HTTP testing with PUIMS_INSECURE_COOKIES=true.
 */
export const insecureCookies = () =>
  process.env.PUIMS_INSECURE_COOKIES === "true" && process.env.PUIMS_DEPLOYMENT_PROFILE !== "lan" && process.env.PUIMS_DEPLOYMENT_PROFILE !== "cloud";
export const SESSION_COOKIE = () => (insecureCookies() ? "puims_session" : "__Host-puims_session");
export const PENDING_COOKIE = () => (insecureCookies() ? "puims_pending" : "__Host-puims_pending");
export const DEVICE_COOKIE = () => (insecureCookies() ? "puims_device" : "__Host-puims_device");

export function cookieOptions(maxAgeSeconds?: number) {
  return {
    httpOnly: true,
    secure: !insecureCookies(),
    sameSite: "strict" as const,
    path: "/",
    ...(maxAgeSeconds ? { maxAge: maxAgeSeconds } : {}),
  };
}
