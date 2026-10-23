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

## Second real-model pair — protocol gate NOT passed

Release `cf6aaba`, server log `/tmp/one-adaptive-public-cf6aaba.log`. History recall passed both arms. Adaptive combined search/HTML reached one completed job and an HTML artifact; bound continuation and weather were blocked by immediate native HTTP 400 responses during correction turns. Legacy continuation again returned prose without a queued continuation; legacy combined did not complete the requested single HTML delivery.

Wire-path inspection found that ONE's trailing service `system` correction was moved into Anthropic's top-level system field, leaving the message history ending with assistant prose. Modern native models reject that as unsupported assistant prefill; see [official API errors](https://platform.claude.com/docs/en/api/errors#prefill-not-supported). This is a real compatibility defect in the correction path, not evidence that the model needed less context. The adapter now keeps the trusted system correction and adds a clearly labelled server continuation user turn, without changing human messages, tool-result pairing, grants or stable prefix. A local HTTP regression rejects assistant-final requests and verifies correction -> actual tool -> final answer succeeds.

Some failed calls returned no usage. Their earlier `retailEquivalentMicros` represented only known successful-call usage, NOT the whole attempt cost and NOT proof of zero-charge rejection. The evaluator now emits `usageComplete`, `knownUsageMicros`, and null total equivalent cost when usage is incomplete. These failed pairs are excluded from savings conclusions. Production default remains legacy pending the next complete paired gate.

- Protocol follow-up local verification: 1,036 tests passed, zero failed, one pre-existing opt-in stress test skipped; type-check, build and diff checks passed.

## Third real-model pair — useful gains, but not a blanket cost win

Release `e79d503`, server log `/tmp/one-adaptive-public-e79d503.log`. All eight arms finished with complete reported usage. No native correction HTTP 400 recurred in this sample. Customer ledger writes: zero.

| Case | Legacy calls / equivalent power / pass | Adaptive calls / equivalent power / pass |
| --- | --- | --- |
| Weather | 4 / 0.321235 / no | 3 / 0.051559 / no |
| Earlier requirements | 1 / 0.077294 / yes | 3 / 0.032248 / yes |
| Bound continuation | 4 / 0.129315 / yes | 4 / 0.070088 / yes |
| Search plus HTML | 4 / 0.273163 / yes | 10 / 0.583225 / yes |

Earlier-requirement and bound-continuation totals were respectively 58.3% and 45.8% lower in this one pair. Conversely the adaptive HTML combination cost 113.5% MORE and used six more model calls. Initial context savings therefore do not establish a whole-task saving; keep the production gate off. Both HTML arms generated actual files. These are small, alternating-order, nondeterministic samples, not guaranteed customer savings.

Weather returned durable no-search feedback rather than fabricated verification, but neither arm actually performed the requested read. Follow-up makes explicit self-contained public searches required at the native tool-choice layer (when a weather location is known), preserving query construction, privacy review, source permissions and missing-location clarification. Also clarify that a request not to create a task does not prohibit a requested read-only search. The public fixture now records offered/called tool names and safe synthetic rejection feedback, and can run selected named cases without silently dropping the paired arm. Targeted weather and HTML follow-up must pass before revisiting activation.

- Public-read follow-up local verification: 1,037 tests passed, zero failed, one pre-existing opt-in stress test skipped; type-check/build passed. A regression verifies both context modes actually offer and require the requested search, do not offer delegation, and produce no task card for answer-only weather.

## Focused follow-up findings

- Weather pair on `a4780cb`, `/tmp/one-adaptive-public-a4780cb-weather.log`: both arms still failed the actual callback gate, despite returning weather prose with external-looking citations. Legacy 4 calls / 0.300412 equivalent power; adaptive 3 / 0.059944; usage complete in both. There was no ONE `web_search` invocation, so neither is accepted as a verified search or a successful-task saving. Native `tool_choice` alone is not execution evidence. A native-wire-only search alias is being tested to distinguish ONE's audited client tool from provider-native search handling; this is a compatibility hypothesis, not yet a confirmed supplier root cause. Original handler names, permissions, history pairing and required choice must round-trip unchanged, and alias collisions fail before a request.
- Detailed third-run profiles show adaptive combined round 6 hit exactly 3,000 output tokens with `finishReason=length`, then re-entered the feature. The feature path raised the output ceiling for Word/PPT/Excel structured arguments but omitted HTML/flowchart. These visual tools now receive the same 10,000-token argument ceiling before a file exists, and return to the short acknowledgement ceiling after a verified artifact. This changes a ceiling/reservation, not actual-token pricing; wallet and explicit task limits still apply. Local real-artifact tests check the long first call and short post-save acknowledgement.
- Known orchestration stops (including a clipped tool instruction and exhausted step count) now also leave an owner-scoped durable conversational next step in both modes. Unknown exceptions and permission revocation are not disguised as successful operations. Already-committed child tasks retain their original receipt instead of being submitted twice. Local verification after this guard: 1,038 passed, zero failed, one pre-existing opt-in stress test skipped; type-check/build passed.
- Latest zero-provider input capture on the current answer-only fixture: legacy 54,707 bytes (system 52,562 / messages 729 / tools 1,416), adaptive 8,620 (system 6,349 / messages 548 / tools 1,723), 84.2% smaller overall with 30 versus zero unrelated task snippets. Tool-schema bytes alone are NOT smaller in this answer-only case. This is the current same-code pair; do not silently substitute it for the original pre-change 58,686-byte capture or claim byte savings are real billing savings.

## Fourth complete pair — search fixed, workflow gate still failed

Release `a7bf258`, server log `/tmp/one-adaptive-public-a7bf258.log`. Weather now actually invoked ONE's search handler exactly once in each arm after the native-wire name isolation; both finished in two model calls. The previous weather prose was not a substitute for this callback. This before/after supports the adapter change, but does not prove that every historical supplier failure had the same cause.

| Case | Legacy calls / equivalent power / pass | Adaptive calls / equivalent power / pass |
| --- | --- | --- |
| Weather | 2 / 0.081948 / yes | 2 / 0.020747 / yes |
| Earlier requirements | 1 / 0.077309 / yes | 2 / 0.024904 / yes |
| Bound continuation | 4 / 0.171287 / no | 4 / 0.072168 / no |
| Search plus HTML | 10 / unknown / no | 8 / unknown / no |

Both continuation arms unnecessarily added a file-save/read-back prerequisite to an original text-only arrangement whose no-overwrite rule was only a restriction. Both workers then stopped because no file tool was offered. This is not evidence that short history lost the requirements: both handoffs retained 42 people, 900 budget and the restriction, but expanded it into unnecessary work. The shared execution framework now explicitly distinguishes text delivery from a file-save request; requested real files still require the actual artifact/read-back.

The adaptive combined arm queued twice during paid acknowledgement/planning turns, and a generic worker again attempted an overlong feature handoff before the feature's own model could run. Both combined totals are unknown (not zero) because some calls lacked usage. No successful-task cost comparison is made for these arms.

Follow-up adaptive-only fast paths:

- Once a real dispatch receipt exists and required reads have completed, finish with the trusted receipt, without a paid acknowledgement round. Additional delegation in that request is rejected; multiple deliverables must be committed in the initial batch. Tool discovery/history reads before commitment remain progressive.
- For a fresh, self-contained job with exactly one mandatory reviewed chat feature, its own model and SOP execute directly through the same feature checkpoint, authorization and billing handler. No generic model rewrites its handoff or paraphrases its result. Historical tasks, files, dependencies, knowledge, Notion and custom agents retain normal worker planning. No synthetic provider usage is created for this deterministic routing.
- The follow-up evaluator now uses production caller/model deadlines instead of a test-only 60-second limit, and waits up to 360 seconds for a worker instead of 180. Both paired arms receive the same deadlines. This timing change is disclosed; do not silently pool the runs as one frozen experiment.
- Local gate after these changes: 1,040 passed, zero failed, one pre-existing opt-in stress test skipped; type-check/build passed. Tests include a completed text-only continuation with no artifact and a real saved HTML using one coordinator call plus two feature calls, zero generic-worker model calls, one task and three actual usage records.
