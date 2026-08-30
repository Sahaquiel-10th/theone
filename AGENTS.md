# ONE repository guide

## Product

ONE is a multi-tenant personal AI workspace launched through ONE Key. The fast MVP proves one narrow loop: ONE Key login, one-time authorization of an existing knowledge-platform account, real-time knowledge retrieval, and AI answers grounded in that retrieved context.

GetNote is the first Knowledge Connector, not the permanent product center. Customers without an eligible GetNote membership are provisioned manually outside the application for V0.1.

## Current scope

- Keep chat, attachments, model gateway, web search and the minimum operations surface needed by the MVP.
- Use 得到大脑 as the only implemented Knowledge Connector in V0.1 and use account-wide semantic search.
- Do not copy or synchronize third-party knowledge into ONE in V0.1; retrieve it on demand.
- Build ONE Key device challenge, one-time browser login and revocation before Source/Memory/View work.
- Do not add Bailian, DingTalk, Wanliniu, Alipay, employee surveillance, enterprise data-query features, or additional knowledge providers.
- Do not prioritize a document editor, GraphRAG, native knowledge store, Credits or agent marketplace before the MVP Key → Connector → AI loop works.
- Provider names and credentials must not leak into general business logic or the browser.

## Architecture rules

- Every user-owned record must carry `workspaceId` and every request must authorize it server-side.
- Never trust a `workspaceId` supplied by the browser without membership verification.
- Knowledge access goes through `KnowledgeProvider`; the chat route must not call GetNote HTTP endpoints directly.
- Device challenges and login codes must be short-lived, single-use and resistant to replay.
- An ordinary USB credential is a prototype security boundary; never claim secure-element-level anti-copy protection.
- Provider failures may degrade to no-knowledge mode but must never fall back to another workspace's connection.
- Third-party credentials are encrypted at rest and never returned by APIs or written to logs.
- Database migrations are append-only once shared.
- Keep the application a modular monolith until scale proves otherwise.

## Commands

```bash
npm install
npm run dev
npm run build
npm test
```

If global npm is unavailable in Codex Desktop, load the bundled workspace dependencies and execute the local TypeScript/Vite binaries with the bundled Node runtime.

## Required checks

- TypeScript type-check.
- Unit and integration tests relevant to the change.
- Cross-workspace isolation tests for every new data path.
- Production build.
- `git diff --check`.

## Security red lines

- No production secrets or fallback admin passwords in source.
- No model/GetNote credentials in client bundles, URLs, logs, or API responses.
- No public object-storage paths for private files.
- No admin access to personal conversation content unless a separately approved support workflow is introduced.
- No knowledge retrieval without an exact authorized workspace binding.

## Project documents

- `docs/PRODUCT.md`
- `docs/ARCHITECTURE.md`
- `docs/DATA_MODEL.md`
- `docs/API.md`
- `docs/ONE-PROJECT-EXECUTION-CHECKLIST.md`
