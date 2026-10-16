---
name: one-visual-explanation
description: Turn authorized material into a complete workflow diagram and a useful interactive guide.
---

# ONE visual explanation

Use for instructions, guides, plans and multi-step explanations. Do not turn a
simple question into a document without a reason. Never create fake evidence.

1. Identify the reader, situation, desired result and authorized material.
2. Outline distinct scenes. For each, connect the actual feature to an advantage,
   a practical benefit and a way the reader can verify it (FABE, without jargon).
3. Remove repeated slogans and meta explanations. Use concrete nouns/actions.
4. Call `oneFlowchart` for a whole scalable flow, `oneHtml` for an interactive
   guide, or both. Both take the reviewed `VisualDocument` structure defined in
   `server/visualDocument.ts`; no model-authored executable markup is accepted.
5. Review the resulting artifact: no clipped text, clear arrows, readable type,
   full-diagram zoom, keyboard focus, reduced motion, mobile layout and offline
   export. A file receipt, not a model promise, is the completion evidence.

The welcome flow first invokes `oneManual` using the prompt in
`server/welcomeManualPrompts.ts`, persists its validated result, then calls the
image model with that result. Its HTML and SVG use the same rendering functions
as the normal feature tools. Authorized capabilities are server-resolved; no
knowledge body, local files, credentials or chat history are read for setup.

Design palette: cream paper #f4f2e9, ink #27392d, olive #46623c, pale leaf
#e6ebdc, amber focus #8b592f. System Chinese typography; large editorial title,
comfortable body copy, quiet metadata. Main image gets the full content width;
details and scenario switching belong below it. Motion only follows user input.
No constructed cat icon: the black/white cow cat belongs in the actual artwork.
