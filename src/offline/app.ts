/**
 * PUIMS offline capture page (served as static /offline-capture.html + /offline/capture.js).
 * Framework-free so the service worker can cache it whole; the HTML contains no patient data —
 * everything shown comes from the encrypted snapshot, decrypted in memory with the lease key.
 * All text is set with textContent (never innerHTML).
 */
import { HOSPITAL_TZ, toLocalParts } from "@/lib/time/zoned";
import { importLeaseKey, open, seal } from "./crypto";
import { openStore } from "./idb";
import { acknowledge, capture, outgoing, StorageFullError, type Meta, type ServerResult, type Store } from "./queue";

interface Snapshot {
  takenIso: string;
  nebSlots: Array<{ orderId: string; scheduledIso: string; patient: string; hospitalId: string; ward: string | null; medication: string; frequency: string }>;
  encounters: Array<{ encounterId: string; patient: string; hospitalId: string; ward: string; ventilatorRef: string; lastReplacementIso: string | null }>;
}

const state: {
  store: Store | null;
  meta: Meta | null;
  key: CryptoKey | null;
  snapshot: Snapshot | null;
  online: boolean;
  pending: number;
  message: { kind: "ok" | "error" | "info"; text: string } | null;
  review: ServerResult[];
  busy: boolean;
} = { store: null, meta: null, key: null, snapshot: null, online: false, pending: 0, message: null, review: [], busy: false };

// ---------------------------------------------------------------- helpers

type Attrs = Record<string, string | boolean | ((e: Event) => void)>;
function h(tag: string, attrs: Attrs = {}, ...children: Array<Node | string | null | false>): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (typeof v === "boolean") {
      if (v) el.setAttribute(k, "");
    } else el.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== false) el.append(typeof c === "string" ? document.createTextNode(c) : c);
  return el;
}
const z = (n: number) => String(n).padStart(2, "0");
function manila(d: Date) {
  const p = toLocalParts(d, HOSPITAL_TZ);
  return { wall: `${p.year}-${z(p.month)}-${z(p.day)}T${z(p.hour)}:${z(p.minute)}`, label: `${p.day}/${p.month} ${z(p.hour)}:${z(p.minute)}` };
}

async function api<T>(path: string, body: unknown): Promise<{ status: number; data: T | null; error: string | null }> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      credentials: "same-origin",
    });
    const j = (await res.json().catch(() => ({}))) as T & { error?: string };
    return { status: res.status, data: res.ok ? j : null, error: res.ok ? null : (j.error ?? `Server answered ${res.status}.`) };
  } catch {
    return { status: 0, data: null, error: "PUIMS server unreachable." };
  }
}

async function probe(): Promise<boolean> {
  try {
    const r = await fetch("/api/health", { cache: "no-store" });
    return r.ok;
  } catch {
    return false;
  }
}

async function refreshCount() {
  state.pending = state.store ? (await state.store.entries()).length : 0;
}

// ---------------------------------------------------------------- actions

async function prepare() {
  state.busy = true;
  render();
  const r = await api<{ leaseId: string; key: string; issuedIso: string; expiresIso: string; staff: string; snapshot: Snapshot }>("/api/offline/lease", {});
  state.busy = false;
  if (!r.data) {
    state.message = {
      kind: "error",
      text: r.status === 401 ? "Sign in to PUIMS first (in this browser), then come back." : (r.error ?? "Could not prepare offline use."),
    };
    return render();
  }
  try {
    await navigator.storage?.persist?.();
  } catch {
    /* best effort */
  }
  const key = await importLeaseKey(r.data.key);
  const meta: Meta = {
    leaseId: r.data.leaseId,
    expiresIso: r.data.expiresIso,
    issuedIso: r.data.issuedIso,
    staff: r.data.staff,
    snapshotTakenIso: r.data.snapshot.takenIso,
    snapshot: await seal(key, r.data.snapshot, `puims-offline:v1:${r.data.leaseId}:snapshot`),
    lastSyncIso: state.meta?.lastSyncIso ?? null,
  };
  await state.store!.putMeta(meta);
  state.meta = meta;
  state.key = key;
  state.snapshot = r.data.snapshot;
  state.message = {
    kind: "ok",
    text: `Ready for offline capture until ${manila(new Date(meta.expiresIso)).label}. Keep this tab open: the key is kept only in memory.`,
  };
  render();
}

