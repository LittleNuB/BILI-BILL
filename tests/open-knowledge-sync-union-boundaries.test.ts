import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { BiliAnalyticsDB } from '../src/background/storage/db.ts';
import { KnowledgeRepository } from '../src/background/storage/open-knowledge-repo.ts';
import { createRevision, serializeRevision, textBytes, videoPageId,
  type KnowledgeActor, type KnowledgePage } from '../src/shared/open-knowledge/format.ts';
import { KnowledgeDirectory } from '../src/shared/open-knowledge/directory.ts';
import type { KnowledgeLocalFile } from '../src/shared/open-knowledge/local-state.ts';
import { MemoryKnowledgeFiles } from './helpers/knowledge-files.ts';

const MiB = 1024 * 1024;
const page = (index: number): KnowledgePage => {
  const bvid = `BV${String(index).padStart(10, '0')}`;
  return { pageId: videoPageId(bvid), kind: 'video', bvid, title: `Synthetic page ${index}`,
    body: '', aiNotes: '', topics: [], sourceIds: [], attachmentIds: [], legacyIds: [], createdAt: 1 };
};
async function revisionFile(input: KnowledgePage, parents: string[], body: string, updatedAt: number, actor: KnowledgeActor = 'browser') {
  const row = await createRevision({ ...input, body }, parents, actor, updatedAt);
  return { id: row.id, pageId: row.pageId, path: `pages/${row.pageId}/${row.id}.md`, bytes: textBytes(serializeRevision(row)) };
}
async function historySummary(reader: Pick<KnowledgeRepository, 'readPage'>, id: string) {
  const history = await reader.readPage(id);
  return { revisions: history.revisions.map(row => row.id).sort(), heads: history.heads.map(row => row.id).sort(), byteLength: history.byteLength };
}
async function fileIndex(db: BiliAnalyticsDB) {
  // Index-only reads avoid retaining another copy of the large synthetic bodies.
  return { paths: await db.okFiles.toCollection().primaryKeys(),
    pending: await db.okFiles.where('pending').equals(1).primaryKeys(),
    orderedPaths: await db.okFiles.orderBy('sequence').primaryKeys(),
    sequences: await db.okFiles.orderBy('sequence').keys() };
}

test('sync rejects a history byte union above 64 MiB while both sides remain readable and queued data is unchanged', async () => {
  const db = new BiliAnalyticsDB('sync-byte-union-' + crypto.randomUUID());
  const files = new MemoryKnowledgeFiles(), remote = new KnowledgeDirectory(files);
  try {
    const repo = new KnowledgeRepository(db); await repo.connect(remote);
    const input = page(1);
    const shared = await revisionFile(input, [], 'S'.repeat(3 * MiB), 1);
    const localFirst = await revisionFile(input, [shared.id], 'L'.repeat(15.5 * MiB), 2);
    const localHead = await revisionFile(input, [localFirst.id], 'l'.repeat(15.5 * MiB), 3);
    const remoteFirst = await revisionFile(input, [shared.id], 'R'.repeat(15.5 * MiB), 2, 'codex');
    const remoteHead = await revisionFile(input, [remoteFirst.id], 'r'.repeat(15.5 * MiB), 3, 'codex');
    await db.okFiles.bulkPut([shared, localFirst, localHead].map((file, index) => ({
      path: file.path, bytes: file.bytes, pending: 1 as const, sequence: index + 1,
    })));
    for (const file of [shared, remoteFirst, remoteHead]) files.data.set(file.path, file.bytes);
    await db.okMeta.put({ ...await repo.state(), epoch: 7, sequence: 3, connectionRevision: 11, migration: 'a'.repeat(64) });

    const localBefore = await historySummary(repo, input.pageId), remoteBefore = await historySummary(remote, input.pageId);
    assert.deepEqual(localBefore.revisions, [shared.id, localFirst.id, localHead.id].sort());
    assert.deepEqual(remoteBefore.revisions, [shared.id, remoteFirst.id, remoteHead.id].sort());
    assert.deepEqual(localBefore.heads, [localHead.id]); assert.deepEqual(remoteBefore.heads, [remoteHead.id]);
    assert.ok(localBefore.byteLength < 64 * MiB); assert.ok(remoteBefore.byteLength < 64 * MiB);
    assert.ok(localBefore.byteLength + remoteBefore.byteLength - shared.bytes.length > 64 * MiB);
    const stateBefore = await repo.state(), statusBefore = await repo.status(), indexBefore = await fileIndex(db);
    const remotePathsBefore = [...files.data.keys()].sort(), libraryBefore = files.data.get('library.json')!.slice();
    assert.equal(statusBefore.pending, 3);

    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(repo.sync(remote), /knowledge_capacity/);
      assert.deepEqual(await historySummary(repo, input.pageId), localBefore);
      assert.deepEqual(await historySummary(remote, input.pageId), remoteBefore);
      assert.deepEqual(await repo.state(), stateBefore); assert.deepEqual(await repo.status(), statusBefore);
      assert.deepEqual(await fileIndex(db), indexBefore);
      assert.deepEqual([...files.data.keys()].sort(), remotePathsBefore);
      assert.deepEqual(files.data.get('library.json'), libraryBefore);
      for (const file of [remoteFirst, remoteHead]) assert.equal(await db.okFiles.get(file.path), undefined);
      for (const file of [localFirst, localHead]) assert.equal(files.data.has(file.path), false);
    }
  } finally { db.close(); await db.delete(); }
});

