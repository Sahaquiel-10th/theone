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

## Live acceptance

- Production `eec3aa7` passed all workflow jobs; `/api/health` returned `ok: true`.
- Submitted only `QA1017同任务双功能`, using synthetic morning-routine text, no knowledge bodies, image generation or local executor. One deliverable was created (`cnv_fd84a90c2823cae09818`), not one task per tool.
- Observed intermediate feedback retaining the completed flowchart while the HTML feature was still working. Both private artifact cards subsequently returned (`att_aaeedb538b6f11bebf2b`, `att_4e072c319816da1951e4`). Opened both, switched scenes, expanded steps, and opened the full flowchart. Chrome confirmed HTML (11.2 KB) and flowchart PNG (159 KB) downloads completed.
- Completion stayed on the task note until a read-only follow-up. That reply carried the completed task link and removed the reported note, without creating or rerunning work. No earlier business/test task was retried.
- Found a genuine final-mile defect: the artifact cards opened, but model-written text links were empty/unsupported and navigated to the homepage. Added private result URLs at the visual tool, feature-to-worker handoff and result/read-task context boundaries; empty or stripped Markdown links now render as plain text. Exact owner/task/ready-file checks precede file-link projection. Regression tests cover two actual feature artifacts and foreign owner/task exclusion.
- Failure recovery, billing and dependency cases above were automated checks; this live case did not simulate provider failure or independently inspect production billing-ledger records. It is not evidence that every supplier/model path is reliable.
