import "server-only";

/** Single source of "now" for server code (one place to inject a test clock later). */
export function getNow(): Date {
  return new Date();
}
