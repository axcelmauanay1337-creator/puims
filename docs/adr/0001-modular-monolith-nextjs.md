# ADR-0001: Modular monolith on Next.js + PostgreSQL

Status: Accepted (M0)

**Context.** One unit, one Chief RT, a handful of RTs; hospital LAN deployment likely; small ops team. Master prompt forbids microservices for the first release.

**Decision.** One Next.js (App Router, Node runtime) application with module folders for UI, a server-only data-access layer, and one authoritative PostgreSQL database per deployment. No separate API service.

**Consequences.** Simple deployment (one process + DB) on a LAN server or cloud VM. Module boundaries are enforced by folder conventions (`src/server` is `server-only`; `src/lib` is pure). A future sync gateway (M7+) can be extracted behind the same DAL if needed.
