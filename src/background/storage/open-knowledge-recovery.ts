import type { KnowledgeRepository } from './open-knowledge-repo.ts';
import { KnowledgeDirectory, safeKnowledgePath, KNOWLEDGE_MAX_PAGES, KNOWLEDGE_MAX_REVISIONS } from '../../shared/open-knowledge/directory.ts';
import type { KnowledgeDirectoryHandle } from '../../shared/open-knowledge/browser-files.ts';
import { digest, jsonBytes, pageId, requireKnowledge } from '../../shared/open-knowledge/format.ts';
import { KNOWLEDGE_BACKUP_RAW_MAX_BYTES, orderKnowledgeFiles, validateKnowledgeFiles } from '../../shared/open-knowledge/backup.ts';
import type { KnowledgeLocalMeta } from '../../shared/open-knowledge/local-state.ts';

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, i) => value === b[i]);
type Preview = Awaited<ReturnType<typeof validateKnowledgeFiles>> & { incompleteFiles: number };
type Prepared = { repo: KnowledgeRepository; state: KnowledgeLocalMeta; entries: Map<string, Uint8Array>;
  original: KnowledgeDirectory; fingerprint: string };
const previews = new WeakMap<object, Prepared>();

async function fingerprint(entries: Map<string, Uint8Array>) {
  const rows = [];
  for (const [path, bytes] of [...entries].sort(([a], [b]) => a.localeCompare(b))) rows.push([path, await digest(bytes)]);
  return digest(jsonBytes(rows));
}
async function scan(directory: KnowledgeDirectory, libraryId: string) {
  await directory.connect({ expectedId: libraryId });
  const entries = new Map<string, Uint8Array>(); let total = 0;
  const read = async (path: string) => {
    safeKnowledgePath(path);
    const bytes = await directory.files.read(path); requireKnowledge(bytes, 'recovery_stale');
    total += bytes.length;
    requireKnowledge(entries.size < 20001 && total <= KNOWLEDGE_BACKUP_RAW_MAX_BYTES + 4096, 'capacity');
    entries.set(path, bytes);
  };
  for (const entry of await directory.files.list('')) {
    if (entry.name === 'library.json' && entry.kind === 'file') { await read(entry.name); continue; }
    requireKnowledge(entry.kind === 'directory' && ['pages', 'sources', 'attachments', 'proposals'].includes(entry.name), 'unexpected_file');
    const children = await directory.files.list(entry.name);
    if (entry.name === 'pages') requireKnowledge(children.length <= KNOWLEDGE_MAX_PAGES, 'capacity');
    for (const child of children) {
      if (entry.name === 'pages') {
        requireKnowledge(child.kind === 'directory', 'unexpected_file'); pageId(child.name);
        const revisions = await directory.files.list(`pages/${child.name}`);
        requireKnowledge(revisions.length <= KNOWLEDGE_MAX_REVISIONS, 'capacity');
        for (const revision of revisions) {
          requireKnowledge(revision.kind === 'file', 'unexpected_file'); await read(`pages/${child.name}/${revision.name}`);
        }
      } else { requireKnowledge(child.kind === 'file', 'unexpected_file'); await read(`${entry.name}/${child.name}`); }
    }
  }
  requireKnowledge(entries.has('library.json'), 'recovery_stale');
  await directory.connect({ expectedId: libraryId });
  return { entries, fingerprint: await fingerprint(entries) };
}
async function assertCurrent(prepared: Prepared) {
  const current = await prepared.repo.state(), before = prepared.state;
  requireKnowledge(current.epoch === before.epoch && current.sequence === before.sequence && current.libraryId === before.libraryId
    && (current.connectionRevision ?? 0) === (before.connectionRevision ?? 0), 'recovery_stale');
}
export async function previewDirectoryRecovery(repo: KnowledgeRepository, original: KnowledgeDirectory,
  expected: Pick<KnowledgeLocalMeta, 'epoch' | 'sequence' | 'connectionRevision' | 'libraryId'>) {
  const db = repo.database;
  const { state, files } = await db.transaction('r', db.okMeta, db.okFiles, async () => ({ state: await repo.state(), files: await db.okFiles.toArray() }));
  requireKnowledge(expected && state.epoch === expected.epoch && state.sequence === expected.sequence
    && state.libraryId === expected.libraryId && (state.connectionRevision ?? 0) === (expected.connectionRevision ?? 0), 'recovery_stale');
  requireKnowledge(state.libraryId, 'not_connected');
  const entries = new Map(files.map(file => [file.path, file.bytes]));
  await validateKnowledgeFiles(entries, state.libraryId);
  const pending = new Set(files.filter(file => file.pending === 1).map(file => file.path));
  const scanned = await scan(original, state.libraryId); let incompleteFiles = 0;
  for (const [path, bytes] of scanned.entries) {
    if (path === 'library.json') continue;
    const local = entries.get(path);
    if (!bytes.length) {
      // Rebuild only exact queued content in the new copy, never mutate the interrupted original.
      requireKnowledge(local?.length && pending.has(path), 'incomplete_write'); incompleteFiles++;
    } else if (local) requireKnowledge(same(local, bytes), 'integrity');
    else entries.set(path, bytes);
  }
  const summary = await validateKnowledgeFiles(entries, state.libraryId);
  const prepared = { repo, state, entries, original, fingerprint: scanned.fingerprint };
  await assertCurrent(prepared);
  const preview: Preview = { ...summary, incompleteFiles };
  previews.set(preview, prepared); return preview;
}
export async function validateDirectoryRecovery(repo: KnowledgeRepository, preview: object): Promise<void> {
  const prepared = previews.get(preview); requireKnowledge(prepared && prepared.repo === repo, 'recovery_preview');
  await assertCurrent(prepared);
  requireKnowledge((await scan(prepared.original, prepared.state.libraryId!)).fingerprint === prepared.fingerprint, 'recovery_stale');
}
export async function applyDirectoryRecovery(repo: KnowledgeRepository, preview: object,
  destination: KnowledgeDirectory, handle: KnowledgeDirectoryHandle | null = null): Promise<void> {
  const prepared = previews.get(preview); requireKnowledge(prepared && prepared.repo === repo, 'recovery_preview');
  previews.delete(preview);
  await assertCurrent(prepared);
  requireKnowledge((await scan(prepared.original, prepared.state.libraryId!)).fingerprint === prepared.fingerprint, 'recovery_stale');
  requireKnowledge((await destination.files.list('')).length === 0, 'recovery_destination');
  await destination.connect({ create: true, expectedId: prepared.state.libraryId! });
  for (const path of await orderKnowledgeFiles(prepared.entries)) {
    await assertCurrent(prepared); await destination.files.putImmutable(path, prepared.entries.get(path)!);
  }
  const written = await scan(destination, prepared.state.libraryId!);
  written.entries.delete('library.json');
  await validateKnowledgeFiles(written.entries, prepared.state.libraryId);
  requireKnowledge(await fingerprint(written.entries) === await fingerprint(prepared.entries), 'integrity');
  requireKnowledge((await scan(prepared.original, prepared.state.libraryId!)).fingerprint === prepared.fingerprint, 'recovery_stale');
  const db = repo.database;
  await db.transaction('rw', db.okMeta, db.okFiles, async () => {
    await assertCurrent(prepared);
    const current = await repo.state();
    for (const [path, bytes] of prepared.entries) {
      const previous = await db.okFiles.get(path);
      if (previous) {
        requireKnowledge(same(previous.bytes, bytes), 'integrity'); await db.okFiles.update(path, { pending: 0 });
      } else { current.sequence++; await db.okFiles.add({ path, bytes, pending: 0, sequence: current.sequence }); }
    }
    await db.okMeta.put({ ...current, sequence: current.sequence + 1, handle,
      connectionRevision: (current.connectionRevision ?? 0) + 1 });
  });
}
