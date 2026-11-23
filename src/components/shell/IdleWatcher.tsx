"use client";

import { useEffect, useRef } from "react";
import { idleLogoutAction } from "@/app/actions/auth";

const KEY = "puims:lastActivity";
const HEARTBEAT_MS = 60_000;

/**
 * Signs the user out after `idleMinutes` without interaction (U-14).
 * Activity is shared across tabs via localStorage so one idle tab does not end
 * a session that is in active use elsewhere. While the user is active, a
 * throttled heartbeat keeps the server-side idle timer in step; background
 * polling (connectivity probe) deliberately does NOT extend the session.
 */
export function IdleWatcher({ idleMinutes }: { idleMinutes: number }) {
  const lastBeat = useRef(0);
  const loggingOut = useRef(false);

  useEffect(() => {
    const now = () => Date.now();
    const read = () => {
      try {
        return Number(localStorage.getItem(KEY)) || now();
      } catch {
        return local;
      }
    };
    let local = now();
    const mark = () => {
      local = now();
      try {
        localStorage.setItem(KEY, String(local));
      } catch {
        /* storage unavailable: per-tab tracking only */
      }
      if (local - lastBeat.current > HEARTBEAT_MS) {
        lastBeat.current = local;
        fetch("/api/auth/heartbeat", { method: "POST", cache: "no-store" })
          .then((r) => {
            // Full page load on purpose: drops all client-side cached patient data from memory.
            // eslint-disable-next-line @next/next/no-location-assign-relative-destination
            if (r.status === 401) window.location.assign("/login?reason=idle");
          })
          .catch(() => {});
      }
    };
    mark();
    const events = ["pointerdown", "keydown", "touchstart", "wheel"] as const;
    events.forEach((e) => window.addEventListener(e, mark, { passive: true }));
    const timer = setInterval(() => {
      const last = Math.max(read(), local);
      if (!loggingOut.current && now() - last > idleMinutes * 60_000) {
        loggingOut.current = true;
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        idleLogoutAction().catch(() => window.location.assign("/login?reason=idle"));
      }
    }, 15_000);
    return () => {
      events.forEach((e) => window.removeEventListener(e, mark));
      clearInterval(timer);
    };
  }, [idleMinutes]);

  return null;
}
