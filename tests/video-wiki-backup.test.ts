import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeLearningBackup } from '../src/shared/learning-backup.ts';
import { type LearningAsset } from '../src/shared/learning.ts';
import { type WikiState } from '../src/shared/video-wiki.ts';
import {
  WIKI_MAX_FILE_BYTES,
  decodeWikiBackup,
  encodeWikiBackup,
} from '../src/shared/video-wiki-backup.ts';

const asset = (id: string, bvid: string): LearningAsset => ({
  id: id.repeat(64),
  kind: 'excerpt',
  createdAt: 1,
  updatedAt: 1,
  video: { bvid, title: `学习视频 ${bvid}` },
  part: { cid: '123', page: 1 },
  personal: { title: '摘录', note: '备注', tags: ['学习'] },
  bookmarkMs: null,
  importedFrom: null,
  snapshot: {
    origin: 'subtitle',
    body: '合成原句',
    source: { kind: 'bilibili', hash: 'b'.repeat(64) },
    citations: [{ fromMs: 1000, toMs: 2000, text: '合成原句' }],
  },
});

const assets = [asset('b', 'BV0987654321'), asset('a', 'BV1234567890')];
const wiki = (): WikiState => ({
  key: 'state',
  revision: 4,
  pages: [
    { bvid: 'BV0987654321', createdAt: 2, deleted: false },
    { bvid: 'BV1111111111', createdAt: 3, deleted: false },
    { bvid: 'BV1234567890', createdAt: 1, deleted: false },
  ],
  topics: [
    { id: 'release', name: '交付', term: '交付' },
    { id: 'quality', name: '质量', term: null },
  ],
  relations: [
    { topicId: 'release', bvid: 'BV1234567890', mode: 'include' },
    { topicId: 'quality', bvid: 'BV0987654321', mode: 'exclude' },
  ],
});

const canonicalWiki = (): WikiState => ({
  ...wiki(),
  topics: [
    { id: 'quality', name: '质量', term: null },
    { id: 'release', name: '交付', term: '交付' },
  ],
  relations: [
    { topicId: 'quality', bvid: 'BV0987654321', mode: 'exclude' },
    { topicId: 'release', bvid: 'BV1234567890', mode: 'include' },
  ],
});

test('joint backup embeds the unchanged learning v1 object and preserves a legal empty video page', async () => {
  const text = await encodeWikiBackup(assets, wiki());
  const parsed = JSON.parse(text);
  assert.deepEqual(Object.keys(parsed), ['format', 'version', 'learning', 'wiki']);
  assert.equal(parsed.format, 'bili-bill-learning-wiki');
  assert.equal(parsed.version, 1);
  assert.equal(JSON.stringify(parsed.learning), await encodeLearningBackup(assets));
  assert.equal(text, await encodeWikiBackup([...assets].reverse(), wiki()));

  const decoded = await decodeWikiBackup(new Blob([text]));
  assert.deepEqual(decoded.assets, [...assets].reverse());
  assert.deepEqual(decoded.wiki, canonicalWiki());
});

test('old learning v1 packages remain assets-only', async () => {
  const text = await encodeLearningBackup(assets);
  assert.deepEqual(await decodeWikiBackup(new Blob([text])), {
    assets: [...assets].reverse(),
    wiki: null,
  });
});

test('joint backup rejects noncanonical outer fields and malformed organization state', async () => {
  const text = await encodeWikiBackup(assets, wiki());
  const reordered = JSON.stringify({
    wiki: JSON.parse(text).wiki,
    learning: JSON.parse(text).learning,
    version: 1,
    format: 'bili-bill-learning-wiki',
  });
  for (const invalid of [
    text.replace(',"wiki":', ',"extra":true,"wiki":'),
    text.replace('"version":1,', '"version":1,"version":1,'),
    reordered,
  ]) {
    await assert.rejects(decodeWikiBackup(new Blob([invalid])));
  }

  const learning = await encodeLearningBackup(assets);
  const malformedWiki = wiki();
  malformedWiki.relations[0]!.topicId = 'missing-topic';
  const invalidWiki = `{"format":"bili-bill-learning-wiki","version":1,"learning":${learning},"wiki":${JSON.stringify(malformedWiki)}}`;
  await assert.rejects(decodeWikiBackup(new Blob([invalidWiki])), /wiki_format/);
});

test('joint backup rejects oversized input and observes cancellation', async () => {
  await assert.rejects(
    decodeWikiBackup(new Blob([new Uint8Array(WIKI_MAX_FILE_BYTES + 1)])),
    /file_size/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(encodeWikiBackup(assets, wiki(), controller.signal), /cancelled/);
  await assert.rejects(
    decodeWikiBackup(new Blob([await encodeWikiBackup(assets, wiki())]), controller.signal),
    /cancelled/,
  );
});
