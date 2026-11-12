---
name: plan-status-page
description: Generate project approval and status HTML pages from AgentGlim approval data.
---

Use node skills/plan-status-page/page.mjs build PROJECT_DIRECTORY. It preserves hand-authored pages and adds a report link to the project index. The root and port come from app settings. The generator escapes source text and makes no model or network calls. Never infer approvals or mark work complete without evidence.
