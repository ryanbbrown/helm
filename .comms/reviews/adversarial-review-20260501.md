# Codex Adversarial Review — 2026-05-01

**Target:** working tree diff
**Verdict:** needs-attention

No ship: the documented archive API contract does not match the daemon implementation for the destructive force flag.

## Findings

### [medium] Archive force flag ignores documented request body

**Location:** `packages/daemon/src/server.ts:79-80`

The updated spec documents `POST /sessions/:id/archive` as accepting `Body: { force? }`, but the route only reads `?force=1` from the URL. Any client built against the new API contract will send `{ "force": true }`, still hit the dirty/unshared-work guards, and be unable to complete the confirmed archive path. Existing CLI/web callers use the query string, so this drift is easy to miss in tests while the public API is already wrong.

**Recommendation:** Parse the archive request body for `force` or change the spec and all clients to explicitly document query-string force. Add a route-level test that verifies body `{ force: true }` archives a dirty/unshared session and body/query absence returns 409.

## Next steps

- Align the archive route, spec, CLI/web clients, and tests on one force-flag contract.
