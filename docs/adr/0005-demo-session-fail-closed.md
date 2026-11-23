# ADR-0005: Demo session for Milestone 1, fail-closed

Status: **Superseded** by ADR-0006 (Milestone 2). The demo session and PUIMS_DEMO_MODE no longer exist.

**Decision.** Without an identity provider the app renders "Authentication not configured" and serves no data. A synthetic-data demo session is available only when `PUIMS_DEMO_MODE=true` and the deployment profile is `development` or `uat`. The demo role switch (Chief RT / RT) is a server action that refuses outside demo mode. Users will never choose their own role once real accounts exist.