async function unlock() {
  if (!state.meta) return;
  const r = await api<{ key: string; expiresIso: string }>("/api/offline/key", { leaseId: state.meta.leaseId });
  if (!r.data) {
    state.message = { kind: "error", text: r.status === 401 ? "Sign in to PUIMS in this browser, then press Unlock again." : (r.error ?? "Could not unlock.") };
    return render();
  }
  state.key = await importLeaseKey(r.data.key);
  try {
    state.snapshot = await open<Snapshot>(state.key, state.meta.snapshot, `puims-offline:v1:${state.meta.leaseId}:snapshot`);
  } catch {
    state.message = { kind: "error", text: "The stored worklist could not be decrypted on this device." };
  }
  render();
}

async function sync() {
  if (!state.store || !state.meta || !state.key || state.busy) return;
  state.busy = true;
  render();
  const keys = new Map([[state.meta.leaseId, state.key]]);
  const { ready, lockedLeases } = await outgoing(state.store, keys);
  if (lockedLeases.length) {
    // Entries from an earlier lease on this device: recover that lease's key (same staff + device only).
    for (const id of lockedLeases) {
      const r = await api<{ key: string }>("/api/offline/key", { leaseId: id });
      if (r.data) keys.set(id, await importLeaseKey(r.data.key));
    }
  }
  const all = lockedLeases.length ? (await outgoing(state.store, keys)).ready : ready;
  if (!all.length) {
    state.busy = false;
    state.message = { kind: "info", text: "Nothing waiting to sync." };
    return render();
  }
  // Entries are grouped per lease: the server checks each against its own lease.
  const byLease = new Map<string, typeof all>();
  for (const e of all) {
    const stored = (await state.store.entries()).find((x) => x.id === e.id)!;
    byLease.set(stored.leaseId, [...(byLease.get(stored.leaseId) ?? []), e]);
  }
  let removed = 0;
  let review: ServerResult[] = [];
  let error: string | null = null;
  for (const [leaseId, entries] of byLease) {
    for (let i = 0; i < entries.length; i += 200) {
      const chunk = entries.slice(i, i + 200);
      const r = await api<{ results: ServerResult[]; skewMs: number }>("/api/sync", { leaseId, deviceNow: new Date().toISOString(), entries: chunk });
      if (!r.data) {
        error =
          r.status === 401 ? "Your PUIMS session has ended. Sign in again in this browser; your entries are still saved here." : (r.error ?? "Sync failed.");
        break;
      }
      const ack = await acknowledge(state.store, chunk, r.data.results);
      removed += ack.removed;
      review = review.concat(ack.needsReview);
    }
    if (error) break;
  }
  state.meta = { ...state.meta, lastSyncIso: new Date().toISOString() };
  await state.store.putMeta(state.meta);
  await refreshCount();
  state.review = review;
  state.busy = false;
  state.message = error
    ? { kind: "error", text: `${error} ${removed} entr${removed === 1 ? "y" : "ies"} were received before the problem.` }
    : {
        kind: review.length ? "info" : "ok",
        text: `${removed} entr${removed === 1 ? "y" : "ies"} received by PUIMS.${review.length ? ` ${review.length} need review — open PUIMS → Devices & Sync → Sync review.` : ""}`,
      };
  render();
}

async function record(kind: "NEB_DOSE" | "TUBING_REPLACEMENT", payload: Record<string, unknown>) {
  try {
    await capture(state.store!, state.key!, state.meta!, { kind, payload });
    await refreshCount();
    state.message = { kind: "ok", text: "Saved on this device (encrypted). It will be sent when PUIMS is reachable." };
    if (state.online) void sync();
  } catch (e) {
    state.message = { kind: "error", text: e instanceof StorageFullError ? e.message : (e as Error).message };
  }
  render();
}

async function removeOfflineData() {
  await refreshCount();
  if (state.pending) {
    state.message = {
      kind: "error",
      text: `${state.pending} entr${state.pending === 1 ? "y has" : "ies have"} not been sent yet. Sync first — entries are never deleted unsent.`,
    };
    return render();
  }
  if (!confirm("Remove the offline worklist and lease from this device?")) return;
  await state.store!.clearMeta();
  state.meta = null;
  state.key = null;
  state.snapshot = null;
  state.message = { kind: "ok", text: "Offline data removed from this device." };
  render();
}

