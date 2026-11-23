import type { NextConfig } from "next";

/**
 * ADR-0002: Cache Components is deliberately OFF. Every PUIMS page is
 * per-user and may contain PHI; nothing patient-related may enter a shared
 * server-side or CDN cache. Caching will be opted into only for PHI-free
 * content after review.
 */

// Content-Security-Policy is set per request with a nonce in src/proxy.ts.

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  turbopack: {
    rules: {
      "*.css": { loaders: ["@tailwindcss/turbopack"], as: "*.css" },
    },
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      {
        // Pages and APIs may contain PHI: never store in browser/proxy caches.
        source: "/((?!_next/static|icons/|sw.js|manifest.webmanifest|offline.html|offline-capture.html|offline/).*)",
        headers: [{ key: "Cache-Control", value: "no-store, max-age=0" }],
      },
      {
        // Static, PHI-free offline capture page: strict CSP without nonces (no inline code at all).
        source: "/:path(offline-capture.html|offline/capture.js|offline/capture.css)",
        headers: [
          {
            key: "Content-Security-Policy",
            value:
              "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          },
          { key: "Cache-Control", value: "no-cache" },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
