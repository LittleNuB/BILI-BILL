---
name: bili-bill-acceptance
description: Run an approved Bili-Bill developer acceptance plan against selected video material, inspect raw model results, grade and export a local report through the bundled CLI or acceptance MCP.
---

Use the installed package's `Guide.html` and `README.md` to resolve its exact extension ID, local tools and plan. This is separate from the knowledge-library MCP; do not request its writeback permissions.

Before execution, establish the user's authorization for this package's local host installation, selected video/P/material scope and new paid call count. If already authorized, continue without repeated prompts. The developer page approves the frozen plan and yields a 30-minute pairing code. Never bypass that page by setting extension storage or calling its approval action from an agent script.

Use `acceptance_status`, then `acceptance_capture` for each approved target. The user must have enabled original-audio AI captions on the video page. Missing subtitles stop video conclusions. Read frozen material with `acceptance_read_report` as needed; carry the first chunk's hash through later chunks. Captions can misrecognize facts. Images contain only the actual sampled frame and separately labelled nearby narration.

Execute each fixed step with `acceptance_run_step`. The bundled CLI `run-plan` runs the same core and exports automatically when MCP integration is unavailable. Do not start an extra model/automatic grading provider. Duplicate step commands read an existing attempt, not a retry. Authentication, unknown usage, budget or disconnect stops must be investigated before continuing. Never clear a ledger or create a new profile to bypass them. New regression attempts require a distinct plan version and the corresponding call authorization.

After investigating a network failure, a user may explicitly authorize a finite retry while its usage remains unknown. Only a new fixed plan with exact `retainedUnknown` charge IDs and original reservations may proceed, after manual acknowledgement on the developer page. Keep the prior failed attempt, unknown usage and full reservation unchanged in both ledgers; each new request reserves additional budget. A new unknown charge pauses again. This does not waive authentication, running-request, storage, conflict or budget stops. Do not invent provider usage, settle unknown as zero, auto-acknowledge the page or silently expand the plan.

Review each actual answer against the material and its limits. Use five scores (correctness, source honesty, task completion, readability, concision), each 0–2. Pass requires successful generation, program checks, correct required facts, no severe failure and total>=8. False citations/time points, changed key numbers/negation or claims of seeing absent image details are severe. Empty answers are generation failures, not evidence of dishonesty. Attribute review to the current Codex; do not label it independent human or blind review.

Record findings with `acceptance_grade`, including concrete evidence and cause (prompt/model/transport/parser). Preserve the raw text even when checks fail. Use `acceptance_export_report` to create a new local output directory. Do not upload frozen material, answers or configuration to GitHub by default.

Report four evidence categories separately: mock, installed extension without network, real materials/model, real-site UI. Background success does not verify captions controls, part switching, visual behavior or conversation save/restore. Check those in the explicitly approved page using an available browser tool or an isolated test browser; never attach to a personal browser with an unauthorized CDP workaround. Fix observed defects, then propose the smallest budgeted regression plan.
