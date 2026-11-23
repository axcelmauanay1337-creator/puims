# ADR-0002: Cache Components disabled; no shared caching of PHI

Status: Accepted (M1)

**Context.** Next.js 16 scaffolds with `cacheComponents: true`, which prerenders static shells and encourages `use cache`. Every PUIMS page is per-user and may contain PHI.

**Decision.** Disable Cache Components and Partial Prefetching. All PHI routes are dynamic (verified in build output). Pages and APIs send `Cache-Control: no-store`. Caching will be opted into only for PHI-free content after review.

**Consequences.** Slightly more server work per request (negligible at unit scale). No risk of one user's PHI being served from a shared cache to another.
