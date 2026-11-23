"use client";

import { useEffect, useState } from "react";
import { CLOCK_SKEW_WARN_MS, MODE_COPY, useConnectivity } from "@/components/shell/Connectivity";
import { formatDateTime } from "@/lib/time/zoned";

interface StorageInfo {
  usage: number | null;
  quota: number | null;
  persisted: boolean | null;
}

/** Live status of THIS device, as observed by the browser. */
export function ThisDeviceStatus() {
  const c = useConnectivity();
  const [sw, setSw] = useState<string>("Checking…");
  const [storage, setStorage] = useState<StorageInfo>({ usage: null, quota: null, persisted: null });
  const [standalone, setStandalone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const swState = !("serviceWorker" in navigator)
        ? "Not supported by this browser"
        : (await navigator.serviceWorker.getRegistration())?.active
          ? "Active — app shell available offline (no patient data)"
          : process.env.NODE_ENV !== "production"
            ? "Not registered in development builds"
            : "Not yet active";
      let info: StorageInfo = { usage: null, quota: null, persisted: null };
      if (navigator.storage?.estimate) {
        const est = await navigator.storage.estimate();
        info = { usage: est.usage ?? null, quota: est.quota ?? null, persisted: navigator.storage.persisted ? await navigator.storage.persisted() : null };
      }
      if (!cancelled) {
        setSw(swState);
        setStorage(info);
        setStandalone(window.matchMedia?.("(display-mode: standalone)").matches ?? false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const mb = (n: number | null) => (n === null ? "—" : `${(n / 1_048_576).toFixed(1)} MB`);
  const skew = c.clockSkewMs;
  const rows: Array<[string, string]> = [
    ["Connection", MODE_COPY[c.mode].label],
    ["Last server contact", c.lastContactIso ? formatDateTime(new Date(c.lastContactIso)) : "None this session"],
    [
      "Device clock vs server",
      skew === null
        ? "Not measured yet"
        : Math.abs(skew) > CLOCK_SKEW_WARN_MS
          ? `⚠ off by ${Math.round(skew / 1000)} s — correct the device clock`
          : "In agreement",
    ],
    ["Installed as app", standalone ? "Yes (standalone)" : "No — running in a browser tab"],
    ["App-shell service worker", sw],
    ["Offline patient data on this device", "None — PHI offline storage disabled"],
    ["Offline documentation queue", "Not available on this device yet"],
    ["Pending items / conflicts", "None (no queue)"],
    ["Browser storage used / quota", `${mb(storage.usage)} / ${mb(storage.quota)}`],
  ];
  return (
    <dl className="divide-y divide-line-soft text-[13px]" data-testid="this-device">
      {rows.map(([k, v]) => (
        <div key={k} className="grid gap-1 py-2 sm:grid-cols-[16rem_1fr]">
          <dt className="text-ink-3">{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
