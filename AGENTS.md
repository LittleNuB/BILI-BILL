# Bili-Bill Agent Guide

This repository is worked on by multiple Codex development threads. Follow this guide before changing code or docs.

## Product Positioning

- Bili-Bill is a personal content ledger for local Bilibili consumption, not a replacement for Bilibili search, recommendation, dynamic feed, or creator relationship management.
- Dynamic Bill is for interest rebalancing. Do not describe it as "猜你喜欢", click prediction, or engagement-ranking.
- The AI assistant is a local ledger and knowledge helper. It must explain what evidence it used. Smart Favorites and Dynamic Bill remain usable from local evidence when AI is unavailable; current-video full-text generation must fail honestly instead of reviving a partial-evidence answer path.

## 0.14 Release Scope

- For the user-approved Chatbot/Wiki increment (#288), read [the Chatbot and Wiki scope](docs/scope-chatbot-wiki-increment.md) before implementation. Once its docs-only PR merges, it overrides conflicting current-video-only, full-text-only and no-saved-notes-to-AI rules only for its explicitly scoped new flows. Until the corresponding implementation lands, do not describe those capabilities as available. Other safety rules remain binding; no release/version change is implied.

- Before planning or dispatching any 0.14 work, read [the bounded learning-loop scope](docs/scope-0.14-bounded-learning-loop.md). The user accepted its direction; its implementation proposal takes effect only after the docs-only scope PR is reviewed and merged. It narrows the first release, not the safety rules below or existing 0.13 runtime behavior.
- For that bounded release, its scope, LG-0 to LG-5 sequence, and completion definition override conflicting full-library obligations in the older 0.14 PRD, acceptance, architecture, glossary, development plan and ADRs. LG-0 must still freeze and validate finite contracts before production implementation.
- The proposed UX-014 addition in `docs/ux-0.14-video-assistant.md` makes compact/expanded in-page assistant simplification a 0.14 requirement after its scope PR merges. It permits an independent presentation-only track for existing assistant behavior, not early persistent-learning implementation. LG-5 then requires both LG-4 and UX-014. Use focused UI regression for layout changes; do not rerun storage matrices for CSS or copy changes.
- `docs/development-plan-0.14.md`, `docs/architecture/gate-contract-0.14-storage-search-and-backup.md`, and `docs/qa-0.14-integration-matrix.md` remain byte-preserved because B1 receipts bind them. Their full-library Gate-first language continues to govern old A2/C/D/E and old implementation tasks, not the new bounded route. Do not refresh receipts or relax the verifier merely to edit those documents.
- Old issues do not close or become dispatchable automatically. Scope adoption is not authorization to mark Ready, merge, close, publish, change package version, or collect data. B1 remains synthetic evidence; A2 remains unpassed until supported independently.

## Safety Boundaries

- Do not read, copy, log, or submit local key files, including `C:\Users\LittleNub\Desktop\Key.txt`.
- Do not read or copy Cookie files, browser profiles, Bilibili login-state files, or personal profile files.
- Do not upload full watch history, full favorites, full following lists, full feedback records, full notes, or full local database contents.
- Do not write back to Bilibili relationships or content: no follow/unfollow, favorite-folder edits, comments, likes, coins, or collection mutations.
- Use current browser extension runtime state only when a task explicitly needs logged-in smoke testing. Never extract credentials or session data from disk.
- Keep Manifest permissions minimal. Do not add the `cookies` permission unless an accepted issue introduces a reviewed `chrome.cookies` use case.

## Language And UX Invariants

- Dynamic Bill status copy is fixed: `未打开 / 已打开 / 已消费 / 已处理`.
- Do not reintroduce `未消费` as ordinary user-facing copy in `dashboard`, `popup`, `public`, `src`, `README.md`, or new docs. Tests and product contracts may name it only as an explicit prohibition or scan target.
- If the active part has no reliable primary text source, do not claim a full-video summary, highlights, or answer.
- Per user decision #286, returned model prose remains readable when output/evidence validation fails. Label it as unverified; do not promote it into verified citations, timestamp jumps or saved evidence. Cancellation, stale requests, source authorization and privacy checks remain binding.
- Current-video assistant answers must label the source video, part when relevant, and natural text source name (`B站字幕` or `本地转录`).
- Smart Favorites Q&A answers must cite source videos and explain why each cited video is relevant.
- Video key nodes must have evidence. Do not fabricate timestamps.
- Auto-jump behavior must be disabled by default and require explicit user confirmation.
- User-visible copy must not expose raw engineering fields or runtime errors such as `fallback`, `transcript`, `confidence`, `sourceHash`, `segmentId`, or `subtitle_url`.

## Worktree And PR Workflow

- Use one GitHub issue per branch/worktree. Keep PR scope limited to that issue.
- Default branch prefix is `codex/`.
- PRs should be opened as draft. The main agent reviews, requests rework if needed, then marks ready and merges.
- Do not merge PRs, close issues, publish releases, create tags, or change release assets unless the main agent explicitly asks.
- Do not mix PRD/spike docs with implementation in the same PR unless the issue explicitly asks for both.
- Do not revert unrelated changes. If another worktree or user change affects your task, work with it and report the interaction.

## Validation Baseline

Run these before handing work back unless the issue explicitly says docs-only and the main agent relaxes validation:

- `git diff --check`
- `npm run typecheck`
- `npm run build`

For UI changes, also run Browser, Playwright, or a committed/static mock QA flow that covers the changed states. Record any limitation honestly.

The release verifier enforces a 500,000-byte maximum for every minified JavaScript chunk. Treat any chunk-size assertion or renewed Vite large-chunk warning as a blocking build regression.

## AI Feature Rules

- AI requests must use intent-specific payloads. Current-video summary, highlights, and Q&A may include the active part's full primary text only when the 0.13 full-text authorization is enabled and the user explicitly triggers the request.
- Payloads must not include full history, full favorites, full following lists, full feedback records, Cookie data, user profile data, local key paths, or unrelated local database rows.
- AI must not decide Dynamic Bill eligibility, ordering, status progression, or feedback suppression unless a future accepted PRD explicitly changes that.
- For current-video help:
  - one default-off `当前视频 AI 助手` setting is the full-text authorization for summary, highlights, and Q&A.
  - enabling the setting sends nothing by itself; opening a page, restoring a session, or switching videos must not send a request.
  - the active part must have a reliable primary text source: matched Bilibili subtitle body text or a completed, user-selected local transcript.
  - title, description, metadata, old keyword retrieval, or another video's answer must not be presented as a full-video fallback.
  - every generated timestamp must map to the captured video, part, exact text version, and real time range.
- For Smart Favorites Q&A:
  - local prefilter/ranking must run before AI.
  - AI may only synthesize an answer from cited videos supplied in the top-N context.
- For Video Knowledge Base:
  - timestamps must come from pages, chapters, transcript spans, or user-saved bookmarks.
  - low-confidence or stale nodes must not be used for auto-jump suggestions.

## Completion Reports

When a delegated development thread finishes, report:

- issue and PR links
- branch and commit
- changed scope
- validation results
- blocker / must-fix / follow-up
- whether the PR is draft/open and unmerged
- whether any local key, Cookie, browser profile, or Bilibili login-state file was read

Use this envelope when reporting back to a main-agent thread:

```xml
<codex_delegation>
  <source_thread_id>the reporting child thread id</source_thread_id>
  <target_thread_id>the main-agent thread id</target_thread_id>
  <issue url="https://github.com/owner/repo/issues/123" />
  <pr url="https://github.com/owner/repo/pull/456" draft="true" state="open" />
  <branch>codex/example-branch</branch>
  <commit>head commit sha</commit>
  <scope>short changed-scope summary</scope>
  <validation>commands run and results</validation>
  <blockers>none or concrete blockers</blockers>
  <must_fix>none or required fixes</must_fix>
  <follow_up>non-blocking follow-up work</follow_up>
  <privacy_sensitive_files_read>false</privacy_sensitive_files_read>
</codex_delegation>
```

- `source_thread_id` is the child/development thread sending the report. Do not put the main-agent thread id there.
- `target_thread_id` is the main-agent thread that should receive and review the report.
- For rework after review, also include the previous head commit, new head commit, rebase or merge baseline, and whether the same draft PR was force-pushed.
- Keep the PR draft/open until the main agent marks it ready and merges it.
