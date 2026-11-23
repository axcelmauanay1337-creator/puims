"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/**
 * Connectivity state, reported truthfully (ARCHITECTURE_AND_OFFLINE_DESIGN §2, §6).
 *
 * We probe the PUIMS server's /api/health. What matters to a clinician is
 * whether the AUTHORITATIVE server is reachable, and which deployment profile
 * answered (hospital LAN endpoint vs remote/cloud). Browser `navigator.onLine`
 * alone is not trusted — it only says a network interface exists.
 *
 * Milestone 1 has NO offline data store and NO sync queue, so the UI says so
 * explicitly instead of showing a fake "last synced" time or "0 pending".
 */

export type ServerProfile = "development" | "uat" | "lan" | "cloud";
export type ConnectionMode = "checking" | "online" | "local-server" | "offline";

export interface ConnectivityState {
  mode: ConnectionMode;
  profile: ServerProfile | null;
  lastContactIso: string | null;
  /** device clock minus server clock, ms (positive = device ahead). */
  clockSkewMs: number | null;
  lastError: string | null;
  checkNow: () => void;
  /** Milestone-7 capability flags — false until implemented and approved. */
  offlineStoreEnabled: false;
}

const Ctx = createContext<ConnectivityState | null>(null);

const POLL_MS = 30_000;
export const CLOCK_SKEW_WARN_MS = 2 * 60_000;

export function ConnectivityProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ConnectionMode>("checking");
  const [profile, setProfile] = useState<ServerProfile | null>(null);
  const [lastContactIso, setLastContact] = useState<string | null>(null);
  const [clockSkewMs, setSkew] = useState<number | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const inflight = useRef(false);

  const probe = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6_000);
    try {
      const sent = Date.now();
      const res = await fetch("/api/health", { cache: "no-store", signal: controller.signal, headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`Server responded ${res.status}`);
      const body = (await res.json()) as { serverTime: string; profile: ServerProfile };
      const received = Date.now();
      const serverMs = Date.parse(body.serverTime);
      const midpoint = sent + (received - sent) / 2;
      setSkew(Math.round(midpoint - serverMs));
      setProfile(body.profile);
      setMode(body.profile === "lan" ? "local-server" : "online");
      setLastContact(new Date(received).toISOString());
      setLastError(null);
    } catch (e) {
      setMode("offline");
      setLastError(e instanceof Error && e.name === "AbortError" ? "Server did not respond in time" : "PUIMS server unreachable");
    } finally {
      clearTimeout(timer);
      inflight.current = false;
    }
  }, []);

  useEffect(() => {
    const kick = () => void probe();
    const initial = setTimeout(kick, 0);
    const id = setInterval(kick, POLL_MS);
    const goOffline = () => {
      setMode("offline");
      setLastError("Device reports no network connection");
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") kick();
    };
    window.addEventListener("online", kick);
    window.addEventListener("offline", goOffline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(initial);
      clearInterval(id);
      window.removeEventListener("online", kick);
      window.removeEventListener("offline", goOffline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [probe]);

  const value = useMemo<ConnectivityState>(
    () => ({ mode, profile, lastContactIso, clockSkewMs, lastError, checkNow: () => void probe(), offlineStoreEnabled: false }),
    [mode, profile, lastContactIso, clockSkewMs, lastError, probe],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useConnectivity(): ConnectivityState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useConnectivity must be used inside ConnectivityProvider");
  return v;
}

export const MODE_COPY: Record<ConnectionMode, { label: string; short: string; glyph: string; tone: "success" | "info" | "danger" | "neutral" }> = {
  checking: { label: "Checking connection…", short: "Checking", glyph: "…", tone: "neutral" },
  online: { label: "Online — connected to PUIMS server", short: "Online", glyph: "●", tone: "success" },
  "local-server": { label: "Local server — connected to hospital LAN endpoint", short: "Local server", glyph: "◆", tone: "info" },
  offline: { label: "Offline — PUIMS server unreachable", short: "Offline", glyph: "○", tone: "danger" },
};
