import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { BiliAnalyticsDB } from '../src/background/storage/db.ts';
import { KnowledgeRepository } from '../src/background/storage/open-knowledge-repo.ts';
import { exportKnowledgeBackup, previewKnowledgeRestore, applyKnowledgeRestore } from '../src/background/storage/open-knowledge-backup.ts';
import { parseKnowledgeBackup } from '../src/shared/open-knowledge/backup.ts';
import { personalPage } from '../src/shared/open-knowledge/workspace.ts';
import { createSource, imageAttachment } from '../src/shared/open-knowledge/sources.ts';
import { createRevision, jsonBytes, textBytes, serializeRevision } from '../src/shared/open-knowledge/format.ts';
import { createProposal } from '../src/shared/open-knowledge/proposals.ts';
import { KnowledgeDirectory } from '../src/shared/open-knowledge/directory.ts';
import { MemoryKnowledgeFiles } from './helpers/knowledge-files.ts';

async function fixture(t: test.TestContext) {
  const db = new BiliAnalyticsDB('knowledge-backup-' + crypto.randomUUID());
  t.after(async () => { db.close(); await db.delete(); });
  const repo = new KnowledgeRepository(db);
  const source = await createSource({ kind: 'external', video: null, label: '合成原始资料', language: null, version: '1',
    capturedAt: 1, text: '备份不能覆盖原文。', segments: [], derivedFrom: null, legacyAsset: null });
  const image = await imageAttachment(Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXfoAAAAASUVORK5CYII=', 'base64')));
  const row = await repo.save({ ...personalPage('学习图片'), body: '中文笔记', sourceIds: [source.id], attachmentIds: [image.id] }, [], { sources: [source], attachments: [image] });
  return { db, repo, row, image, source };
}
test('backup restores originals, images, proposals and history; queue can reconstruct a new empty directory', async t => {
  const { repo, db, row, image, source } = await fixture(t);
  const remote = new KnowledgeDirectory(new MemoryKnowledgeFiles()); await repo.connect(remote); await repo.sync(remote);
  const proposal = await createProposal({ libraryId: (await repo.state()).libraryId!, pageId: row.pageId, base: [row.id],
    next: { ...row, body: '共同维护后的内容' }, reason: '合成宿主确认', kind: 'edit', restoreId: null, createdAt: Date.now() });
  await remote.files.putImmutable(`proposals/${proposal.id}.json`, jsonBytes(proposal));
  const updated = await createRevision(proposal.next, [row.id], 'codex', Date.now(), proposal.id);
  await remote.append(updated); await repo.sync(remote);
  await repo.saveDraft('not-exported', '草稿不属于已保存资料');
  const backup = await exportKnowledgeBackup(repo);
  assert.doesNotMatch(backup, /not-exported|handle|apiKey/);
  await repo.clear();
  const preview = await previewKnowledgeRestore(repo, backup); assert.equal(preview.images, 1); assert.equal(preview.versions, 2);
  assert.equal(await db.okFiles.count(), 0);
  await applyKnowledgeRestore(repo, preview);
  assert.equal((await repo.readPage(row.pageId)).heads[0].body, updated.body);
  assert.deepEqual((await repo.readAttachment(image.id)).bytes, image.bytes);
  assert.equal((await repo.readSource(source.id)).text, source.text);
  assert.equal((await repo.readProposal(proposal.id)).id, proposal.id);
  assert.equal((await previewKnowledgeRestore(repo, backup)).added, 0);
  const rebuilt = new KnowledgeDirectory(new MemoryKnowledgeFiles()); await repo.connect(rebuilt); await repo.sync(rebuilt);
  assert.equal((await repo.status()).pending, 0); assert.equal((await rebuilt.readPage(row.pageId)).revisions.length, 2);
  assert.deepEqual((await rebuilt.readAttachment(image.id)).bytes, image.bytes);
  await assert.rejects(applyKnowledgeRestore(repo, preview), /restore_preview/);
});
test('restore is additive, preserves concurrent heads and rejects stale approval after edit or clear', async t => {
  const { repo, row } = await fixture(t);
  const fork = await createRevision({ ...row, body: '另一份离线修改' }, [row.id], 'browser');
  const bundle = JSON.parse(await exportKnowledgeBackup(repo));
  bundle.files.push({ path: `pages/${row.pageId}/${fork.id}.md`, base64: Buffer.from(textBytes(serializeRevision(fork))).toString('base64') });
  const preview = await previewKnowledgeRestore(repo, JSON.stringify(bundle));
  const current = await repo.save({ ...row, body: '当前新内容' }, [row.id]);
  await assert.rejects(applyKnowledgeRestore(repo, preview), /stale_operation/);
  const fresh = await previewKnowledgeRestore(repo, JSON.stringify(bundle)); assert.equal(fresh.conflicts, 1);
  await applyKnowledgeRestore(repo, fresh);
  assert.deepEqual(new Set((await repo.readPage(row.pageId)).heads.map(r => r.id)), new Set([current.id, fork.id]));
  const last = await previewKnowledgeRestore(repo, JSON.stringify(bundle)); await repo.clear();
  await assert.rejects(applyKnowledgeRestore(repo, last), /stale_operation/); assert.deepEqual(await repo.pageIds(), []);
});
test('invalid backup paths, missing images, corruption and duplicate names never write partial data', async t => {
  const { repo, db } = await fixture(t), original = JSON.parse(await exportKnowledgeBackup(repo)), count = await db.okFiles.count();
  for (const mutate of [
    (x: any) => { x.files[0].path = '../../outside.md'; },
    (x: any) => { x.files = x.files.filter((r: any) => !r.path.startsWith('attachments/')); },
    (x: any) => { x.files[0].base64 = Buffer.from('corrupt').toString('base64'); },
    (x: any) => { x.files.push(x.files[0]); },
    (x: any) => { x.extra = true; },
  ]) {
    const copy = structuredClone(original); mutate(copy);
    await assert.rejects(previewKnowledgeRestore(repo, JSON.stringify(copy))); assert.equal(await db.okFiles.count(), count);
  }
  await assert.rejects(parseKnowledgeBackup('not json'));
  await assert.rejects(applyKnowledgeRestore(repo, {}), /restore_preview/);
});
