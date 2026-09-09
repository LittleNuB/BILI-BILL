# Bili-Bill

## Release Scope Notice

The user-approved [Chatbot/Wiki increment](docs/scope-chatbot-wiki-increment.md) (#288) adds natural multi-turn learning, bounded context management, explicitly authorized saved-knowledge retrieval and user-confirmed Wiki updates. Its scope PR must merge before implementation. It supersedes only the conflicting AI restrictions listed in that document, not existing data-protection contracts. These are planned capabilities, not evidence of release completion.

The user has accepted a bounded first learning loop. See [0.14.0 bounded scope](docs/scope-0.14-bounded-learning-loop.md) for the proposed release boundary, precedence, and activation on scope-PR merge. Full-library glossary terms below remain domain vocabulary, not evidence of shipped capability. In the bounded release, saving knowledge does not promote complete subtitles, source-account migration is deferred, and saved-content search is not full-video-text search. Existing 0.13 runtime behavior is unchanged by this docs-only proposal.

Bili-Bill is the product context for a user-owned Bilibili content ledger. It gives the project one shared language for content consumption, saved content, and upcoming content decisions.

## Language

**Bili-Bill**:
The canonical product name for the whole browser extension. It frames the product as a personal Bilibili content ledger rather than only a data visualization plugin.
_Avoid_: BiliBili DataViz Plugin, B站消费数据中心, AI 关注收件箱 as the product name

**动态账单**:
The user-facing name for the evidence-guided pre-consumption view of updates from followed Bilibili accounts. Local rules make it usable on their own, while AI may optionally add summaries and explanations.
_Avoid_: AI 关注收件箱, 关注页优化, 动态页增强

**视频投稿动态**:
A followed-account update whose primary content is a Bilibili video submission. It is the only dynamic content type covered by the first version of 动态账单.
_Avoid_: 图文动态, 转发动态, 直播提醒, 专栏, 番剧追番提醒 for version one

**兴趣再平衡**:
The core purpose of 动态账单: helping users notice followed content that has fallen out of their recent consumption pattern. It is not an engagement-ranking system that predicts the videos a user is most likely to click.
_Avoid_: 猜你喜欢, 优先级排序, AI 推荐流

**账单栏目**:
A user-facing section in 动态账单 that explains a specific reason to reconsider a followed video submission. Each column should describe a rebalancing reason, not merely a content category.
_Avoid_: 标签分类, 普通分组, 推荐分区

**账单项**:
An item shown inside 动态账单 that represents one followed creator through that creator's newest unwatched submission in the current update window. A creator appears at most once in each generated bill.
_Avoid_: Repeating one creator across columns, creator-only entries without an actionable submission

**未打开**:
A 账单项 state meaning the user has not opened the surfaced new video from 动态账单.
_Avoid_: 未消费 when the item has never been opened

**已打开**:
A 账单项 state meaning the user opened the surfaced new video from 动态账单, but Bili-Bill has not confirmed meaningful viewing.
_Avoid_: Treating an opened video as consumed

**已消费**:
A 账单项 state meaning Bili-Bill has confirmed meaningful viewing through local watch history or player events.
_Avoid_: User clicked the link once

**已处理**:
A 账单项 state meaning the user manually dismissed or completed the bill item without requiring confirmed viewing.
_Avoid_: Equating manual handling with confirmed consumption

**负反馈**:
A local user signal created by “少提醒这个 UP”. It marks the current 账单项 已处理 and pauses that creator from every 动态账单 column for 30 days. The pause can be undone immediately or restored from Settings, expires automatically, and never changes the user's Bilibili follow relationship. Repeated signals may support a low-pressure 取关提示.
_Avoid_: permanent hidden ranking penalties, Training data upload, writing back to Bilibili, platform-wide 不感兴趣, changing the follow relationship

**取关提示**:
A one-time, low-pressure suggestion shown when the user completes “少提醒这个 UP” for the same creator for the third time. An immediately undone action does not count. The suggestion only offers opening the creator's Bilibili page or dismissing the prompt; it neither changes the current 30-day pause nor modifies the follow relationship. Its minimal local count and shown state are removed with all local data.
_Avoid_: repeated prompts, counting immediately undone actions, Automatic unfollow, modifying Bilibili follow relationships

**被淹没的关注**:
A 动态账单 column for new video submissions from creators with a durable 关注关系 that is absent or nearly absent from available recent consumption. It requires at least one credible 关注记忆证据 but does not require strong historical viewing engagement.
_Avoid_: All low-frequency creators, unvalidated followed accounts, long-history-only column

**收藏关联更新**:
A 动态账单 column for new submissions from followed creators whose earlier work appears in the user's locally synced Bilibili video favorites. Smart-favorite organization may explain the relationship but is not a separate source or an eligibility requirement.
_Avoid_: 冷门收藏, 收藏延伸推荐, treating every favorite as a ranking score

**关注轮换**:
A 动态账单 column that broadens coverage across the remaining recent submissions from followed creators after stronger rebalancing reasons are applied. It is a transparent breadth rotation, not engagement prediction or recommendation ranking.
_Avoid_: 猜你喜欢, 随机探索, click-probability ranking

**轮换记录**:
The minimal local memory of when a followed creator last appeared anywhere in 动态账单, used by every column to show unseen or least-recently-surfaced creators first. It is not viewing history, consumption evidence, or an interest score.
_Avoid_: 推荐画像, watched-creator history, engagement ranking signal

**关注关系**:
The user's relationship to a Bilibili creator account they follow. It is distinct from historical consumption, because a user can follow a creator for a long time without recently watching them.
_Avoid_: Treating watched creators and followed creators as the same set

**关注记忆证据**:
A fact showing that a 关注关系 has durable meaning beyond a current follow snapshot: known follow age, special-follow status, at least 30 days of continuous local observation, or a real local watch before the recent window. It supports 被淹没的关注 without becoming an interest score.
_Avoid_: Any current follow, inferred follow age, recommendation weight

**已关注时间**:
The age of a 关注关系, used as a taste-memory signal for 动态账单. It can support long-term taste explanations but should not by itself prove current interest.
_Avoid_: Viewing age, creator age, account age

**长期观看窗口**:
The intended 180-day watch-history window that may strengthen evidence when actual local coverage supports it. It is not a prerequisite for fixed product surfaces and never justifies claims beyond the history actually available.
_Avoid_: Lifetime history, treating all available recent history as a durable-interest window, feature unlock gate

**近期观看窗口**:
The default 30-day watch-history window used to identify the user's current consumption pattern.
_Avoid_: Treating the current week alone as recent taste

**可用证据策略**:
The unified rule that every surface keeps a stable user-facing structure and makes only claims supported by the evidence currently available. Longer history may reduce repetition, broaden coverage, or support factual time-range explanations, but it never unlocks or replaces surfaces or creates a positive recommendation score.
_Avoid_: 短历史模式, 标准模式, user-selected history mode, labeling seven-day behavior as durable interest

**视频盲盒**:
A low-pressure exploration surface that randomly draws from a bounded, disclosed candidate pool. It does not rank candidates by predicted engagement or present itself as Bilibili's recommendation feed.
_Avoid_: 猜你喜欢, 推荐排序, unexplained random inventory

**随机探索**:
A 视频盲盒 that randomly selects one openable seed from locally available recent watch records, discloses that seed, and then draws the final video only from its real Bilibili related-video candidates. The local record is only a query anchor, never the final inventory. If there is no usable seed or no real related candidate, the card reports that no candidate is available instead of substituting local history, favorites, or another blind-box source.
_Avoid_: 本地库存抽卡, silently changing candidate sources, using the seed as the final draw, 跨区漫游, opaque recommendation

**跨区漫游**:
A 视频盲盒 that randomly draws a real public video from a Bilibili category outside the user's recently dominant categories; without recent evidence, it discloses a randomly selected public category. It broadens exposure without claiming to eliminate an information bubble.
_Avoid_: 长期换口味, anti-bubble guarantee, personalized ranking

**冷门收藏**:
A local 视频盲盒 that resurfaces an infrequently revisited item already present in the user's local favorites. It is a collection revisit, not a real Bilibili candidate search.
_Avoid_: 真实 B 站探索, external candidate, 收藏延伸

**UP 主考古**:
A 视频盲盒 that randomly draws an older public submission from a followed creator's public archive. It excludes recent followed-account updates so it does not duplicate 动态账单.
_Avoid_: 久违更新, recent followed updates, local-history replay

**盲盒抽取记录**:
A bounded local list of the 50 most recently drawn Bilibili video identities shared by all four 视频盲盒 types. When a candidate pool contains other videos, recent draws are excluded before random selection; when every valid candidate is already in the list, drawing one again is allowed so deduplication never creates a false empty state. The record changes neither source eligibility nor candidate ranking and is removed with all local data.
_Avoid_: permanent exclusion, recommendation score, per-type hidden history, making a valid candidate pool look empty, a separate user-facing preference

**动态内容窗口**:
The default 7-day pool of followed video-submission updates considered by 动态账单.
_Avoid_: Unlimited dynamic archive

**Dashboard**:
The main Bili-Bill workspace where feature modules are surfaced as top-level views. It is the first home for 动态账单, though its overall information architecture is expected to evolve.
_Avoid_: Treating Dashboard as only a retrospective analytics panel

**个人视频知识库**:
A locally maintained collection of reusable knowledge artifacts bound to Bilibili videos, intended to help the user accurately find prior learning and return to its source. Favorites, watch-later membership, watch records, and the active video may supply candidate videos or entry points, but those relationships are not themselves knowledge.
_Avoid_: merging account lists into one content hoard, treating saved or watched as understood, recommendation ranking, automatically promoting every current video into durable knowledge

**知识库准入**:
The explicit or source-authorized event that creates a 视频条目 in the 本地知识空间. A synchronized favorite or watch-later relationship may create a lightweight entry; saving a 知识资产 admits its video and retains any complete Bilibili subtitle already available. A completed 本地转录 may also admit its video and text only in a release where that capability is actually available and after the user explicitly starts it. Merely opening a video, temporarily obtaining Bilibili subtitles for a video outside the knowledge space, or starting work that is later cancelled or fails does not admit it. Synchronization never bulk-fetches subtitles or starts transcription.
_Avoid_: treating page view as consent to persist, creating an entry for a failed transcription, exposing an unavailable transcription action, background subtitle harvesting, equating source synchronization with durable knowledge

**本地知识空间**:
The owner boundary for one 个人视频知识库 inside the current browser profile. Durable personal knowledge belongs to this space rather than to a Bilibili account; another account may contribute source relationships only after the user allows it.
_Avoid_: one fragmented knowledge base per Bilibili account, silently importing a newly detected account, treating a shared browser profile as separate private users

**账号来源关系**:
A local record of which user-confirmed Bilibili account supplied a favorite or watch-later relationship for a 视频条目. The source view distinguishes connected accounts by the nickname returned during that authorized sync or by a stable local alias when unavailable, without showing a UID or retaining an avatar. Synchronizing, disconnecting, or removing one account's relationship must not mutate another account's relationship or the space's 知识资产.
_Avoid_: unscoped account data, automatic import of a newly detected account, account profiling, using the account as knowledge ownership, sending account identifiers or labels to an AI service

**升级前收藏来源**:
A preserved favorite relationship migrated from a Bili-Bill version that did not record which Bilibili account supplied it. It keeps the known video and folder relationship without guessing an account. A later user-authorized, complete favorite synchronization may replace an exact matching legacy relationship with an 账号来源关系; unmatched records remain until explicitly cleared or reconciled by another complete sync.
_Avoid_: assigning legacy data to the currently logged-in account, deleting unmatched legacy records after an incomplete sync, presenting the legacy relationship as durable knowledge

**收藏来源**:
The area inside 个人视频知识库 that manages synchronized Bilibili favorite relationships, folder organization, classification, and source-index diagnostics formerly surfaced as the top-level “智能收藏” module. It supplies lightweight 视频条目 and source relationships but is not itself durable knowledge, a second search product, or a recommendation feed.
_Avoid_: keeping “智能收藏” as a competing top-level destination, treating every favorite as understood knowledge, duplicating 全局知识检索, deleting synchronized source data during the navigation migration

**收藏分类**:
A rebuildable classification and retrieval aid derived from synchronized favorite metadata, including the existing Smart Favorites category path, summary, keywords, and aliases. It may help find a 视频条目 at lower priority than personal knowledge or video text, but it is not 用户整理内容, a 知识标签, video evidence, or a factual source for AI answers.
_Avoid_: migrating generated categories into personal tags, presenting a classification summary as video content, backing it up as durable knowledge, sending it as factual evidence to AI

**已保存知识**:
The default knowledge-base view over durable 知识资产, including notes, timestamp bookmarks, saved excerpts, and explicitly preserved answers. It foregrounds the user's own maintained material rather than synchronized source inventory or temporary generated results.
_Avoid_: listing every favorite or watched video as saved knowledge, mixing unsaved AI output into the view, hiding an asset's related video and evidence state

**知识标签**:
A user-authored local text label stored with each 知识资产 for organization inside 已保存知识. Within one asset, surrounding whitespace, case-only differences, and duplicate values do not create distinct tags, while the user's natural display wording is retained. Tags are included in knowledge backup and work together with fixed type, source-video, and evidence-state filters; the cross-asset list used for filtering and input suggestions is rebuildable rather than a separate durable tag entity. They remain independent from Bilibili video tags, categories, and favorite folders.
_Avoid_: treating a Bilibili tag as a personal tag without user action, creating a durable tag entity and orphan lifecycle for simple text labels, building a second folder tree, using tags as evidence, sending unrelated tags to AI

**视频资料**:
The knowledge-base view over 视频条目 and their available 全文资料. It supports reviewing source coverage and managing complete Bilibili subtitles, plus completed local transcripts only in a release where that capability exists, without presenting a lightweight entry or complete source text as user-authored knowledge.
_Avoid_: treating full subtitles as notes, concealing whether complete text is available, duplicating 收藏来源 folder management

**知识库活动时间**:
The latest original time when one 视频条目 entered the local knowledge space or its related durable knowledge or managed full text genuinely changed. 视频资料 uses it for a stable maintenance order; metadata refresh, repeated source synchronization, verification, and another relationship to an already-known video do not change it. Restore preserves valid original activity timing instead of marking every imported video as new.
_Avoid_: video publication time, last sync time, last metadata check, click prediction, recommendation rank, restore wall-clock time

**仅有视频信息**:
The user-visible state of a lightweight 视频条目 that currently has public video information or synchronized source relationships but no durable 知识资产 and no 全文资料. It describes available local coverage rather than implying that the video was watched, understood, or analyzed.
_Avoid_: “轻量条目”, treating a favorite as knowledge, hiding an existing note behind this state, implying that missing full text means the video has no useful content

**视频信息待补全**:
The user-visible state of a preserved legacy favorite record that has a valid `avid` but no verified `bvid`, so it cannot yet become a canonical 视频条目. It remains visible under 收藏来源 until a later user-authorized sync or deterministic metadata refresh supplies the real `bvid`; before then it cannot own 知识资产 or 全文资料.
_Avoid_: deriving or guessing a `bvid`, dropping the legacy favorite, creating a provisional knowledge identity that later requires merging, exposing a raw missing-field error

**空间管理**:
The secondary knowledge-base control surface for storage usage, per-video full-text removal, full or lightweight backup, restore, conflict review, and 清空知识库. It is opened from the knowledge-base page rather than presented as a fourth primary content view.
_Avoid_: mixing destructive controls into normal browsing, hiding storage pressure until a write fails, treating synchronized source counts as durable knowledge size

**个人知识数据**:
The durable local-data category containing every 知识资产, its editable user layer, 资产来源关系, and 证据版本. It is removed only through per-asset deletion or the separately confirmed atomic 清空知识库 operation, never through an ordinary generic category clear.
_Avoid_: grouping complete transcripts or rebuildable indexes into personal knowledge, silent deletion from a generic clear action, treating synchronized source records as user-created knowledge

**完整文本数据**:
The separately measured local-data category containing current, historical, imported, and pending-revalidation 全文版本 plus their time-aligned segments. Removing this category through 空间管理 never removes related 知识资产 or 证据版本.
_Avoid_: counting temporary current-video caches as managed complete text, deleting evidence snapshots with full text, hiding historical versions from storage usage

**知识检索索引**:
The rebuildable local-data category derived from current video information, personal knowledge, managed full text, and local tag aggregation for search and suggestions. Durable tables keep only the secondary indexes required for accepted product queries and never index note, evidence, or complete-text bodies directly; normalized personal-tag keys are derived from the retained display tags. Global text retrieval uses this separate index only after its bounded physical design passes the release gate. It may be cleared or regenerated independently because it owns no durable user meaning and cannot be the only copy of any source text, tag, or evidence.
_Avoid_: backing up the index, treating index rows as knowledge assets, retaining removed personal text after rebuild, making index availability a prerequisite for reading durable records, scanning the complete text corpus for each query, speculative indexes for undefined future features

**重置 Bili-Bill（保留知识库）**:
The separately confirmed settings operation that clears ordinary module data, local settings, temporary caches, and rebuildable indexes while preserving every 个人知识数据 and 完整文本数据 record. A cleared knowledge-search index is regenerated from the retained knowledge rather than treated as lost user content.
_Avoid_: calling the operation a complete local-data deletion, silently including durable knowledge or managed full text, implying that a cleared index means the knowledge was deleted, combining it with 清空知识库 under one non-atomic confirmation

**视频条目**:
The canonical top-level representation of one Bilibili video inside 个人视频知识库, identified independently from favorite, watch-later, watch-history, account, and text-source records. A multi-part submission remains one 视频条目 whose parts provide subordinate scopes for precise knowledge and navigation. Source relationships may create or keep a lightweight entry, but they do not own it and appearing in one does not imply that the video has been understood or curated. A video remains while it has any source relationship, 知识资产, or current or historical 全文版本; only a record with none of those may be removed as an empty shell.
_Avoid_: reusing a favorite or history row as the video identity, duplicating one video per folder, source, account, or part, treating a source relationship as knowledge, deleting a video that still has durable knowledge or full-text history, equating watch-later membership with unwatched status

**视频分 P**:
The subordinate identity for one exact `cid` inside a 视频条目. Its title, duration, and page order may change without changing identity; a different `cid` is a different part even when it later occupies the same page number. A part missing from a successful complete source list remains locally recognizable as “视频分 P 暂时无法核对” while durable knowledge, evidence, or full text still references it.
_Avoid_: page number as identity, moving old evidence to a replacement `cid`, deleting referenced parts after a partial or failed read, treating whole-video inaccessibility as a complete empty part list

**视频展示快照**:
The last successfully resolved public display information for a 视频条目 and its parts, such as title, description, cover, creator, public category and tags, duration, publication time, and part order. It may refresh without changing video identity, 知识库活动时间, or user-authored knowledge, remains available when the source later becomes inaccessible, and helps recognize a source offline but is not evidence of what the video says.
_Avoid_: metadata as video-content evidence, erasing known values with an empty or failed response, storing a raw API response or network error, overwriting personal titles or notes, bumping knowledge activity during metadata verification, choosing restore winners by device time

**知识资产**:
A durable item that the user explicitly creates or preserves and relates to one or more 视频条目, such as a note, timestamp bookmark, saved highlight, or explicitly saved generated result. It owns the current 用户整理内容 and may own one separate immutable 保存内容; each supporting source remains in its own relationship and evidence history. It may describe one video or synthesize several, but every local claim, citation, and timestamp retains its exact source and part scope. A 知识资产 is never removed by automatic capacity cleanup; if new durable content cannot be stored safely, the new save is refused until the user manages or exports data.
_Avoid_: silently saving every generated result, automatically turning full subtitles into personal knowledge, deleting user-preserved work when an upstream relationship disappears, least-recently-used eviction, deleting old knowledge to make room for a new save

**持久身份**:
The stable identity retained across local storage, backup, and restore. 视频条目 and parts use validated, lossless Bilibili identities, while 知识资产, 资产来源关系, 证据版本, and 全文版本 use locally generated UUIDs that never change because of database order, export, or import. External account and container scopes retain canonical decimal strings, while existing runtime video identifiers remain numbers only when they are safe integers. A 全文片段 is subordinate to one immutable version and is identified only by that version UUID plus its contiguous order. Internal content fingerprints may support idempotency and conflict detection but are not user-facing identity.
_Avoid_: auto-increment row numbers as backup identity, modification time as identity, lossy number conversion, guessing a malformed external identifier, independent fragment UUIDs, showing UUIDs or content fingerprints in ordinary UI

**资产来源关系**:
The durable link from one 知识资产 to one 视频条目 and, when applicable, an exact part. One asset may have several source relationships, while a whole-video personal note may link to a video without captured evidence. Each relationship selects at most one current 证据版本 and therefore changes one source without rewriting another.
_Avoid_: embedding all sources as one indivisible asset field, inventing a part for a whole-video note, selecting evidence owned by another relationship, changing every citation when only one source is corrected

**已连接来源账号**:
The minimal local registry entry for one Bilibili account that the user explicitly confirms for favorite or watch-later synchronization. It owns a random local account scope, retains the stable Bilibili account identifier returned by that authorized sync only inside the registry for later matching, and carries the available nickname or a stable fallback alias such as “已连接账号 1”. Synchronized source relationships reference only the local scope without duplicating the label or external identifier. It is source-management data rather than personal knowledge and disappears with that account's source relationships when disconnected.
_Avoid_: a Bilibili profile, showing a UID, treating a nickname as identity, retaining an avatar, reading Cookie or login-state files, including the account in knowledge backup, diagnostics, logs, or AI requests, copying an account identifier or nickname into every source relationship

**来源容器**:
The local source-management record for one exact favorite folder, watch-later collection, or later authorized collection inside an 已连接来源账号 or the reserved upgrade-era legacy scope. It owns the mutable collection label, public description, reported count, sync completeness, and sync time even when the collection contains no video; its video memberships reference the stable container scope rather than copying that metadata.
_Avoid_: a knowledge folder, a personal tag, duplicating a folder title on every video membership, treating an incomplete sync as authoritative absence, inventing an account for upgrade-era favorites, including source-container data in knowledge backup or AI evidence

**用户整理内容**:
The editable current state of a 知识资产: its title, user-authored note, 知识标签, and the body of a pure user note. Explicit save atomically replaces this layer without creating an in-product edit-history version; cancel leaves the stored state unchanged. Editing changes the user's organization or interpretation without rewriting the captured source material that supports it.
_Avoid_: presenting AI or subtitle wording as user-authored text, editing a citation through a note field, hidden autosave, implying that ordinary edit history is retained, hiding which text came from the user

**保存内容**:
The single immutable content a user explicitly preserves as one 知识资产, such as selected answer text, a whole validated answer with its original question, a summary, or a highlight. It keeps one or more ordered text blocks so each source can state which complete blocks it supports without fragile character positions. It is stored once at asset level even when several source relationships support it, remains visibly distinct from editable personal notes, and is backed up with the asset. Rewriting it creates separate user-authored knowledge rather than changing what was originally saved.
_Avoid_: one duplicate answer per citation, editable generated wording presented as original output, copying model or prompt metadata, replacing saved content during source relocation, treating saved wording as video evidence without its exact evidence versions

**知识类型**:
The fixed primary kind of a 知识资产: 笔记, 时间书签, 摘录, or 已保存回答. A 摘录 may naturally identify its saved-content origin as 字幕摘录, 亮点, 摘要, or 回答摘录 without creating another top-level filter taxonomy.
_Avoid_: one asset type per model feature, source type as a primary knowledge type, changing type when evidence becomes unavailable, recommendation categories

**证据层**:
The read-only captured portion of a 知识资产, comprising its optional asset-level 保存内容 and the exact source support organized through 资产来源关系 and 证据版本. 保存内容 retains what the user chose to preserve once; evidence versions retain source video, exact part, source excerpt, time range, and mapping to that content. A correction uses an explicit source-relocation flow rather than direct text editing, so personal organization cannot silently rewrite historical evidence.
_Avoid_: in-place editing of captured evidence, silently changing timestamps or cited videos, treating user notes as source text, exposing raw source identifiers

**证据版本**:
An immutable captured source-support record owned by one 资产来源关系. It retains the exact video, part, source excerpt, real time range, and the complete 保存内容 block numbers it supports without duplicating a multi-source answer or summary. The relationship's single selection determines which version is current; other versions under that relationship are displayed as 已更正 without changing their captured records. 重新定位来源 creates a new version and changes only that relationship's selection.
_Avoid_: overwriting captured evidence, mutable current flags on several versions, selecting a version owned by another relationship, deleting the previous version during correction, one global evidence version for a multi-source asset

**重新定位来源**:
An explicit correction operation that replaces one current evidence selection only after the user selects an available complete source, chooses an exact continuous passage or time range, previews the new video, part, text, and timing, and confirms. The new evidence version becomes selected while the prior mapping remains read-only in the evidence history as 已更正.
_Avoid_: direct evidence editing, selecting unavailable text, silently replacing every citation in a multi-source asset, deleting the prior mapping, accepting a source without preview

**已更正**:
The derived historical state of an earlier evidence mapping that the user replaced through 重新定位来源. It remains visible for audit and recovery context because its relationship now selects another version; the evidence record itself is unchanged and cannot support a new factual answer or current citation.
_Avoid_: storing several mutable current flags, presenting the old mapping as current evidence, deleting correction history, exposing internal version identifiers, treating a correction as AI regeneration

**多来源知识资产**:
A single 知识资产 that preserves one comparison or synthesis while linking to several 视频条目 or parts. It appears as related knowledge under every linked video but has one identity and one editable copy; each citation keeps its own source state, so one changed source marks only the affected support rather than splitting or deleting the whole asset.
_Avoid_: cloning the same synthesis once per video, choosing an arbitrary primary video, losing cross-video meaning, treating one changed citation as proof that every source changed

**选区摘录**:
A durable 知识资产 created when the user selects sourced text inside a Bili-Bill answer or subtitle view and invokes the scoped save action. An answer selection preserves its originating question and only the citations mapped to the selected answer content; a subtitle selection preserves the exact selected text, part, and real time range. A selection that crosses unrelated blocks or cannot retain an exact source is refused rather than silently downgraded.
_Avoid_: arbitrary Bilibili page clipping, saving selected AI wording without its mapped citations, inventing one source for a cross-block selection, treating a selection as automatically user-authored commentary

**证据快照**:
The minimal durable source material captured inside one 证据版本 for an 资产来源关系 so the user can later read what was preserved and return to its video and part. It contains the captured excerpt or mapped citation, natural source explanation, and real time range when available, but not the full subtitle or transcript. A snapshot may support what the user previously saved; when the complete current source is unavailable, it cannot by itself establish the video's current wording for a new answer.
_Avoid_: duplicating the full source, treating a historical snapshot as a current transcript, deleting it with a source cache, exposing raw source hashes or internal identifiers in ordinary UI

**全文资料**:
A complete Bilibili subtitle or, where the capability is actually available, completed 本地转录 associated with a 视频条目 inside the 本地知识空间. It is retained locally, included by default in a full 知识库备份, and never silently evicted; when the separately measured full-text capacity is reached, Bili-Bill stops adding new complete texts and asks the user to back up or manage storage. Complete text for an active video outside the knowledge space remains a temporary source cache. Once admitted as 全文资料, its durable lifecycle no longer depends on that temporary cache. An explicit knowledge save may promote an available complete text under 知识库准入, while synchronization alone never fetches it. Removing 全文资料 never removes a related 知识资产 or its 证据快照.
_Avoid_: treating every viewed video's subtitle as permanent, interpreting a cache-retention marker as knowledge admission, making durable text depend on a temporary cache, silently deleting older complete texts to admit a new one, equating full source text with user-authored knowledge, deleting notes when a complete text is removed

**全文版本**:
One immutable body-and-timeline version of 全文资料 for an exact video, part, language, natural source type, and private stable source variant. That scope has at most one current version selected independently from mutable part order, display label, endpoint, or subtitle URL. When Bilibili provides no stable non-URL track discriminator, one “默认 B站字幕” variant is used and differing same-language content requires explicit replacement confirmation. The version is explicitly current, historical, or pending revalidation; restore origin remains distinguishable without becoming another source type. Identical reacquisition only refreshes its verification time; changed text remains a temporary “字幕有更新，待确认” candidate until the user accepts it, after which the former current version becomes a read-only historical version. A restored backup-current version remains pending validation until a real source check explicitly makes it current, while a restored historical version stays historical.
_Avoid_: silent overwrite, two current versions for one scope, using page order as source identity, treating punctuation or timeline changes as identical, using a historical or unvalidated version as current AI evidence, excluding historical versions from storage usage

**全文片段**:
One non-empty, ordered, time-aligned portion of a 全文版本. It is stored and processed separately so long complete texts can be read, indexed, backed up, restored, and removed in bounded batches, but it has no lifecycle or evidence authority without its owning version. Its identity is the owning version's stable UUID plus a zero-based contiguous order; valid source-provided time overlap may remain, while missing intervals never receive invented text. Changing any body text or timing creates another complete version rather than merging fragments. Creating or deleting one version still commits all of its fragments as one atomic outcome.
_Avoid_: one opaque whole-video text row, independently current fragments, partial version admission, fragment UUIDs, cross-version fragment merging, exposing internal fragment identifiers in ordinary UI

**全文空间用量**:
The deterministic uncompressed canonical UTF-8 byte total of every current, historical, imported, and pending-revalidation 全文版本 and its complete ordered fragments. Per-version byte counts are authoritative and a repairable aggregate ledger accelerates admission checks; mutable lifecycle state, compressed backup size, browser storage overhead, and temporary current-video caches do not define this usage. The retained-text warning begins at 400 MiB and a result above 500 MiB is refused without evicting older text.
_Avoid_: ZIP size as retained usage, estimates as final admission truth, trusting a drifting aggregate without repair, excluding historical or unvalidated versions

**知识库备份**:
A user-initiated, local, versioned compressed package for restoring or migrating personal knowledge. It always contains every durable 知识资产, its user edits, video and part links, multi-source relationships, and 证据快照; by default it also contains every 全文资料, while a user may explicitly create a 轻量备份 without those complete texts. It is not a copy of the whole browser profile and never contains temporary source caches, synchronized account data, ordinary conversation history, audio, transcription models, AI configuration, or credentials.
_Avoid_: cloud upload, silently omitting managed complete texts from the default backup, implying that unavailable texts were included, persisting an unsaved active video's temporary cache through backup, including API keys or account identifiers, requiring the original browser profile to read the package

**非破坏性恢复**:
The default atomic merge of a validated 知识库备份 into the current 本地知识空间. New assets are added, identical assets are skipped, and an asset with the same 持久身份 but different content is retained alongside the local version as a clearly labeled imported version with a new local UUID. Restore never deletes or silently overwrites local knowledge.
_Avoid_: timestamp-based winner selection, partial writes, hidden replace-all behavior, per-item interruption during import, deleting local assets absent from the backup

**来自备份，待核对**:
The user-visible state of 全文资料 restored from a backup whose exact video, part, source type, source variant, text, and timeline have not yet been revalidated against the currently available source. The text remains readable and locally searchable, but cannot support a new AI answer or current factual citation until validation succeeds.
_Avoid_: calling a backup copy current evidence, selecting a winner by backup date, hiding a differing local version, exposing raw content hashes

**清空知识库**:
A separately confirmed destructive operation that removes every durable 知识资产, its 证据快照 and user edits, every 全文资料, imported conflict versions, and all search or vector index entries derived from that knowledge. It leaves ordinary conversation history, temporary source caches outside the knowledge space, synchronized favorite and watch-later relationships, account source relationships, settings, AI configuration, credentials, and unrelated Bili-Bill data unchanged. Retained source relationships may later recreate lightweight 视频条目 without restoring any deleted personal knowledge.
_Avoid_: ambiguous reset wording, deleting sessions or synchronized relationships, leaving deleted text in an index, implying that source lists were removed, performing the action without a backup option and explicit typed confirmation

**个人知识来源**:
A 知识资产 selected as relevant context for a knowledge-base question. Its source is shown as personal knowledge, such as “个人笔记”, rather than video text. It may support what the user recorded or preserved, but it can support a claim about what a video said only when it retains a current, valid citation to that video's exact part and text source.
_Avoid_: presenting a note as video wording, sending unrelated personal knowledge, treating an “依据已变化” item as current evidence, hiding whether a claim came from the user or the video

**依据已变化**:
The user-visible state of a preserved source excerpt or generated 知识资产 whose exact supporting text or part availability has changed. The item remains readable as a historical result but cannot support a new answer or current factual citation until the user explicitly updates it from valid evidence.
_Avoid_: deleting the saved item, silently regenerating or overwriting it, treating old evidence as current, exposing raw source-version fields

**全局知识检索**:
A single local search surface over every lightweight 视频条目 and its available layers: video information, time-aligned video text, personal 知识资产, and explicitly saved generated results. Each result states in natural Chinese which layer matched, and relevance gives personal knowledge priority over video text and video information. The active video participates only in its page-local search until it has entered the local knowledge space.
_Avoid_: hiding which layer matched, presenting metadata as video-content evidence, silently persisting the active video, recommendation or click-probability ranking

**本地混合检索**:
The always-available retrieval foundation for 全局知识检索 and knowledge-base source selection. It combines local wording, structured video information, time-aligned text, personal knowledge, aliases, and other available relevance signals while keeping the matched local material as the source of truth. Optional query expansion or locally validated semantic signals may improve recall, but search remains usable without AI or vector indexing.
_Avoid_: vector-only retrieval, making AI availability a search prerequisite, treating expanded terms as evidence, recommendation ranking

**检索增强问答**:
A user-initiated knowledge-base answer grounded in a bounded set of eligible videos or parts chosen through 本地混合检索. Once a source is selected, its complete 主要文本来源 rather than isolated retrieval fragments supplies the answer context; the answer appears before exact, reviewable citations. Retrieval narrows which sources enter the request but never turns a matching fragment into the answer itself.
_Avoid_: uploading the whole knowledge space in the background, answering from metadata matches, fragment-only answers, uncited cross-video claims, treating retrieval relevance as evidence confidence

**跨视频请求来源集**:
The user-visible set of at most five exact video or part scopes selected locally for one knowledge-base question, including the active video when present. Every selected scope contributes its complete primary text; additional candidates remain disclosed but excluded unless the user replaces a selected source. A request whose selected complete texts exceed 512 KiB requires a separate waiting-time and possible-provider-cost confirmation, without model context-window discovery or silent truncation.
_Avoid_: more than five hidden sources, counting retrieved fragments instead of exact source scopes, automatic context truncation, fragment-only fallback after provider rejection, hiding excluded candidates

**证据范围判断**:
The local, per-question decision that limits a submitted question to the current video, the personal knowledge space, or both. One ordinary input remains visible: clear cross-video intent may include knowledge-base sources automatically, an ambiguous question with an active video stays scoped to that video and may offer a one-time broader search, and a question without an active video uses the knowledge space. The resolved scope is shown in natural Chinese and changes neither persistence nor later questions.
_Avoid_: a persistent mode switch, remote intent routing, silently changing the scope of later turns, persisting the current video merely because it was compared, requiring an internal Skill or MCP hop

**辅助摘要**:
A full-primary-text AI overview of the active part. It presents the video's subject, content arc, and key points without displaying subtitle excerpts inline, and it is unavailable when no 主要文本来源 exists. It is displayed only as part of a combined summary-and-highlights result whose evidence mappings all validate against the current primary-text version.
_Avoid_: 字幕罗列, 引用片段列表, treating retrieved evidence as the summary, displaying a partially validated generation

**视频亮点**:
A small set of full-primary-text moments that capture the active part's key ideas, turning points, or demonstrations. Each highlight has a reliable time range mapped to the current primary-text version and supports preview, confirmed navigation, and return to the previous playback position. Any invalid highlight rejects the new combined summary-and-highlights result.
_Avoid_: 辅助知识节点, 完整章节目录, time points inferred only from metadata, keeping only the valid-looking parts of a failed generation

**当前视频问答**:
A full-primary-text answer about what the active video says, available only under 完整文本授权. It gives a direct answer before cited video fragments and declines when the active part's text cannot support the answer. Every citation must map to the active part, the current primary-text version, and a real time range; an answer with any invalid citation is rejected as a whole. General model knowledge is not video evidence.
_Avoid_: 关键词命中当回答, 只列引用片段, unmarked general-knowledge completion, showing an answer with unverifiable citations

**问答会话**:
A locally persisted, capacity-bounded question-and-answer timeline that can remain open while the user moves between videos. The user sees one ordinary conversation, its history, and the current reference video rather than a fixed main question or visible video branches. Every submitted turn captures the active evidence scope and exact text sources; its answer and citations remain bound to that captured evidence even after the page changes. Every validated answer carries compact natural-language source lines that can open the corresponding videos but never seek directly; timestamp citations retain preview, confirmation, and return. Switching videos changes only the evidence available to the next submitted question and never sends a request or inserts a conversation message automatically. Earlier turns stay readable in the same timeline, while facts and citations from another video or an earlier text version cannot silently support a new answer. A conversation begins when its first question is submitted, and a failed generation or validation remains one retryable logical turn without becoming conversation context. The session stores validated turns for later review but does not duplicate full video text or resend all stored history on every question. A normal session is local history rather than permanent knowledge; only selected content or one validated turn that the user explicitly saves becomes a durable 知识资产.
_Avoid_: fixed main questions, user-visible video branches, video-switch system messages, automatically asking after a video switch, direct seeking from an answer source label, treating another video's answer as current evidence, adding duplicate turns for retries, using failed answers as conversation context, hiding an old text version behind a raw identifier, freezing the whole session after one video's text changes, duplicating full transcripts inside session storage, resending the entire stored conversation on every question, treating every conversation as permanent knowledge, deleting an explicitly saved knowledge asset when its source session is evicted

**对话脉络**:
A bounded, rolling summary used only while consecutive questions share the same active video, part, and exact 主要文本来源 identity. It helps same-evidence follow-up questions retain continuity but is not video evidence and cannot support an answer or citation by itself. When the video, part, or primary-text identity changes, the model-side context resets even though the locally visible 问答会话 timeline remains. It changes only after a newly generated answer and all of its citations have passed validation.
_Avoid_: treating conversation context as video evidence, carrying any context across a video/part/text-identity change, preserving unsupported model claims, updating context from a rejected answer

**字幕全文**:
A dedicated view of the active video's selected viewing text source, preserving its time alignment for reading, search, navigation, and export. It shows available Bilibili subtitle body text and may show a completed 本地转录 only when that capability exists in the release. The viewing source is independent from the 主要文本来源 used by the video assistant. “Available” Bilibili subtitles means readable body text has been obtained and matched to the active part; a subtitle that may exist or a detected track without body text is not yet available. It is an evidence surface, not part of the 辅助摘要.
_Avoid_: 在摘要中展开字幕证据, treating subtitle text as an AI summary, treating a detected subtitle track as usable body text, changing the video assistant source by browsing another subtitle source

**语音转录**:
A user-initiated conversion of the active video's audio into a separate, time-aligned text source that preserves the original spoken language. It remains available whether or not Bilibili subtitles exist, but never claims automatic superiority or silently replaces them. Translation, manual correction, and speaker diarization are separate derived capabilities, not part of 语音转录.
_Avoid_: 自动上传音频, silently overwriting Bilibili subtitles, treating transcription as already available, presenting translation as the speaker's original words, editing the generated transcript in place, treating TTS as speaker diarization

**本地转录**:
A conditional form of 语音转录 performed on the user's device after explicit activation, with neither audio nor the generated text sent to a remote transcription service. A release that has not verified and shipped this capability does not expose it as an available action or replace it with remote transcription. If a completed result becomes the 主要文本来源, its text may be sent to the configured chat service only under 完整文本授权; audio always remains local.
_Avoid_: advertising a planned capability as available, 远程转录降级, reusing a chat model as an audio model, background transcription without user action

**主要文本来源**:
The user-selected time-aligned text source used by 辅助摘要, 视频亮点, and 当前视频问答. It can be the available Bilibili subtitles or, where supported by the release, a completed 本地转录, and it never changes silently; title and description may supplement it but never replace it.
_Avoid_: 自动覆盖原字幕, metadata-only video understanding, mixing unlabeled text sources

**完整文本授权**:
The permission represented by the single “当前视频 AI 助手” setting to send the active part's full 主要文本来源 to the configured chat service. Enabling it sends nothing by itself; generation and questions remain user-initiated, and turning it off stops new requests without deleting local results.
_Avoid_: Silent full-text upload, audio upload, cross-video context, treating provider capacity as guaranteed

**知识库 AI 授权**:
A separate, locally stored permission to send the complete primary text of question-selected knowledge-base sources and their directly relevant 个人知识来源 to the configured chat service. It starts disabled, can be granted inline when the first knowledge-base question needs it, sends nothing merely by being enabled, and remains active until revoked. Revocation stops future knowledge-base AI requests without deleting local knowledge, prior answers, or local search.
_Avoid_: inheriting 当前视频 AI 助手 permission, background upload, forcing a settings-page detour, repeating consent for ordinary questions, deleting local data on revocation

## Flagged Ambiguities

**动态**:
In Bili-Bill, "动态" means Bilibili updates from followed accounts, not animation, visual motion, or generic activity logs.

**动态内容 scope**:
Version one of 动态账单 narrows dynamic content to 视频投稿动态 only. Other Bilibili dynamic types are intentionally out of scope until video guidance is validated.

## Example Dialogue

Developer: "Should this feature live under the old B站消费数据中心 name?"

Domain expert: "No. The product is Bili-Bill now; individual modules can describe their purpose, but the extension brand should be Bili-Bill."

Developer: "Is 动态账单 another analytics dashboard?"

Domain expert: "No. 动态账单 is shown before content consumption; it guides which followed updates are worth opening."

Developer: "Should 动态账单 replace the Bilibili dynamic page?"

Domain expert: "No. The first version belongs in the Bili-Bill Dashboard as a top-level view; the native Bilibili page remains the place where content is opened."

Developer: "Do we summarize every kind of Bilibili dynamic?"

Domain expert: "No. Version one only handles 视频投稿动态, because videos match the existing Bili-Bill content model."

Developer: "Should 动态账单 rank the videos the user is most likely to click?"

Domain expert: "No. Bilibili already optimizes for recent preference and engagement. 动态账单 should support 兴趣再平衡 by surfacing followed updates the user may have forgotten or under-consumed."

Developer: "Which columns belong in the first version?"

Domain expert: "Use 被淹没的关注, 收藏关联更新, and 关注轮换 as the stable columns. More history can strengthen their evidence, but it does not change the visible set."

Developer: "Is every 动态账单 entry just a video?"

Domain expert: "Each 0.13 账单项 focuses on one UP主 and one latest unwatched post from the current dynamic window. Historical videos may support the local evidence explanation, but cannot replace the new post or become the card's primary content."

Developer: "Does opening a new video count as consumption?"

Domain expert: "No. Opening creates 已打开; only watch history or player events can confirm 已消费. The user can also manually mark a bill item 已处理."

Developer: "Should 动态账单 learn when a user dislikes an old surfaced interest?"

Domain expert: "Yes, but only locally. Repeated 负反馈 can reduce future surfacing and may trigger a 取关提示, but Bili-Bill should not write back to Bilibili automatically."

Developer: "Can a creator be important even if the user has not watched them recently?"

Domain expert: "Yes. 已关注时间 is a separate taste-memory signal; long-followed creators can be worth resurfacing even when recent watch history is quiet."

Developer: "What time windows define 动态账单 by default?"

Domain expert: "Use 180 days for long-term watch history, 30 days for recent watch history, and 7 days for followed video submissions. Follow age should use the available relationship timestamp without truncation."
