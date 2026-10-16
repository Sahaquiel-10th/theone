# Reviewed design reference

`frontend-design/` comes from `anthropics/skills`, commit
`dbd4588f9e1033efb41dad4bef2f7947c8993d44`, path `skills/frontend-design`.
It is Apache-2.0 licensed; the upstream `LICENSE.txt` is included unchanged.
Source: https://github.com/anthropics/skills/tree/dbd4588f9e1033efb41dad4bef2f7947c8993d44/skills/frontend-design

This is an offline design reference, not a user-facing script or a runtime
instruction download. ONE's cream/olive palette and quiet interaction style
take precedence. Model output cannot supply scripts, CSS or raw HTML. The
reviewed runtime implements accessible controls with a hashed CSP.

Other diagram references investigated:
- Mermaid (MIT): https://github.com/mermaid-js/mermaid
- visual-explainer (MIT): https://github.com/nicobailon/visual-explainer

Neither is installed or executed here. They demonstrate whole-diagram and
interactive-document approaches; ONE's first edition intentionally accepts a
small scene schema rather than arbitrary diagram syntax or CDN scripts.
