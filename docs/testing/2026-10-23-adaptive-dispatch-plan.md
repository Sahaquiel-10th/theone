# Adaptive coordinator: implementation and paired acceptance plan

## Objective and baseline

Resolve the user-visible Lao Xu / Simple incident patterns: funded requests blocked before dispatch, paid orchestration without useful progress, and irrelevant context inflating calls. Preserve full user requirements, workspace isolation, explicit budgets, uncertain-write protection and actual-use billing. No real customer compensation, price changes or replay of their original tasks is included.

Baseline: application behavior at commit `51ad5ee` (including the already-deployed billing fixes). Preserve this behavior behind a trusted server-side evaluation/rollback switch; never accept the mode or tool grants from model/browser arguments. Do not compare against a deliberately broken pre-fix release.

## Stages

1. Before functional changes, capture deterministic baseline inputs, calls, outcomes and assertions using isolated synthetic fixtures. Keep identical long histories, task candidates, configured tools and latest requests for both arms.
2. Replace broad initial context with complete latest input, recent complete exchanges, compact task references and an explicit bounded context-reading tool. The current task's original requirements remain retrievable, not silently summarized away. No extra classification model.
3. Add intent-aware initial tool exposure plus explicit on-demand loading of already-authorized tools. Discovery cannot grant access. Complex combined requests and ambiguous references must have a path to broaden beyond the initial shortlist.
4. Guard repeated no-progress reads, preserve step results and fail clearly when the bounded loop cannot finish. Keep worker/wallet limits and cancellation checks; do not restore a hidden monetary route limit.
5. Run deterministic paired regression and cost-profile measurements, then real-model paired synthetic acceptance with frozen model/prices and deterministic search fixtures. Real provider runs must use only synthetic/public data and an isolated in-memory ledger; private knowledge, original customer tasks and balances stay untouched.
6. Full test suite, type-check/build, diff check, deploy and verify live health. Enable the new default only after the acceptance gate; otherwise retain legacy behavior and report why.

## Paired cases

| Case | Expected behavior / evidence |
| --- | --- |
| Weather amid unrelated old tasks | Search and answer; no images/local tasks/knowledge reads, no new task card. |
| “Do the plan above” beyond initial window | Read the exact relevant historical messages; preserve numbers and a no-overwrite constraint; actually dispatch once. |
| Continue a bound task | Preserve original task identity and constraints; reuse prior results, no unrelated work or duplicate external write. |
| Weather plus HTML deliverable | Combine the necessary capabilities; retain a real artifact, not only a promise; no image generation unless requested. |
| Funded but former implicit route ceiling exceeded | Continue under wallet/explicit budget rules; do not report insufficient account power. |
| Disabled executor / malformed or unavailable tool | Correct safely or stop with a durable, actionable response; no identical invalid-call loop. |
| Cross-workspace / cancellation / malicious reference | No foreign history, tasks, tools or writes; fresh authorization before every read/action. |

## Measurements and decision rule

- Record initial and cumulative system/message/tool bytes separately, actual provider tokens/cache buckets, model calls, tool calls, end-to-end time, actual billing-equivalent power and artifacts. Bytes are not tokens or cost; synthetic cache savings are not total task savings.
- Compare total completed-task cost, not just first-call context. Account for any extra history/discovery rounds. Alternate real-model arm ordering where feasible and disclose small sample / cold-warm effects.
- Hard gate: zero new authorization, requirement-loss, false-completion or duplicate-write failures in the defined cases. New behavior must not reduce completion in representative fixtures.
- Cost gate: clearly reduce irrelevant initial context; report paired total cost honestly. If retrieval rounds erase savings or harm quality, retain or narrow the old fast path rather than declaring success.
- Track remaining gaps separately from “implemented”, “locally tested”, “real-model verified” and “deployed”.

## Status

