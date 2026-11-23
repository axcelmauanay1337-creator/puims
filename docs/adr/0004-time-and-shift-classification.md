# ADR-0004: Time handling and shift classification

Status: Accepted (M1)

**Decision.** Store UTC instants. Interpret in an explicit IANA zone (`Asia/Manila`) using `Intl` — no host-timezone dependence (unit tests run under `America/Los_Angeles`, e2e browser under `America/New_York`). Half-open windows `[start, end)`. Operational date = local date, minus one day when local hour < 06:00. Display strings are built from numeric parts (not locale strings) so server and browser render identically.

From M2 the same rule is implemented as a PostgreSQL function used by triggers so the database is authoritative; a shared test table of boundary instants (05:59, 06:00, 13:59, 14:00, 21:59, 22:00, 23:59, 00:00) runs against both implementations.
