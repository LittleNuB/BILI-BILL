import type { KnowledgeRepository } from './open-knowledge-repo.ts';
import { digest, requireKnowledge, textBytes } from '../../shared/open-knowledge/format.ts';
import { REFERENCE_MAX_BYTES, REFERENCES_MAX_BYTES, type KnowledgeReadonlyReference, type ReadonlyMarkdownHandle } from '../../shared/open-knowledge/references.ts';

async function read(handle: ReadonlyMarkdownHandle, request = false) {
  let permission = await handle.queryPermission({ mode: 'read' });
  if (permission !== 'granted' && request) permission = await handle.requestPermission({ mode: 'read' });
  requireKnowledge(permission === 'granted', 'permission');
  const file = await handle.getFile();
  requireKnowledge(/\.md$/i.test(file.name) && file.size <= REFERENCE_MAX_BYTES, 'capacity');
  const bytes = new Uint8Array(await file.arrayBuffer()), text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return { text, digest: await digest(bytes), name: file.name, available: true, checkedAt: Date.now() };
}
export async function addReadonlyReferences(repo: KnowledgeRepository, handles: ReadonlyMarkdownHandle[]) {
  requireKnowledge(handles.length > 0 && handles.length <= 64, 'capacity');
  const before = await repo.state(), rows = await repo.database.okReferences.toArray();
  for (const handle of handles) {
    let duplicate = false;
    for (const row of rows) { try { if (await handle.isSameEntry(row.handle)) { duplicate = true; break; } } catch { /* A removed reference does not block another selected file. */ } }
    if (duplicate) continue;
    rows.push({ id: crypto.randomUUID(), handle, ...await read(handle) });
  }
  requireKnowledge(rows.length <= 64 && rows.reduce((sum, row) => sum + textBytes(row.text).length, 0) <= REFERENCES_MAX_BYTES, 'capacity');
  await repo.database.transaction('rw', repo.database.okMeta, repo.database.okReferences, async () => {
    const state = await repo.state(); requireKnowledge(state.epoch === before.epoch && state.sequence === before.sequence, 'stale_operation');
    await repo.database.okReferences.bulkPut(rows); await repo.database.okMeta.put({ ...state, sequence: state.sequence + 1 });
  });
}
export async function refreshReadonlyReferences(repo: KnowledgeRepository, request = false): Promise<KnowledgeReadonlyReference[]> {
  const before = await repo.state(), rows = await repo.database.okReferences.toArray();
  const next: KnowledgeReadonlyReference[] = []; let total = 0;
  for (const row of rows) {
    try { const value = await read(row.handle, request); total += textBytes(value.text).length;
      requireKnowledge(total <= REFERENCES_MAX_BYTES, 'capacity'); next.push({ ...row, ...value }); }
    catch { next.push({ ...row, available: false, text: '', checkedAt: Date.now() }); }
  }
  if (rows.some((row, index) => row.available !== next[index].available || row.digest !== next[index].digest || row.name !== next[index].name)) {
    await repo.database.transaction('rw', repo.database.okMeta, repo.database.okReferences, async () => {
      const state = await repo.state(); requireKnowledge(state.epoch === before.epoch && state.sequence === before.sequence, 'stale_operation');
      await repo.database.okReferences.bulkPut(next); await repo.database.okMeta.put({ ...state, sequence: state.sequence + 1 });
    });
  }
  return next;
}
export async function removeReadonlyReference(repo: KnowledgeRepository, id: string) {
  await repo.database.transaction('rw', repo.database.okMeta, repo.database.okReferences, async () => {
    const state = await repo.state(); await repo.database.okReferences.delete(id);
    await repo.database.okMeta.put({ ...state, sequence: state.sequence + 1 });
  });
}