- Plan and deterministic baseline captured before functional edits. Case: complete weather question in a synthetic account with 30 unrelated tasks and 24 historical messages. Legacy initial input: system 52,099 bytes, messages 729, tool schemas 5,858, total 58,686; all 30 unrelated task input snippets present. This capture used a fake model callback, no supplier requests or customer ledger.
- Initial implementation is opt-in via trusted service dependency; production default remains unchanged pending the paired acceptance gate. The legacy arm still reproduces all baseline byte counts exactly.
- Local implementation verification: 1,030 tests passed, zero failed, one existing opt-in stress test skipped; type-check, production build and diff checks passed. Adaptive-only tests cover the paired weather path, on-demand historical constraints, bound task inspection, explicit long-original pagination before continuation, late-message isolation, foreign task denial, revoked Key, controlled tool loading and repeated-read stopping.
- Adaptive initial capture on the same baseline fixture: system 6,826 bytes, messages 548, tool schemas 1,723, total 9,097; zero unrelated task snippets. This is an 84.5% initial-byte reduction, not a cost reduction claim. The scripted full weather pair still uses exactly two model rounds and one search in each arm.
- Production selection is server-only `ONE_COORDINATOR_CONTEXT_MODE=adaptive`; absent/other values retain legacy. The real-model script uses isolated fixture stores and deterministic public synthetic weather data; freezes the selected model/prices, alternates arm order, records all model/tool calls and real artifact read-back, and never alters customer balances. One pair per case is a small-sample acceptance check, not statistical proof or a real-weather-provider reliability test.

## First real-model exploratory pair — gate NOT passed

Release `8b7f65a`, log `/tmp/one-adaptive-public-8b7f65a.log` on the server. All eight arms ran with the same selected native model and synthetic fixture stores. Customer ledger writes: zero. This exploratory run did not justify enabling adaptive mode.

| Case | Legacy calls / equivalent power / pass | Adaptive calls / equivalent power / pass |
| --- | --- | --- |
| Weather | 1 / 0.077939 / no | 1 / 0.015516 / no |
| Earlier requirements | 1 / 0.076773 / yes | 2 / 0.026346 / yes |
| Bound continuation | 2 / 0.181565 / no | 2 / 0.041501 / no |
| Search plus HTML | 9 / 0.884454 / no | 5 / 0.232392 / no |

Findings: weather prose appeared without a real search when profile city was absent, despite the latest request naming Hangzhou. Bound continuation returned prose without actually queueing continuation. The combined legacy arm completed a DOCX rather than HTML; the adaptive arm stopped on incomplete tool parameters. The first evaluation wrapper also imposed 3,000 output tokens on every call, which did not match production feature/worker output settings; this limitation is removed for the formal follow-up, and both arms will receive the same explicit Hangzhou fixture preference. These condition changes must be disclosed; do not compare follow-up costs directly to this first run as a release savings figure.

Follow-up implementation adds an adaptive real-delivery gate (with useful clarification exempted), preserves the bound-task read requirement, requires an actual HTML-capable feature for explicit HTML output, and prevents unsearched latest-fact prose from being presented as verified. Legacy behavior remains the comparison path. Fresh full-suite/build and a new paired run are required before activation.

- Follow-up local gate: 1,035 tests passed, zero failed, one existing opt-in stress test skipped; type-check/build/diff checks passed. Added funded-above-0.5 / explicit-cap regressions, disabled executor repeated-attempt stopping, prose-versus-actual-delivery and HTML-format guards, and an explicit-city weather case without profile city. The repeated-error guard now includes handler-level repair errors, not only JSON/schema errors; successful new information allows a repaired attempt, while identical no-progress attempts stop.
- Formal follow-up fixture changes apply equally to both arms: a known Hangzhou city preference, the production caller's output limits (no blanket 3,000-token test cap), and an explicit 10-power isolated worker allowance to avoid confusing the pre-existing worker budget with routing quality. This is not a customer budget or pricing change.
