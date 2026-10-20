# QA13 — Notion destination-change regression (2026-10-20)

Scope: repair functional delivery/retry handling; no UI redesign, sharing-permission changes, price changes, or replay of the user's article.

## Observations

- The user's newly selected ordinary parent page was persisted and matched the failed task's immutable destination snapshot.
- Authenticated read of that parent succeeded. Notion's read-only access metadata reported create/update tools available.
- Independent synthetic create returned a real page ID under the new parent. Public edit permission is not needed.
- Independent attempts also reproduced `ECONNREFUSED` and `ETIMEDOUT` during connect/discovery. A bounded reconnect succeeded before the synthetic create was sent once.
- Same-page synthetic update lost its response (`ETIMEDOUT`). Do not repeat it; read the same page to determine whether it applied. This is NOT a passed update/read-back test yet.
- Historical article receipts lack the underlying error phase. They remain unresolved; neither successful synthetic creation nor a network failure proves what happened to that earlier write.

## Changes

- Persist reviewed phase/reason/code metadata, never raw provider text, article text, or credentials.
- Distinguish known-not-sent, explicit precondition rejection, and unknown write effects.
- Retry read-only discovery/readback on transient failure in a bounded way. Never replay a sent mutation after a timeout.
- Recheck exact owner/grant/parent immediately before a write.
- Permit explicit retry only for proven non-writes. Preserve the Notion destination and clear only that known-unapplied Notion step, not unrelated completed/uncertain work.
- Legacy/unknown receipts still require reconciliation, not a blind replay.

## Automated evidence

- Relevant regression suite: 137 passed (before the final discovery/recovery additions).
- Final full suite: 971 tests, 970 passed, one pre-existing optional large-file skip; zero failures.
- Type check, production build, and `git diff --check` passed.
- Regression cases cover changed grants, exact parent pre-send checks, cross-workspace/user denial, pre-send versus sent failures, raw-secret suppression, safe manual recovery, and unknown-write protection.

Release/live ONE end-to-end verification is recorded after deployment; interface changes are out of scope.

## Normal ONE flow, QA14

- Release `b44232df6517e7d441b27706a4d56850c0510d93` deployed; public health passed.
- Submitted one independent three-line synthetic note via the normal main-chat Notion destination, title `QA14新位置交付1020`. No article replay.
- Two `delegate_task` calls were rejected before execution. No child write task was created. The historical trace retained no invalid field or rejection cause, so the exact malformed argument is not established.
- Subsequent read-only trace inspection confirmed QA14 was submitted with `boundTaskId=cnv_51c04ac4982fd462a175` (the earlier QA10 synthetic local task). The new-task instruction conflicted with that binding. This is an acceptance setup error, not evidence of a Notion write failure. The UI binding was cleared before the next independent acceptance. Do not weaken bound-task authorization to accommodate this mistake.
- Separately reproduced a deterministic policy error: the word `检查` in the note body plus `Notion` elsewhere in the request incorrectly required a knowledge search. Saving and readback now remain separate from retrieval intent; explicit cross-platform search remains required.
- Single-task validators now return only code-owned field-repair hints, preserving all owner/executor/bound-task checks. The orchestrator gives these hints a bounded correction opportunity rather than discarding their reason or executing invalid input.
- Targeted regression: 120 passed, including no duplicate dispatch, no foreign-task access, safe rejection diagnostics, and correction limits. A new normal-flow acceptance is still required after deployment; QA14 is NOT a pass.
- Follow-up full suite: 974 total, 973 passed, one pre-existing optional large-file skip, zero failures. Type check, production build and diff whitespace checks passed. No UI/layout changes.
- Read-only reconciliation of the QA13 update found the original synthetic text still present; the sent update is not replayed. Provider-only creation does not substitute for normal ONE end-to-end acceptance.

## QA15 and transport diagnosis

- Release `f0f3a0099007d418b2c408e302aaf7705c65071c`, CI `39408747337`, all jobs/deploy succeeded; server symlink and public health confirmed.
- QA15 normal-flow dispatch created exactly one independent child `cnv_71eb515e9016cf03b008`, targeting the new parent. No reference pages configured. Initial run `work_b0b3d2df4ff7a81c6359e` failed before sending: receipt `delivery=not_sent`, diagnostic `phase=connect, reason=connection`.
- One explicit recovery was accepted on the same task. It failed at send (`work_39211b0c5200683e39bf`, unknown delivery, no page ID). This write must not be replayed; no success is claimed.
- Credential-free endpoint probes returned 401, ECONNREFUSED, 401. A DNS-address comparison found one IPv4 address refusing connection while the other three completed TLS and returned the expected unauthenticated 401. This isolates an observed connection-path failure from page permissions, without establishing the historical article's exact failure.
- Add a Notion-only transport with explicit DNS-address/family failover before HTTP delivery, leaving hostname/SNI/certificate verification and redirect denial intact. Not a generic HTTP retry or global dispatcher replacement; no hardcoded production IP addresses.
- A real local socket regression proves a dead first DNS address can fall back to a live one while sending exactly one POST. Unknown sent writes remain protected.
- Same-server credential-free comparison with a fresh failover-enabled Agent for each request: six of six returned expected unauthenticated 401 (0.8–2.9 seconds), versus one connection refusal in three default-fetch attempts. This is transport evidence only, not a document-write pass.
- Transport release checks: 976 total tests, 975 passed, one existing optional skip, zero failures; type check/build/diff passed. Newly pinned `undici@7.30.1` has no audit advisory; existing unrelated dependency advisories are not silently upgraded as part of this fix.