test('sync rejects a 4097-page union of two legal 4096-page libraries without changing either library or its pending queue', async () => {
  const db = new BiliAnalyticsDB('sync-page-union-' + crypto.randomUUID());
  const files = new MemoryKnowledgeFiles(), remote = new KnowledgeDirectory(files);
  try {
    const repo = new KnowledgeRepository(db); await repo.connect(remote);
    const rows: KnowledgeLocalFile[] = [];
    let sharedId = '';
    for (let index = 1; index <= 4095; index++) {
      const file = await revisionFile(page(index), [], `Shared page ${index}`, 1);
      rows.push({ path: file.path, bytes: file.bytes, pending: index === 1 ? 1 : 0, sequence: index });
      files.data.set(file.path, file.bytes);
      if (index === 1) sharedId = file.pageId;
    }
    const localOnly = await revisionFile(page(4096), [], 'Offline-only page', 1);
    // The incoming page sorts first, so the failing pull cannot acknowledge shared files first.
    const remoteOnly = await revisionFile(page(0), [], 'Remote-only page', 1, 'codex');
    rows.push({ path: localOnly.path, bytes: localOnly.bytes, pending: 1, sequence: 4096 });
    await db.okFiles.bulkPut(rows); files.data.set(remoteOnly.path, remoteOnly.bytes);
    await db.okMeta.put({ ...await repo.state(), epoch: 9, sequence: 4096, connectionRevision: 13, migration: 'b'.repeat(64) });

    const localIdsBefore = await repo.pageIds(), remoteIdsBefore = await remote.pageIds();
    assert.equal(localIdsBefore.length, 4096); assert.equal(remoteIdsBefore.length, 4096);
    assert.equal(new Set([...localIdsBefore, ...remoteIdsBefore]).size, 4097);
    assert.equal(remoteIdsBefore[0], remoteOnly.pageId);
    const localBefore = await historySummary(repo, localOnly.pageId), remoteBefore = await historySummary(remote, remoteOnly.pageId);
    const sharedBefore = await historySummary(repo, sharedId);
    assert.deepEqual(localBefore.heads, [localOnly.id]); assert.deepEqual(remoteBefore.heads, [remoteOnly.id]);
    assert.deepEqual(await historySummary(remote, sharedId), sharedBefore);
    assert.deepEqual((await repo.readPage(remoteOnly.pageId)).revisions, []);
    assert.deepEqual((await remote.readPage(localOnly.pageId)).revisions, []);
    const stateBefore = await repo.state(), statusBefore = await repo.status(), indexBefore = await fileIndex(db);
    const remotePathsBefore = [...files.data.keys()].sort(), libraryBefore = files.data.get('library.json')!.slice();
    assert.equal(statusBefore.pending, 2);

    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(repo.sync(remote), /knowledge_capacity/);
      assert.deepEqual(await repo.pageIds(), localIdsBefore); assert.deepEqual(await remote.pageIds(), remoteIdsBefore);
      assert.deepEqual(await historySummary(repo, localOnly.pageId), localBefore);
      assert.deepEqual(await historySummary(remote, remoteOnly.pageId), remoteBefore);
      assert.deepEqual(await historySummary(repo, sharedId), sharedBefore);
      assert.deepEqual(await historySummary(remote, sharedId), sharedBefore);
      assert.deepEqual((await repo.readPage(remoteOnly.pageId)).revisions, []);
      assert.deepEqual((await remote.readPage(localOnly.pageId)).revisions, []);
      assert.deepEqual(await repo.state(), stateBefore); assert.deepEqual(await repo.status(), statusBefore);
      assert.deepEqual(await fileIndex(db), indexBefore);
      assert.deepEqual([...files.data.keys()].sort(), remotePathsBefore);
      assert.deepEqual(files.data.get('library.json'), libraryBefore);
      assert.equal(await db.okFiles.get(remoteOnly.path), undefined);
      assert.equal(files.data.has(localOnly.path), false);
    }
  } finally { db.close(); await db.delete(); }
});
