import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { BiliAnalyticsDB } from '../src/background/storage/db.ts';
import { KnowledgeNotes } from '../src/background/storage/knowledge-notes.ts';
import { KnowledgeRepository } from '../src/background/storage/open-knowledge-repo.ts';
import { validateLearningAsset, type LearningAsset } from '../src/shared/learning.ts';
import { emptyWiki, type WikiState } from '../src/shared/video-wiki.ts';
import { noteKey, type CapturedNote } from '../src/shared/open-knowledge/captures.ts';
import { createRevision, videoPageId } from '../src/shared/open-knowledge/format.ts';
import { legacyMigration } from '../src/shared/open-knowledge/migration.ts';
import { parseSource } from '../src/shared/open-knowledge/sources.ts';

const bvid = 'BV1234567890';
const tag = (index: number) => `tag-${String(index).padStart(3, '0')}`;
const tags = (start: number, count: number) => Array.from({ length: count }, (_, index) => tag(start + index));
const asset = (index: number, labels: string[]): LearningAsset => ({
  id: String(index).padStart(64, '0'), kind: 'note', createdAt: index, updatedAt: index + 10,
  video: { bvid, title: 'Synthetic legacy video' }, part: { cid: '123', page: 2 },
  personal: { title: `Legacy note ${index}`, note: `Original note ${index}`, tags: labels },
  snapshot: null, bookmarkMs: null, importedFrom: null,
});
const overflowingAssets = () => [asset(1, tags(0, 43)), asset(2, tags(43, 43)), asset(3, tags(86, 43))];

test('Wiki includes take stable priority without losing excluded relations or overflow tags', async () => {
  const assets = [asset(1, tags(0, 64)), asset(2, tags(64, 64))];
  const wiki: WikiState = { key: 'state', revision: 7,
    pages: [{ bvid, createdAt: 0, deleted: false }],
    topics: [
      { id: 'topic-3', name: 'tag-000', term: 'original-term', manualName: false },
      { id: 'topic-2', name: 'wiki-b', term: null, manualName: true },
      { id: 'topic-1', name: 'wiki-a', term: null, manualName: true },
      { id: 'topic-4', name: 'wiki-excluded', term: null, manualName: true },
    ],
    relations: [
      { bvid, topicId: 'topic-1', mode: 'include' },
      { bvid, topicId: 'topic-2', mode: 'include' },
      { bvid, topicId: 'topic-3', mode: 'include' },
      { bvid, topicId: 'topic-4', mode: 'exclude' },
    ],
  };
  const before = structuredClone({ assets, wiki });
  const [item] = await legacyMigration(assets, wiki);
  const revision = await createRevision(item.page, [], 'migration', item.updatedAt);
  assert.deepEqual(revision.topics, ['wiki-a', 'wiki-b', ...tags(0, 126)]);
  assert.match(revision.body, /128 \/ 130/);
  assert.ok(!revision.topics.includes('wiki-excluded'));
  const organization = item.sources.find(source => source.kind === 'external')!;
  assert.deepEqual(JSON.parse(organization.text), wiki);
  assert.ok(revision.body.includes(`../../sources/${organization.id}.json`));
  assert.deepEqual(item.sources.filter(source => source.kind === 'legacy').map(source => source.legacyAsset), assets);
  assert.deepEqual(await legacyMigration([...assets].reverse(), wiki), [item]);
  const [reordered] = await legacyMigration(assets, { ...wiki, topics: [...wiki.topics].reverse(), relations: [...wiki.relations].reverse() });
  assert.deepEqual(reordered.page.topics, revision.topics);
  assert.deepEqual({ assets, wiki }, before);
});
test('129 distinct legacy tags migrate into a bounded index with every original and reference intact', async () => {
  const assets = overflowingAssets();
  assets.forEach(validateLearningAsset);
  const migration = await legacyMigration(assets, emptyWiki());
  assert.equal(migration.length, 1);
  const { page, sources, updatedAt } = migration[0];
  const revision = await createRevision(page, [], 'migration', updatedAt);
  assert.deepEqual(revision.topics, tags(0, 128));
  assert.deepEqual(revision.legacyIds, assets.map(row => row.id));
  assert.deepEqual(revision.sourceIds, sources.map(row => row.id));
  assert.match(revision.body, /128 \/ 129/);
  assert.match(revision.body, /\[.+?\]\(\.\.\/\.\.\/sources\/[a-f0-9]{64}\.json\)/);
  const originals = sources.filter(source => source.kind === 'legacy');
  assert.deepEqual(originals.map(source => source.legacyAsset), assets);
  for (const source of sources) assert.deepEqual(await parseSource(JSON.stringify(source)), source);
  for (const source of originals) {
    assert.deepEqual(source.video, { ...source.legacyAsset!.video, cid: '123', page: 2 });
    assert.ok(revision.body.includes(`../../sources/${source.id}.json`));
    assert.ok(revision.body.includes(source.legacyAsset!.personal.note));
  }
  assert.ok(originals[2].legacyAsset!.personal.tags.includes('tag-128'));
  assert.ok(!revision.topics.includes('tag-128'));
  assert.ok(revision.body.includes(`../../sources/${sources[0].id}.json`));
});

