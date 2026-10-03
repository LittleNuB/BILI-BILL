import assert from 'node:assert/strict';
import test from 'node:test';
import { createRevision, parseRevision, serializeRevision, videoPageId } from '../src/shared/open-knowledge/format.ts';
import { KnowledgeDirectory } from '../src/shared/open-knowledge/directory.ts';
import { MemoryKnowledgeFiles } from './helpers/knowledge-files.ts';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeKnowledgeFiles } from '../packages/open-knowledge/node-files.mjs';
import { safeKnowledgePath } from '../src/shared/open-knowledge/directory.ts';
import { createSource, imageAttachment } from '../src/shared/open-knowledge/sources.ts';

test('ordinary Markdown round trip preserves Chinese notes, AI sections and source identities', async () => {
  const row = await createRevision({
    pageId: videoPageId('BV1234567890'), kind: 'video', bvid: 'BV1234567890', title: '学习组合设计',
    body: '## 我的笔记\n\n组合减少耦合。\n\n```js\nconst value = 1;\n```', aiNotes: '待验证的补充说明',
    topics: ['软件设计'], sourceIds: [], attachmentIds: [], legacyIds: [], createdAt: 1,
  }, [], 'browser', 2);
  const text = serializeRevision(row);
  assert.ok(text.startsWith('---\nbili_bill: '));
  assert.ok(text.includes('## 我的笔记'));
  assert.deepEqual(await parseRevision(text), row);
  assert.deepEqual(await parseRevision(text.replace(/\n/g, '\r\n')), row);
  await assert.rejects(parseRevision(text.replace('减少耦合', '不需要测试')), /integrity/);
});

test('source originals remain immutable and optimized subtitles cannot alter their timeline', async () => {
  const files = new MemoryKnowledgeFiles(), directory = new KnowledgeDirectory(files);
  const input = { kind: 'subtitles' as const, video: { bvid: 'BV1234567890', title: '合成视频', cid: '1', page: 1 },
    label: 'B站字幕', language: 'zh-CN', version: 'sample', capturedAt: 1, text: '他说组合',
    segments: [{ fromMs: 1000, toMs: 2000, text: '他说组合' }], derivedFrom: null, legacyAsset: null };
  const original = await createSource(input); await directory.putSource(original);
  const improved = await createSource({ ...input, kind: 'optimized-subtitles', text: '他说，组合。',
    segments: [{ fromMs: 1000, toMs: 2000, text: '他说，组合。' }], derivedFrom: original.id });
  await directory.putSource(improved);
  assert.equal((await directory.readSource(original.id)).text, '他说组合');
  await assert.rejects(directory.putSource(await createSource({ ...input, kind: 'optimized-subtitles',
    segments: [{ fromMs: 0, toMs: 2000, text: '伪造时间' }], derivedFrom: original.id })), /timeline/);
  await assert.rejects(directory.putSource({ ...original, text: '改写的原文' }), /integrity/);
  await assert.rejects(imageAttachment(new TextEncoder().encode('<svg onload="alert(1)"></svg>')), /image_type/);
});

test('Node adapter round trips the shared library and rejects traversal and links outside its scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bb-knowledge-test-'));
  try {
    const files = await NodeKnowledgeFiles.open(root), directory = new KnowledgeDirectory(files);
    const library = await directory.connect({ create: true });
    assert.equal((await directory.connect({ expectedId: library.id })).id, library.id);
    await assert.rejects(directory.connect({ expectedId: crypto.randomUUID() }), /library_mismatch/);
    for (const path of ['../outside.md', '/absolute.md', 'C:/Key.txt', 'pages/../library.json', 'sources\\x.json', 'con.json']) {
      assert.throws(() => safeKnowledgePath(path), /path/);
      await assert.rejects(files.read(path), /path/);
    }
    await writeFile(join(root, 'outside.txt'), 'must not read');
    await symlink(root, join(root, 'sources'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(files.read('sources/' + 'a'.repeat(64) + '.json'), /link|scope/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('retries are idempotent; concurrent offline edits preserve both heads and can be resolved', async () => {
  const directory = new KnowledgeDirectory(new MemoryKnowledgeFiles());
  await directory.connect({ create: true });
  const first = await createRevision({ pageId: videoPageId('BV1234567890'), kind: 'video', bvid: 'BV1234567890',
    title: '共享知识', body: '原笔记', aiNotes: '', topics: [], sourceIds: [], attachmentIds: [], legacyIds: [], createdAt: 1 }, [], 'browser', 1);
  await directory.append(first); await directory.append(first);
  const a = await createRevision({ ...first, body: '浏览器补充' }, [first.id], 'browser', 2);
  const b = await createRevision({ ...first, body: 'Codex 补充' }, [first.id], 'codex', 3);
  await directory.append(a);
  await assert.rejects(directory.append(b), /conflict/);
  await directory.append(b, { preserveConflict: true });
  assert.deepEqual(new Set((await directory.readPage(first.pageId)).heads.map(row => row.body)), new Set(['浏览器补充', 'Codex 补充']));
  const resolved = await createRevision({ ...first, body: '两边的补充都保留' }, [a.id, b.id], 'browser', 4);
  await directory.append(resolved);
  assert.deepEqual((await directory.readPage(first.pageId)).heads.map(row => row.id), [resolved.id]);
  assert.equal((await directory.readPage(first.pageId)).revisions.length, 4);
});
