import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { BiliAnalyticsDB } from '../src/background/storage/db.ts';
import { KnowledgeRepository } from '../src/background/storage/open-knowledge-repo.ts';
import { createRevision, serializeRevision, textBytes, videoPageId } from '../src/shared/open-knowledge/format.ts';
import { KnowledgeDirectory, requireHistoryCapacity, KNOWLEDGE_HISTORY_MAX_BYTES, KNOWLEDGE_MAX_REVISIONS } from '../src/shared/open-knowledge/directory.ts';
import { MemoryKnowledgeFiles } from './helpers/knowledge-files.ts';
import { knowledgeError } from '../src/shared/open-knowledge/workspace.ts';

test('empty revision is reported as incomplete without overwriting it or hiding local data', async () => {
  const files = new MemoryKnowledgeFiles(), id = videoPageId('BV1234567890');
  const path = `pages/${id}/${'a'.repeat(64)}.md`;
  files.data.set(path, new Uint8Array());
  await assert.rejects(new KnowledgeDirectory(files).readPage(id), /knowledge_incomplete_write/);
  assert.equal(files.data.get(path)?.length, 0);
  assert.match(knowledgeError(new Error('knowledge_incomplete_write')), /本地记录与待同步内容仍保留/);
  assert.match(knowledgeError(new Error('knowledge_incomplete_write')), /恢复说明/);
});

test('directory readers and transactional union checks share exact count and byte limits', () => {
  assert.doesNotThrow(() => requireHistoryCapacity(KNOWLEDGE_MAX_REVISIONS, KNOWLEDGE_HISTORY_MAX_BYTES));
  assert.throws(() => requireHistoryCapacity(KNOWLEDGE_MAX_REVISIONS + 1, 0), /knowledge_capacity/);
  assert.throws(() => requireHistoryCapacity(2, KNOWLEDGE_HISTORY_MAX_BYTES + 1), /knowledge_capacity/);
});

test('sync rejects an oversized history union atomically and preserves both branches and the offline queue', async () => {
  const db = new BiliAnalyticsDB('knowledge-sync-union-capacity');
  const files = new MemoryKnowledgeFiles(), remote = new KnowledgeDirectory(files);
  try {
    await db.open();
    const repo = new KnowledgeRepository(db);
    await repo.connect(remote);
    const page = { pageId: videoPageId('BV1234567890'), kind: 'video' as const, bvid: 'BV1234567890',
      title: 'History capacity', body: 'Shared material', aiNotes: '', topics: [], sourceIds: [], attachmentIds: [], legacyIds: [], createdAt: 1 };
    let row = await createRevision(page, [], 'browser', 1);
    const shared = [];
    for (let i = 0; i < 1999; i++) {
      if (i) row = await createRevision(row, [row.id], 'browser', i + 1);
      const path = `pages/${row.pageId}/${row.id}.md`, bytes = textBytes(serializeRevision(row));
      shared.push({ path, bytes, pending: 0 as const, sequence: i + 1 });
      files.data.set(path, bytes);
    }
    const local = await createRevision({ ...row, body: 'Offline edit' }, [row.id], 'browser', 2000);
    const other = await createRevision({ ...row, body: 'Other edit' }, [row.id], 'browser', 2000);
    const localPath = `pages/${local.pageId}/${local.id}.md`;
    const otherPath = `pages/${other.pageId}/${other.id}.md`;
    await db.okFiles.bulkPut([...shared, { path: localPath, bytes: textBytes(serializeRevision(local)), pending: 1, sequence: 2000 }]);
    await db.okMeta.put({ ...await repo.state(), sequence: 2000 });
    files.data.set(otherPath, textBytes(serializeRevision(other)));
    const before = await repo.state();
    assert.equal((await repo.readPage(row.pageId)).revisions.length, 2000);
    assert.equal((await remote.readPage(row.pageId)).revisions.length, 2000);
    await assert.rejects(repo.sync(remote), /knowledge_capacity/);
    assert.equal((await repo.readPage(row.pageId)).heads[0].id, local.id);
    assert.equal((await remote.readPage(row.pageId)).heads[0].id, other.id);
    assert.equal(await db.okFiles.get(otherPath), undefined);
    assert.equal((await db.okFiles.get(localPath))?.pending, 1);
    assert.equal((await repo.status()).pending, 1);
    assert.deepEqual(await repo.state(), before);
    await assert.rejects(repo.sync(remote), /knowledge_capacity/);
    assert.equal((await repo.readPage(row.pageId)).revisions.length, 2000);
  } finally { db.close(); await db.delete(); }
});