// ---------------------------------------------------------------- forms

function dialog(title: string, body: HTMLElement[], onSubmit: (f: FormData) => void) {
  const d = h("dialog", { "aria-labelledby": "dlg-h" }) as HTMLDialogElement;
  const form = h(
    "form",
    {
      method: "dialog",
      onsubmit: (e: Event) => {
        e.preventDefault();
        onSubmit(new FormData(e.target as HTMLFormElement));
        d.close();
        d.remove();
      },
    },
    h("h2", { id: "dlg-h" }, title),
    ...body,
    h(
      "div",
      { class: "row end" },
      h(
        "button",
        {
          type: "button",
          onclick: () => {
            d.close();
            d.remove();
          },
        },
        "Cancel",
      ),
      h("button", { type: "submit", class: "primary" }, "Save on this device"),
    ),
  );
  d.append(form);
  document.body.append(d);
  d.showModal();
}

function field(label: string, input: HTMLElement) {
  return h("label", {}, label, input);
}

function nebDialog(slot: Snapshot["nebSlots"][number]) {
  const now = manila(new Date()).wall;
  const status = h(
    "select",
    { name: "status", required: true },
    h("option", { value: "COMPLETED" }, "Given"),
    h("option", { value: "NOT_GIVEN" }, "Not given"),
    h("option", { value: "REFUSED" }, "Refused"),
    h("option", { value: "DELAYED" }, "Delayed"),
    h("option", { value: "CANCELLED" }, "Cancelled"),
  );
  dialog(
    `${slot.patient} — dose due ${manila(new Date(slot.scheduledIso)).label}`,
    [
      h("p", { class: "muted" }, `${slot.medication} · ${slot.frequency}`),
      field("What happened", status),
      field("Time (Asia/Manila)", h("input", { type: "datetime-local", name: "actualAt", value: now })),
      field("Reason (required unless given)", h("input", { name: "reason", maxlength: "300" })),
    ],
    (f) => {
      const st = String(f.get("status"));
      if (st !== "COMPLETED" && String(f.get("reason") ?? "").trim().length < 3) {
        state.message = { kind: "error", text: "A reason is required when the dose was not given. Nothing was saved." };
        return render();
      }
      void record("NEB_DOSE", {
        orderId: slot.orderId,
        scheduledAt: slot.scheduledIso,
        status: st,
        actualAt: st === "COMPLETED" ? String(f.get("actualAt")) : "",
        reason: String(f.get("reason") ?? ""),
      });
    },
  );
}

function tubingDialog(enc: Snapshot["encounters"][number]) {
  dialog(
    `${enc.patient} — tubing replacement (${enc.ventilatorRef})`,
    [
      field("Replaced at (Asia/Manila)", h("input", { type: "datetime-local", name: "installedAt", value: manila(new Date()).wall, required: true })),
      field("Reason", h("input", { name: "reason", required: true, minlength: "3", maxlength: "300", value: "Routine replacement" })),
    ],
    (f) => void record("TUBING_REPLACEMENT", { encounterId: enc.encounterId, installedAt: String(f.get("installedAt")), reason: String(f.get("reason")) }),
  );
}

// ---------------------------------------------------------------- render

