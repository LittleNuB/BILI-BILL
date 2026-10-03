import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { BiliAnalyticsDB } from '../src/background/storage/db.ts';
import { KnowledgeRepository } from '../src/background/storage/open-knowledge-repo.ts';
import { personalPage, listKnowledge, importFavoriteItems, restoreKnowledge } from '../src/shared/open-knowledge/workspace.ts';
import { videoPageId } from '../src/shared/open-knowledge/format.ts';
import { createSource } from '../src/shared/open-knowledge/sources.ts';

test('personal pages retain their identity, support bounded search and restore without losing history', async () => {
  const db = new BiliAnalyticsDB('knowledge-workspace-personal');
  try {
    await db.delete(); await db.open(); const repo = new KnowledgeRepository(db);
    const first = await repo.save({ ...personalPage('接口设计'), body: '幂等请求的实践经验', topics: ['工程'] }, []);
    const second = await repo.save({ ...first, body: '新的实践结论' }, [first.id]);
    assert.equal((await listKnowledge(repo, { query: '新的', topic: '工程' }))[0].head.id, second.id);
    const restored = await restoreKnowledge(repo, first, [second.id]);
    assert.equal(restored.body, first.body); assert.equal(restored.actor, 'restore');
    assert.equal((await repo.readPage(first.pageId)).revisions.length, 3);
    await assert.rejects(restoreKnowledge(repo, second, [first.id]), /conflict/);
  } finally { db.close(); await db.delete(); }
});

test('explicit Markdown sources are searchable as bounded excerpts and stale drafts cannot survive clearing', async () => {
  const db = new BiliAnalyticsDB('knowledge-workspace-markdown');
  try {
    await db.delete(); await db.open(); const repo = new KnowledgeRepository(db);
    const original = '# 设计笔记\n\n' + '说明。'.repeat(1000) + '一致性模型' + '说明。'.repeat(1000);
    const source = await createSource({ kind: 'external', video: null, label: '设计.md', language: null, version: 'original',
      capturedAt: 1, text: original, segments: [], derivedFrom: null, legacyAsset: null });
    await repo.save({ ...personalPage('参考文档'), sourceIds: [source.id] }, [], { sources: [source] });
    const results = await listKnowledge(repo, { query: '一致性模型' });
    assert.equal(results.length, 1); assert.equal(results[0].matchSourceId, source.id); assert.ok(results[0].excerpt.length <= 220);
    assert.equal((await repo.readSource(source.id)).text, original);
    const epoch = (await repo.state()).epoch;
    await repo.saveDraft('edit:test', '保留的草稿', epoch); await repo.clear();
    await assert.rejects(repo.saveDraft('edit:test', '过期的修改', epoch), /stale/);
    assert.equal(await repo.draft('edit:test'), '');
  } finally { db.close(); await db.delete(); }
});

test('selected favorite imports are metadata only, idempotent and never erase notes or absent items', async () => {
  const db = new BiliAnalyticsDB('knowledge-workspace-favorites');
  try {
    await db.delete(); await db.open(); const repo = new KnowledgeRepository(db);
    const folder = { mediaId: 12, title: '我的学习资料' };
    const item = { bvid: 'BV1234567890', title: '视频一', authorName: '讲师', duration: 100, cover: 'https://i0.hdslb.com/a.jpg' };
    assert.equal((await importFavoriteItems(repo, folder, [item])).imported, 1);
    assert.equal((await importFavoriteItems(repo, folder, [item])).unchanged, 1);
    assert.equal((await listKnowledge(repo)).length, 0);
    assert.equal((await listKnowledge(repo, { includeMetadata: true })).length, 1);
    const first = (await repo.readPage(videoPageId(item.bvid))).heads[0];
    await repo.save({ ...first, body: '我的理解', title: '我自己的标题' }, [first.id]);
    await importFavoriteItems(repo, folder, [{ ...item, title: '平台的新标题' }]);
    await importFavoriteItems(repo, folder, []);
    const updated = (await repo.readPage(first.pageId)).heads[0];
    assert.equal(updated.body, '我的理解'); assert.equal(updated.title, '我自己的标题');
    assert.equal((await listKnowledge(repo)).length, 1);
    assert.equal(updated.sourceIds.length, 1);
    assert.equal((await repo.readSource(updated.sourceIds[0])).segments.length, 0);
    assert.equal((await repo.readPage(first.pageId)).revisions.length, 3);
  } finally { db.close(); await db.delete(); }
});
