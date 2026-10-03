# Open Knowledge Files v1

Status: implementation contract for #316/#318/#324; not a shipping claim.

## Ownership and layout

The user selects a directory. Only its explicitly chosen managed subdirectory (default `Bili-Bill`) is writable. Other individually selected Markdown is read-only and never copied into the managed area without an explicit import. Files are UTF-8; attachments are ordinary image files.

```text
Bili-Bill/
  library.json
  pages/<page-id>/<revision-id>.md
  sources/<source-id>.json
  attachments/<sha256>.<png|jpg|webp>
  proposals/<proposal-id>.json
```

`library.json` identifies format `bili-bill-open-knowledge`, version 1, and library identity. Every page revision is ordinary Markdown with a small machine-readable frontmatter envelope. Its body is readable without Bili-Bill. No hidden database is needed to reconstruct pages. Revision filenames and reference IDs use a strict safe alphabet, not user titles or arbitrary paths.

Page kinds are `video` (one identity per bvid, parts referenced separately) and `personal` (freely named). A revision records page ID, revision ID, all parent revision IDs, title, kind, timestamps, author kind, sources, attachments, original legacy IDs and named AI supplement sections. Personal text and AI supplements are distinct; immutable source snapshots never appear as an editable original-text section.

Source snapshots contain the original video/part identity, label, subtitle segments and timestamps, captured version/hash, and capture time. AI-optimized text is a separate derived version referencing that original. A screenshot stores actual capture time, exact overlapping captions and separately labelled nearby narration. Missing subtitles do not block a note.

## Versions, conflicts and recovery

Revisions are immutable and append-only. Current heads are computed from the revision graph, not from a mutable last-writer-wins pointer. Two children of the same base remain two heads until a user confirms a resolution with both parents. An interrupted or concurrent operation must not erase either body. UI reports a conflict and shows both versions.

Every write binds its base revision(s). The client re-reads heads immediately before applying. If the base changed, it returns a conflict, not silent overwrite. A race after that check can produce two preserved heads; a subsequent read must surface it. File System Access locks alone are not considered cross-process synchronization with Node.

A save is complete only after the file writer closes successfully. Retry is idempotent for identical revision bytes/ID. Different content at an existing ID is an integrity error. Recovery/rollback creates a new revision from the chosen historical body; it never deletes history. Orphaned/incomplete files are reported and excluded, not silently treated as empty knowledge.

## Browser persistence and directory permissions

IndexedDB stores current working copies, drafts, directory handles, search cache and an ordered durable write queue. A note first commits locally. `已保存` means local storage succeeded; `已写入目录` requires a matching successful file receipt. A disconnected directory leaves an honest pending state and a reconnect action. Requesting filesystem permission occurs only after a user gesture in an extension page; background workers cannot silently re-prompt.

The queue uses stable operation/revision IDs, validates the library identity on reconnection, and reads directory changes before flushing. It must not replay into a different library or overwrite an external edit. Browser refresh reads Codex revisions and checks conflicts. A directory error never causes local data deletion.

## Migration and limits

Legacy learning assets and Wiki associations retain their original IDs and source identity. Migration is additive and idempotent, records a schema version and completion receipt only after successful writes, and leaves the existing database/backup usable. Metadata-only favorites remain sources, not saved knowledge. A deleted platform favorite or incomplete reimport cannot delete local knowledge.

The old 1,000-asset/10 MiB learning-body contract remains unchanged for legacy storage. New attachments are separately stored blobs, with explicit size/type validation and capacity errors. New full subtitles and open-page revisions do not get squeezed into or silently expand the old body cap. Export/import includes referenced originals, image bytes and revision history; missing attachments surface explicitly. No base64 images inside old note bodies.

Implementation bounds: each new page revision is at most 16 MiB of canonical data; a source snapshot at most 32 MiB (including immutable legacy provenance); each image at most 10 MiB. A page/history import transaction is at most 64 MiB. These guards accommodate the existing 10 MiB legacy corpus without changing its own contract; they are not performance-gate claims. Capacity failures must leave the legacy database and pending data intact.

## Codex boundary

The local plugin contains a Skill, portable stdio MCP entrypoint and package metadata. The server sees only a configured root plus explicitly listed read-only Markdown. Reject absolute/parent paths, device paths, symlinks/junctions and escapes from that scope. User titles and file contents are untrusted data. Protocol output uses stdout, diagnostics stderr; never log model secrets or whole libraries.

Tools expose bounded search snippets, page/history/source reads, page creation, modification proposals, confirmed application and restoration. Search never includes the entire library in a tool result. Original sources and attachments are immutable. Proposal IDs bind the displayed before/after diff, base and target. Personal edits require a host MCP elicitation form showing the change with a default-false confirmation. A model-supplied boolean cannot bypass it. Hosts without this capability can read and propose but cannot apply personal edits. Synthetic host tests do not prove the installed Codex host supports this interaction.

Confirmed applications record author, proposal and version references, so the browser can read them without a second prompt. A changed base invalidates prior confirmation and requires a revised proposal. AI supplement edits can use a separately enabled scope; they cannot rewrite personal notes under that permission.

## Backup and selected references

The browser's `bili-bill-knowledge-backup` v1 JSON envelope contains library identity, creation time and canonical base64 files with their managed relative paths. It includes saved revisions, sources, attachments and proposals, but excludes drafts, directory handles, selected read-only files, model configuration and chat history. These exclusions are visible before export. The archive is not encrypted.

An archive is bounded to 90 MiB serialized, 64 MiB decoded and 20,000 files. The resulting merged restore is also bounded to 64 MiB. Validation covers the complete graph, hashes and dependencies before a preview exists. Application requires that exact preview object and unchanged local epoch/sequence; immutable collisions fail without partial writes. Restore adds missing files and preserves competing heads. Queue replay into an empty directory orders originals, derived sources, attachments and proposals before dependent revisions.

Individually selected external `.md` handles are stored only in IndexedDB with a read-only text cache. Limits are 64 files, 2 MiB each and 32 MiB total. Selection and explicit refresh can prompt for read permission; ordinary retrieval cannot. Revoked, missing or unreadable files are excluded. No tool in this path opens a writable stream. Selection is distinct from the separate explicit "import Markdown copy" action. The Codex process separately authorizes exact read-only paths in its own configuration; browser permissions are not exported to it.

Browser chat retrieves at most six relevant snippets within an 8192-byte citation budget from saved pages, source snapshots and authorized external references. It includes new Codex-authored revisions after directory refresh. Metadata-only favorites are not knowledge. Citations bind revision/source or reference digest, and retained excerpts are marked stale when current content changes. Read-only files are checked at retrieval/preview time, not continuously watched on disk.

## Public validation boundaries

Tests use the same format/graph/queue interface in browser and Node adapters. Cover round-trip Unicode, invalid paths/frontmatter, idempotent retry, external conflict, partial writes, missing source/image, offline restart, library mismatch, legacy migration, proposal tampering, readonly originals and historical restoration. Real directory permissions and cross-process application receive integration tests in addition to unit tests.

Primary API reference: [File System Access](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access). Browser support and permission behavior are validated separately from format conformance.
