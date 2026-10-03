import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { BiliAnalyticsDB } from '../src/background/storage/db.ts';
import { KnowledgeNotes } from '../src/background/storage/knowledge-notes.ts';
import { noteKey, captionContext, type CapturedNote } from '../src/shared/open-knowledge/captures.ts';
import { createSource, imageAttachment, parseSource } from '../src/shared/open-knowledge/sources.ts';
import { videoPageId } from '../src/shared/open-knowledge/format.ts';
const anchor = { bvid: 'BV1234567890', cid: '42', page: 1, title: '图文学习', timeMs: 1500, capturedAt: 10, method: 'frame' as const };
async function fixture(): Promise<CapturedNote> {
  const original = await createSource({ kind: 'subtitles', video: { bvid: anchor.bvid, cid: anchor.cid, page: 1, title: anchor.title },
    label: 'B站字幕', language: 'zh', version: 'original', capturedAt: 0, text: '之前\n正在解释\n接着说明',
    segments: [{ fromMs: 0, toMs: 1000, text: '之前' }, { fromMs: 1000, toMs: 2000, text: '正在解释' }, { fromMs: 2000, toMs: 5000, text: '接着说明' }],
    derivedFrom: null, legacyAsset: null });
  const optimized = await createSource({ ...original, kind: 'optimized-subtitles', label: 'AI 优化字幕', version: 'optimized', derivedFrom: original.id,
    text: '之前。\n正在解释。\n接着说明。', segments: original.segments.map(line => ({ ...line, text: line.text + '。' })) });
  const image = await imageAttachment(Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXfoAAAAASUVORK5CYII=', 'base64')));
  return { id: crypto.randomUUID(), key: noteKey(anchor), epoch: 0, version: 0, anchor, text: '', quote: '', sources: [original, optimized], images: [image], savedRevision: null, savedSource: null };
}
test('capture overlap excludes nearby captions and uncertain capture intervals', async () => {
  const note = await fixture(), context = captionContext(anchor, note.sources);
  assert.deepEqual(context.overlapping.map(line => line.text), ['正在解释']);
  assert.deepEqual(context.nearby.map(line => line.text), ['之前', '接着说明']);
  assert.equal(captionContext({ ...anchor, timeMs: 1900, endMs: 2100 }, note.sources).overlapping.length, 0);
  assert.deepEqual(await parseSource(JSON.stringify(note.sources[1])), note.sources[1]);
});
test('draft persists across restart; local save atomically retains original, optimized text and image; retry is idempotent', async () => {
  const db = new BiliAnalyticsDB('capture-' + crypto.randomUUID());
  try {
    let notes = new KnowledgeNotes(db), row = await notes.begin(await fixture());
    row = await notes.edit(row.id, 0, 0, '中文输入中的笔记');
    db.close(); await db.open(); notes = new KnowledgeNotes(db);
    assert.equal((await notes.load(row.key))?.text, '中文输入中的笔记');
    const receipt = await notes.save(row.id, row.epoch, row.version);
    assert.equal(receipt.status, 'local'); assert.equal((await notes.repo.readPage(receipt.pageId)).heads.length, 1);
    const priorCount = await db.okFiles.count();
    assert.equal((await notes.save(row.id, row.epoch, row.version)).revision, receipt.revision);
    assert.equal(await db.okFiles.count(), priorCount);
    const saved = (await notes.repo.readPage(receipt.pageId)).heads[0];
    assert.match(saved.body, /附近讲解（非该帧字幕）/);
    assert.equal(saved.attachmentIds.length, 1); assert.equal(saved.sourceIds.length, 3);
    assert.equal((await notes.repo.readSource(row.sources[0].id)).segments.length, 3);
    assert.deepEqual((await notes.repo.readAttachment(row.images[0].id)).bytes, row.images[0].bytes);
    await notes.finish(row.id, 0, row.version); assert.equal(await notes.load(row.key), null);
  } finally { db.close(); await db.delete(); }
});
test('no subtitles required; epoch changes prevent resurrection and drafts cannot overwrite concurrent edits', async () => {
  const db = new BiliAnalyticsDB('capture-' + crypto.randomUUID());
  try {
    const notes = new KnowledgeNotes(db), row = { ...await fixture(), sources: [], images: [] };
    await notes.begin(row); const next = await notes.edit(row.id, 0, 0, '无字幕也能记');
    await assert.rejects(notes.edit(row.id, 0, 0, '另一个标签页'), /draft_conflict/);
    await notes.save(next.id, 0, next.version);
    assert.match((await notes.repo.readPage(videoPageId(anchor.bvid))).heads[0].body, /无字幕也能记/);
    await notes.repo.clear();
    await assert.rejects(notes.begin(row), /stale_operation/);
    await assert.rejects(notes.save(row.id, 0, row.version), /stale_operation/);
    assert.equal(await db.okCaptures.count(), 0); assert.equal(await db.okFiles.count(), 0);
  } finally { db.close(); await db.delete(); }
});

test('adding text updates the unchanged image record but preserves an externally edited block', async () => {
  const db = new BiliAnalyticsDB('capture-' + crypto.randomUUID());
  try {
    const notes = new KnowledgeNotes(db), row = await notes.begin(await fixture());
    const first = await notes.save(row.id, 0, 0);
    const edited = await notes.edit(row.id, 0, 0, '截图后补充');
    await notes.save(edited.id, 0, edited.version);
    let current = (await notes.repo.readPage(first.pageId)).heads[0];
    assert.equal(current.body.match(/!\[/g)?.length, 1);
    assert.match(current.body, /截图后补充/);
    await notes.repo.save({ ...current, body: current.body.replace('截图后补充', '外部已确认修改') }, [current.id]);
    const again = await notes.edit(row.id, 0, edited.version, '新的补充');
    await notes.save(again.id, 0, again.version);
    current = (await notes.repo.readPage(first.pageId)).heads[0];
    assert.match(current.body, /外部已确认修改/);
    assert.match(current.body, /新的补充/);
    assert.equal(current.attachmentIds.length, 1);
  } finally { db.close(); await db.delete(); }
});