function render() {
  const root = document.getElementById("app")!;
  const m = state.meta;
  const expired = m ? Date.now() > Date.parse(m.expiresIso) : false;
  const status = h(
    "div",
    { class: `status ${state.online ? "on" : "off"}`, role: "status" },
    h("strong", {}, state.online ? "● Online — PUIMS reachable" : "○ Offline — PUIMS unreachable"),
    h("span", {}, ` · ${state.pending} entr${state.pending === 1 ? "y" : "ies"} waiting to sync`),
    m ? h("span", {}, ` · lease ${expired ? "EXPIRED" : "until " + manila(new Date(m.expiresIso)).label}`) : null,
    m?.lastSyncIso ? h("span", {}, ` · last sync ${manila(new Date(m.lastSyncIso)).label}`) : h("span", {}, " · never synced"),
  );
  const parts: Array<HTMLElement | null> = [status];
  if (state.message) parts.push(h("p", { class: `msg ${state.message.kind}`, role: state.message.kind === "error" ? "alert" : "status" }, state.message.text));

  if (!m) {
    parts.push(
      h(
        "section",
        {},
        h("h2", {}, "Not prepared"),
        h("p", {}, "This device holds no offline worklist. While online and signed in, an RT on a device approved by the Chief RT can prepare it."),
        state.online
          ? h("button", { class: "primary", onclick: () => void prepare(), disabled: state.busy }, state.busy ? "Preparing…" : "Prepare offline capture")
          : null,
      ),
    );
  } else if (!state.key) {
    parts.push(
      h(
        "section",
        {},
        h("h2", {}, "Locked"),
        h(
          "p",
          {},
          `${state.pending} encrypted entr${state.pending === 1 ? "y is" : "ies are"} saved on this device. The key is kept only in memory, so after a reload it must be fetched again from PUIMS.`,
        ),
        state.online
          ? h("button", { class: "primary", onclick: () => void unlock() }, "Unlock (fetch key from PUIMS)")
          : h("p", {}, "Reconnect to PUIMS to unlock and sync. Until then, document on paper."),
      ),
    );
  } else {
    const snap = state.snapshot;
    parts.push(
      h(
        "div",
        { class: "row" },
        h(
          "button",
          { class: "primary", onclick: () => void sync(), disabled: !state.online || state.busy || !state.pending },
          state.busy ? "Syncing…" : "Sync now",
        ),
        state.online ? h("button", { onclick: () => void prepare() }, "Refresh worklist (new lease)") : null,
        h("button", { onclick: () => void removeOfflineData() }, "Remove offline data"),
      ),
    );
    if (expired) parts.push(h("p", { class: "msg error" }, "The lease has expired: no new entries can be captured. Sync what is saved."));
    parts.push(
      h(
        "p",
        { class: "muted" },
        `Worklist as of ${snap ? manila(new Date(snap.takenIso)).label : "—"} for ${m.staff}. It does not show what others documented since.`,
      ),
    );
    const neb = h("section", {}, h("h2", {}, "Nebulization doses due"));
    if (!snap?.nebSlots.length) neb.append(h("p", { class: "muted" }, "None in the snapshot."));
    for (const s of snap?.nebSlots ?? [])
      neb.append(
        h(
          "div",
          { class: "card" },
          h(
            "div",
            {},
            h("strong", {}, s.patient),
            h("span", { class: "muted" }, ` · ${s.hospitalId}${s.ward ? " · " + s.ward : ""}`),
            h("div", { class: "muted" }, `${manila(new Date(s.scheduledIso)).label} · ${s.medication}`),
          ),
          h("button", { onclick: () => nebDialog(s), disabled: expired }, "Document"),
        ),
      );
    const vent = h("section", {}, h("h2", {}, "Ventilator tubing"));
    if (!snap?.encounters.length) vent.append(h("p", { class: "muted" }, "No active encounters in the snapshot."));
    for (const e of snap?.encounters ?? [])
      vent.append(
        h(
          "div",
          { class: "card" },
          h(
            "div",
            {},
            h("strong", {}, e.patient),
            h("span", { class: "muted" }, ` · ${e.ventilatorRef} · ${e.ward}`),
            h("div", { class: "muted" }, `Last documented replacement: ${e.lastReplacementIso ? manila(new Date(e.lastReplacementIso)).label : "none"}`),
          ),
          h("button", { onclick: () => tubingDialog(e), disabled: expired }, "Replacement"),
        ),
      );
    parts.push(neb, vent);
    if (state.review.length)
      parts.push(
        h("section", {}, h("h2", {}, "Needs review in PUIMS"), ...state.review.map((r) => h("p", { class: "msg info" }, `${r.outcome}: ${r.message ?? ""}`))),
      );
  }
  root.replaceChildren(...parts.filter((x): x is HTMLElement => !!x));
}

async function main() {
  state.store = await openStore();
  state.meta = await state.store.getMeta();
  await refreshCount();
  state.online = await probe();
  render();
  const recheck = async () => {
    const was = state.online;
    state.online = navigator.onLine ? await probe() : false;
    render();
    if (!was && state.online && state.key && state.pending) void sync();
  };
  window.addEventListener("online", () => void recheck());
  window.addEventListener("offline", () => void recheck());
  setInterval(() => void recheck(), 30_000);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
}

void main().catch(() => {
  document.getElementById("app")!.textContent =
    "Offline storage is not available in this browser (private mode or blocked). Offline capture cannot be used here.";
});
