# Canary authorization — solo operator (2026-10-22)

Authorizer: solo operator (sole developer). No independent human reviewer exists on this project; subagent review does not substitute for this authorization.

## Authorized scope
1. **Real-source acquisition smoke** (read-only): bounded Serper + sitemap retrieval against live manufacturer pages. No store writes, no publication, no mutation of any kind.
2. **Compatible store canary**: import → finalize → publish path against the store, executed script-first with explicit operator sign-off required at each gate (import, finalize, publish). Any step may be halted; a halt records `BLOCKED`, never a pass.

## Constraints
- Credentials: existing approved connections / environment only. Never on the command line, never in logs or reports.
- Receipts: actual responses, latencies, and provider receipts recorded per call. No simulated success, no mocked decisions.
- This authorization covers §11.1 Ticket 7 / §11.2 item 6 evidence only. It does not approve activation, release, or any production data change beyond the canary path above.
- Revocable at any time by the operator; revocation invalidates any in-flight canary claim.

## Track
Qualify-first closeout · PR #383 · branch feat/typesafe-onboarding-expansion.
