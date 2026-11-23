"use client";

import { useEffect } from "react";

/**
 * Registers the app-shell service worker in production builds only.
 * The worker caches static, PHI-free assets and an offline notice page; it
 * never caches HTML pages, API responses or anything containing patient data.
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {
      /* Non-fatal: the app works online without the worker. */
    });
  }, []);
  return null;
}
