# Billing efficiency and account restoration — 2026-10-23

## Scope and safety

User-approved priorities: remove wasted orchestration/context work first; preserve output quality, tenant authorization and actual-usage settlement. Admin restoration exposes only gift-with-note and reset-current-period. This release does not change prices, grant real credits, reset real accounts or retry old business tasks.

Historical findings: Simple's inspected 2.949063 power included approximately 2.002838 attributed to cache writes (68%). Coordinator spend 2.376360 (81%) overlaps that cache figure; do not add them. Lao Xu's four failed dispatch attempts involved ten model calls, 0.938321 power and no successful worker dispatch. These are retail ledger observations, not reconciled supplier invoices or a promise that all spend is avoidable.

## Implemented

- Shared context compiler: explicit code-owned reusable prefix; role-specific instructions; task/date/attachment/reference data follow it. No flattening of tool output into trusted rules, no truncation of required user deliverables.
- Remove repeated coordinator catalog/behavior blocks and duplicate current worker handoff. Function SOPs remain on demand. Tone guidance is 603 bytes vs 1275 previously (52% smaller for that block only, NOT total token/cost savings).
- Fixed request-time date facts no longer acquire fresh millisecond timestamps on every call. Original timezone/calendar date remain anchored across retries.
- Native Anthropic stable-prefix cache breakpoint requests 5-minute TTL; OpenAI receives no internal annotations. Final summaries retain native tool definitions and disable calls, preserving the same prefix.
- Record content-free input sizes and scoped stable-prefix/schema fingerprints on usage rows. Admin detail ranks high-cost requests and shows retail cache attribution without exposing private conversation bodies.
- Unknown tools and invalid arguments have separate safe codes. Reject/trace the requested name; give only allowed names and reviewed repair hints; stop an identical rejected invocation before a third model attempt. Revocations and unknown side effects remain protected.
- No implicit 0.5-power router cap on ordinary chat; wallet holds, company limits and bounded orchestration still apply. Explicit route caps and saved worker/batch budgets remain enforced. Explain a route cap separately from low account balance.
- Do not reserve the already-included model prompt twice. Frozen pricing, actual provider usage settlement, hold release and retail charge cap are unchanged.
- Admin gift requires note and durable operation ID. Reset uses an exact preview of the current period and rejects stale confirmations. Both append ledger/audit entries and are idempotent. Reset preserves wallet, expiry, future periods, active holds and execution protections.
- Admin form starts with no selected user, has page-owned confirmation, frozen recovery payload persisted before send, and distinguishes successful operation from failed page refresh.

## Local verification

- Full suite: 1020 tests, 1019 passed, 0 failed, one pre-existing opt-in 110 MB PPT stress test skipped. Focused 136-test routing/billing suite also passed.
- Typecheck + production build passed. Existing bundle-size warning remains.
- New checks cover public/ordinary-user isolation, forged workspace inputs, stale reset previews, in-flight settlement after reset, replay after restart, native cache request shape, annotation stripping, unchanged settlement, duplicate prompt reservation and implicit/explicit router budget distinction.
- Browser synthetic harness (no server API): gift 2.5 changed permanent balance 14 -> 16.5; current allowance stayed 8/20. Reset changed current 8 -> 20, permanent 16.5 unchanged and reserved 1 retained. Both page-owned confirmations checked.
- Frontend backup: `/tmp/one-billing-ui-backup.zGRVJT/main.tsx`; implementation uses the isolated clean release checkout, not the unrelated dirty desktop checkout.

## Release / live verification

Pending at initial commit: GitHub deploy, live health, actual supplier prefix reuse and deployed admin entry. `scripts/probe-context-cache.ts --run-two-public-calls` performs exactly two public synthetic requests against the configured coordinator, SELECTs only model/settings configuration, never reads knowledge or conversation bodies and never writes a customer ledger. Failure stops without automatic retry. Actual savings must be measured on comparable successful real tasks, not inferred from text byte reduction.
