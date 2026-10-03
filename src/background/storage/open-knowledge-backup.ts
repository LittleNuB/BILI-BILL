import type { KnowledgeRepository } from './open-knowledge-repo.ts';
import { orderKnowledgeFiles, parseKnowledgeBackup, serializeKnowledgeBackup, validateKnowledgeFiles } from '../../shared/open-knowledge/backup.ts';
import { requireKnowledge } from '../../shared/open-knowledge/format.ts';

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const previews = new WeakMap<object, { entries: Map<string, Uint8Array>; libraryId: string | null; epoch: number; sequence: number }>();
async function snapshot(repo: KnowledgeRepository) {
  return repo.database.transaction('r', repo.database.okMeta, repo.database.okFiles, async () => ({
    state: await repo.state(), entries: new Map((await repo.database.okFiles.toArray()).map(row => [row.path, row.bytes])),
  }));
}
export async function exportKnowledgeBackup(repo: KnowledgeRepository) {
  const { state, entries } = await snapshot(repo); return serializeKnowledgeBackup(entries, state.libraryId);
}
export async function previewKnowledgeRestore(repo: KnowledgeRepository, text: string) {
  const parsed = await parseKnowledgeBackup(text), { state, entries } = await snapshot(repo);
  requireKnowledge(!state.libraryId || !parsed.libraryId || state.libraryId === parsed.libraryId, 'library_mismatch');
  let added = 0;
  for (const [path, bytes] of parsed.entries) {
    const existing = entries.get(path);
    if (existing) requireKnowledge(same(existing, bytes), 'integrity'); else { entries.set(path, bytes); added++; }
  }
  const libraryId = state.libraryId ?? parsed.libraryId, summary = await validateKnowledgeFiles(entries, libraryId);
  const preview = { ...summary, added, existingFiles: entries.size - added };
  previews.set(preview, { entries, libraryId, epoch: state.epoch, sequence: state.sequence }); return preview;
}
export async function applyKnowledgeRestore(repo: KnowledgeRepository, preview: object) {
  const prepared = previews.get(preview); requireKnowledge(prepared, 'restore_preview');
  const order = await orderKnowledgeFiles(prepared.entries), db = repo.database;
  await db.transaction('rw', db.okMeta, db.okFiles, async () => {
    const state = await repo.state();
    requireKnowledge(state.epoch === prepared.epoch && state.sequence === prepared.sequence, 'stale_operation');
    for (const path of order) if (!await db.okFiles.get(path)) {
      state.sequence++; await db.okFiles.add({ path, bytes: prepared.entries.get(path)!, pending: 1, sequence: state.sequence });
    }
    await db.okMeta.put({ ...state, libraryId: prepared.libraryId });
  });
  previews.delete(preview);
}
