import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { BiliAnalyticsDB } from '../src/background/storage/db.ts';
import { KnowledgeRepository } from '../src/background/storage/open-knowledge-repo.ts';
import { createRevision, videoPageId } from '../src/shared/open-knowledge/format.ts';
import { KnowledgeDirectory } from '../src/shared/open-knowledge/directory.ts';
import { MemoryKnowledgeFiles } from './helpers/knowledge-files.ts';
import { createSource, imageAttachment } from '../src/shared/open-knowledge/sources.ts';
import type { LearningAsset } from '../src/shared/learning.ts';

const page = () => ({ pageId: videoPageId('BV1234567890'), kind: 'video' as const, bvid: 'BV1234567890', title: '持久笔记',
  body: '离线也能保存', aiNotes: '', topics: [], sourceIds: [], attachmentIds: [], legacyIds: [], createdAt: 1 });
test('offline save survives restart, reconnect flushes once and external edits return to browser', async () => {
  const db = new BiliAnalyticsDB('open-knowledge-tests'), remote = new KnowledgeDirectory(new MemoryKnowledgeFiles());
  try {
    await db.delete(); await db.open(); const repo = new KnowledgeRepository(db);
    const first = await repo.save(page(), []);
    assert.equal((await repo.status()).pending, 1);
    db.close(); await db.open();
    assert.equal((await repo.readPage(first.pageId)).heads[0].body, '离线也能保存');
    await repo.connect(remote); await repo.sync(remote); await repo.sync(remote);
    assert.equal((await repo.status()).pending, 0);
    const external = await createRevision({ ...first, body: 'Codex 补充了实践结论' }, [first.id], 'codex', first.updatedAt + 1);
    await remote.append(external); await repo.sync(remote);
    assert.equal((await repo.readPage(first.pageId)).heads[0].body, 'Codex 补充了实践结论');
  } finally { db.close(); await db.delete(); }
});

test('permission failure keeps queued data; remote conflict never loses either note', async () => {
  const db = new BiliAnalyticsDB('knowledge-conflict-tests'), files = new MemoryKnowledgeFiles(), remote = new KnowledgeDirectory(files);
  try {
    await db.delete(); await db.open(); const repo = new KnowledgeRepository(db);
    const first = await repo.save(page(), []); await repo.connect(remote);
    files.failWrites = true; await assert.rejects(repo.sync(remote), /permission/);
    assert.equal((await repo.status()).pending, 1); files.failWrites = false; await repo.sync(remote);
    const offline = await repo.save({ ...first, body: '离线修改' }, [first.id]);
    await remote.append(await createRevision({ ...first, body: '外部修改' }, [first.id], 'codex', first.updatedAt + 1));
    await repo.sync(remote);
    assert.equal((await repo.readPage(first.pageId)).heads.length, 2);
    assert.equal((await remote.readPage(first.pageId)).heads.length, 2);
    assert.ok((await repo.readPage(first.pageId)).heads.some(row => row.id === offline.id));
    const other = new KnowledgeDirectory(new MemoryKnowledgeFiles()); await other.connect({ create: true });
    await assert.rejects(repo.connect(other), /library_mismatch/);
  } finally { db.close(); await db.delete(); }
});

test('source/image and page commit together; a failed save cannot retain new full subtitles', async () => {
  const db = new BiliAnalyticsDB('knowledge-atomic-tests');
  try {
    await db.delete(); await db.open(); const repo = new KnowledgeRepository(db);
    const source = await createSource({ kind: 'subtitles', video: { bvid: 'BV1234567890', title: '合成视频', cid: '1', page: 1 },
      label: 'B站字幕', language: 'zh-CN', version: 'sample', capturedAt: 1, text: '原始讲解',
      segments: [{ fromMs: 1000, toMs: 2000, text: '原始讲解' }], derivedFrom: null, legacyAsset: null });
    await assert.rejects(repo.save({ ...page(), sourceIds: [source.id], attachmentIds: ['a'.repeat(64)] }, [], { sources: [source] }), /missing_image/);
    await assert.rejects(repo.readSource(source.id), /missing_source/);
    assert.equal((await repo.status()).pending, 0);
    const image = await imageAttachment(Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXfoAAAAASUVORK5CYII=', 'base64')));
    const row = await repo.save({ ...page(), sourceIds: [source.id], attachmentIds: [image.id] }, [], { sources: [source], attachments: [image] });
    assert.equal((await repo.readPage(row.pageId)).heads[0].sourceIds[0], source.id);
    assert.deepEqual((await repo.readAttachment(image.id)).bytes, image.bytes);
  } finally { db.close(); await db.delete(); }
});

test('legacy migration preserves original IDs, snapshots and topic decisions and is idempotent', async () => {
  const db = new BiliAnalyticsDB('knowledge-migration-tests');
  try {
    await db.delete(); await db.open(); const repo = new KnowledgeRepository(db);
    const asset: LearningAsset = { id: 'b'.repeat(64), kind: 'bookmark', createdAt: 1, updatedAt: 2,
      video: { bvid: 'BV1234567890', title: '旧视频' }, part: { cid: '1', page: 1 },
      personal: { title: '旧笔记', note: '保留的内容', tags: ['设计'] }, snapshot: null, bookmarkMs: 1234, importedFrom: null };
    await db.lgAssets.put(asset);
    await db.lgWiki.put({ key: 'state', revision: 1, pages: [{ bvid: asset.video.bvid, createdAt: 1, deleted: false }],
      topics: [{ id: 'topic-1', name: '我的主题', term: null, manualName: true }],
      relations: [{ bvid: asset.video.bvid, topicId: 'topic-1', mode: 'include' }] });
    assert.equal(await repo.migrateLegacy(), 1);
    assert.equal(await repo.migrateLegacy(), 0);
    const migrated = (await repo.readPage(videoPageId(asset.video.bvid))).heads[0];
    assert.deepEqual(migrated.legacyIds, [asset.id]); assert.ok(migrated.topics.includes('我的主题'));
    const sources = await Promise.all(migrated.sourceIds.map(id => repo.readSource(id)));
    assert.deepEqual(sources.find(row => row.kind === 'legacy')?.legacyAsset, asset);
    assert.ok(sources.some(row => row.text.includes('topic-1')));
    assert.deepEqual(await db.lgAssets.get(asset.id), asset);
  } finally { db.close(); await db.delete(); }
});

test('clearing during a delayed directory read fences late writes and forgets persisted drafts', async () => {
  const db = new BiliAnalyticsDB('knowledge-clear-tests'), files = new MemoryKnowledgeFiles(), remote = new KnowledgeDirectory(files);
  try {
    await db.delete(); await db.open(); const repo = new KnowledgeRepository(db);
    const first = await repo.save(page(), []); await repo.saveDraft('video-a', '未完成的中文草稿');
    await repo.connect(remote); await repo.sync(remote);
    let release!: () => void, ready!: () => void;
    const waiting = new Promise<void>(resolve => { ready = resolve; });
    const pause = new Promise<void>(resolve => { release = resolve; });
    const original = remote.readPage.bind(remote);
    remote.readPage = async id => { const result = await original(id); ready(); await pause; return result; };
    const sync = repo.sync(remote); await waiting; await repo.clear(); release();
    await assert.rejects(sync, /stale_operation/);
    assert.deepEqual(await repo.pageIds(), []); assert.equal(await repo.draft('video-a'), '');
    assert.equal((await original(first.pageId)).heads.length, 1);
  } finally { db.close(); await db.delete(); }
});