test('duplicate tags and Wiki names use one index slot and exactly 128 needs no overflow notice', async () => {
  const assets = [asset(1, tags(0, 64)), asset(2, tags(64, 64)), asset(3, tags(0, 64)), asset(4, tags(64, 64))];
  const wiki: WikiState = { key: 'state', revision: 1,
    pages: [{ bvid, createdAt: 0, deleted: false }],
    topics: [
      { id: 'duplicate-1', name: 'tag-000', term: null, manualName: true },
      { id: 'duplicate-2', name: 'tag-000', term: null, manualName: true },
    ],
    relations: [
      { bvid, topicId: 'duplicate-1', mode: 'include' },
      { bvid, topicId: 'duplicate-2', mode: 'include' },
    ],
  };
  const [item] = await legacyMigration(assets, wiki);
  const revision = await createRevision(item.page, [], 'migration', item.updatedAt);
  assert.deepEqual(revision.topics, tags(0, 128));
  assert.doesNotMatch(revision.body, /^## /m);
  assert.deepEqual(item.sources.filter(source => source.kind === 'legacy').map(source => source.legacyAsset), assets);
  assert.deepEqual(JSON.parse(item.sources[0].text), wiki);
});

test('overflow migration keeps its receipt, revision and originals unchanged on retry and restart', async () => {
  const db = new BiliAnalyticsDB('migration-overflow-' + crypto.randomUUID());
  try {
    const assets = overflowingAssets(), wiki = emptyWiki();
    await db.lgAssets.bulkPut(assets); await db.lgWiki.put(wiki);
    let repo = new KnowledgeRepository(db);
    assert.equal(await repo.migrateLegacy(), 1);
    const state = await repo.state(), status = await repo.status(), page = await repo.readPage(videoPageId(bvid));
    assert.match(state.migration!, /^[a-f0-9]{64}$/);
    assert.equal(page.revisions.length, 1);
    assert.equal(page.heads[0].topics.length, 128);
    assert.equal(await repo.migrateLegacy(), 0);
    assert.deepEqual(await repo.state(), state);
    assert.deepEqual(await repo.status(), status);
    db.close(); await db.open(); repo = new KnowledgeRepository(db);
    assert.equal(await repo.migrateLegacy(), 0);
    assert.deepEqual(await repo.state(), state);
    assert.deepEqual(await repo.status(), status);
    assert.deepEqual(await repo.readPage(videoPageId(bvid)), page);
    assert.deepEqual(await db.lgAssets.toArray(), assets);
    assert.deepEqual(await db.lgWiki.get('state'), wiki);
    for (const id of page.heads[0].sourceIds) {
      const source = await repo.readSource(id);
      if (source.kind === 'legacy') assert.deepEqual(source.legacyAsset, assets.find(row => row.id === source.legacyAsset!.id));
    }
  } finally { db.close(); await db.delete(); }
});

test('saving a new note automatically migrates overflow without blocking either the same or another video', async t => {
  for (const target of [bvid, 'BV0987654321']) await t.test(target, async () => {
    const db = new BiliAnalyticsDB('migration-overflow-save-' + crypto.randomUUID());
    try {
      const assets = overflowingAssets(); await db.lgAssets.bulkPut(assets);
      const notes = new KnowledgeNotes(db);
      const anchor = { bvid: target, cid: '123', page: 2, title: 'Synthetic new note', timeMs: 5000, capturedAt: 100, method: 'note' as const };
      const draft: CapturedNote = { id: crypto.randomUUID(), key: noteKey(anchor), epoch: 0, version: 0, anchor,
        text: 'New note after migration', quote: '', sources: [], images: [], savedRevision: null, savedSource: null };
      await notes.begin(draft);
      const receipt = await notes.save(draft.id, draft.epoch, draft.version);
      assert.equal(receipt.status, 'local');
      assert.equal(receipt.pageId, videoPageId(target));
      const saved = (await notes.repo.readPage(receipt.pageId)).heads;
      assert.equal(saved.length, 1);
      assert.equal(saved[0].id, receipt.revision);
      assert.match(saved[0].body, /New note after migration/);
      const migrated = (await notes.repo.readPage(videoPageId(bvid))).heads[0];
      assert.deepEqual(migrated.topics, tags(0, 128));
      assert.deepEqual(migrated.legacyIds, assets.map(row => row.id));
      assert.match(migrated.body, /128 \/ 129/);
      const originals = await Promise.all(migrated.sourceIds.map(id => notes.repo.readSource(id)));
      assert.deepEqual(originals.filter(source => source.kind === 'legacy').map(source => source.legacyAsset), assets);
      const state = await notes.repo.state(), status = await notes.repo.status();
      assert.equal(await notes.repo.migrateLegacy(), 0);
      assert.deepEqual(await notes.save(draft.id, draft.epoch, draft.version), receipt);
      assert.deepEqual(await notes.repo.state(), state);
      assert.deepEqual(await notes.repo.status(), status);
      assert.deepEqual(await db.lgAssets.toArray(), assets);
    } finally { db.close(); await db.delete(); }
  });
});
