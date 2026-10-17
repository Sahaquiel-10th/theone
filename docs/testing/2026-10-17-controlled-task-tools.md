# Controlled task/tool execution — 2026-10-17

## Contract

- Sticky notes represent independently followable deliverables, not individual function calls.
- The coordinator selects a published executor and optional entitled features. `delegate_tasks.featureIds` declares the selected features required for that scoped deliverable; inherited/available features remain optional. `requiredTools` can require real operations. `knowledge` selects the authorized search scope, never grants access.
- The executor may compose reviewed tools within its scope. Each feature is invoked once per deliverable; repeated calls reuse its completed result. Independent features can proceed after a recoverable feature failure. Fresh authorization and cancellation failures still abort immediately.
- Model-free execution is a reviewed whitelist, initially `oneHtml` and `oneFlowchart` with validated `VisualDocument` content and an entitled feature. It does not permit arbitrary scripts, external writes, or computer access. Other semantic/creative tasks use the selected execution model.
- Explicitly named knowledge sources must really be queried. Exhaustive search covers the currently authorized selection, with separate used/no-match/failed/unavailable receipts. Transient read failures can retry twice; authorization failures cannot. Search failure is never evidence that knowledge does not exist.

## Recovery and safety

- Private task-scoped checkpoints persist each step before invocation and preserve successful outputs. Retries reuse successful features/artifacts and original scope, and spend from the original batch budget. No failed request is silently given a new budget.
- Unknown artifact/external-write outcomes stop for review instead of replaying side effects. Restored files must still belong to the same owner and task and exist on disk.
- Failed prerequisites leave successors waiting. Only explicit retries of the same owned task can replace a prerequisite. On recovery, successors consume the retry's actual output. Unrelated work continues. User cancellation stops successors; it is not an automatic retry signal.
- Source/feature/credential authorization is rechecked before reusing predecessor output and before every tool/model boundary. Neither another workspace nor a different conversation can satisfy a predecessor by supplying a matching ID.
- ONE rewrites partial progress from server facts. It must say what is actually retained, what is still missing, and how to continue. No invented percentage or “mostly finished.” Reporting is budgeted, has a short timeout, and falls back to a plain-language factual message. Internal checkpoints and raw provider exceptions are not public task payloads.
- Completion announcements retain the existing quiet inbox contract: incomplete tasks stay on their notes; completed results are carried with the next coordinator reply, not unsolicited chat spam.

## Verification

Automated cases include multi-feature partial preservation and charged-once retry, uncertain-write replay protection, mandatory-tool evidence, no-model private HTML delivery, dependency recovery, cancellation, cross-owner/cross-conversation isolation, revoked-source reuse denial, exhaustive knowledge receipts, bounded read retry, reporting truthfulness, and the existing billing/Notion/local-execution suites.

No production prices or launcher runtime versions are changed by this update. Live acceptance uses independent synthetic tasks; it must not rerun a previous user task.
