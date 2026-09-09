import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import Dexie from 'dexie';
import { BiliAnalyticsDB } from '../src/background/storage/db.ts';
import { LearningRepository } from '../src/background/storage/learning-repo.ts';
import { VideoWikiRepository, wikiVersion, wikiMarkdown } from '../src/background/storage/video-wiki-repo.ts';
import { emptyWiki, WIKI_MAX_PAGES, validateWiki } from '../src/shared/video-wiki.ts';
import type { LearningAsset } from '../src/shared/learning.ts';
const database = new BiliAnalyticsDB('wiki-repo-tests');
const learning = new LearningRepository(database), wiki = new VideoWikiRepository(database);
const asset = (n: number, bvid = 'BV1234567890', page = 1): LearningAsset => ({ id: n.toString(16).padStart(64, '0'), kind: 'note', createdAt: n + 1, updatedAt: n + 1,
  video: { bvid, title: '合成学习视频' }, part: { cid: String(page), page }, personal: { title: '交付实践', note: '稳定交付需要明确需求和测试验证。', tags: [] },
  snapshot: null, bookmarkMs: null, importedFrom: null });
const save = async (row: LearningAsset, epoch?: number) => learning.save(epoch ?? (await learning.state()).meta.epoch, row, { assertCurrent: async () => {} });
test.beforeEach(async () => { database.close(); await database.delete(); await database.open(); });
test.afterEach(async () => { database.close(); await database.delete(); });

test('fresh database and browsing stay empty; first committed save creates one page across parts', async () => {
  assert.equal((await wiki.view()).pages.length, 0);
  await save(asset(1)); await save(asset(2, 'BV1234567890', 2));
  const view = await wiki.view(); assert.equal(view.pages.length, 1); assert.equal(view.pages[0].count, 2);
  assert.equal(view.state.pages.length, 1); assert.equal((await wiki.state()).assets[1].part?.page, 2);
});
test('failed source check creates neither content nor Wiki page', async () => {
  await assert.rejects(learning.save(0, asset(1), { assertCurrent: async () => { throw Error('stale_capture'); } }));
  assert.equal((await learning.state()).assets.length, 0); assert.equal((await wiki.view()).pages.length, 0);
});
test('default page deletion preserves assets, rejects old capture and idempotent retry, and survives restart', async () => {
  await save(asset(1)); const view = await wiki.view();
  await wiki.removePage(wikiVersion(view), asset(1).video.bvid);
  database.close(); await database.open();
  assert.equal((await wiki.view()).pages.length, 0); assert.equal((await learning.state()).assets.length, 1);
  await assert.rejects(save(asset(1), view.epoch), /stale_epoch/);
  await assert.rejects(save(asset(2), view.epoch), /stale_epoch/);
  await save(asset(1)); assert.equal((await wiki.view()).pages.length, 0);
  await save(asset(2)); assert.equal((await wiki.view()).pages[0].count, 2);
});
test('deletion during pending source check prevents late write and unrelated captures share the barrier', async () => {
  await save(asset(1)); const before = await wiki.view();
  let release!: () => void, started!: () => void;
  const block = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { started = resolve; });
  const pending = learning.save(before.epoch, asset(2), { assertCurrent: async () => { started(); await block; } });
  await ready; await wiki.removePage(wikiVersion(before), asset(1).video.bvid); release();
  await assert.rejects(pending, /stale_epoch/);
  await assert.rejects(save(asset(3, 'BV0987654321'), before.epoch), /stale_epoch/);
  assert.equal((await learning.state()).assets.length, 1); assert.equal((await wiki.view()).pages.length, 0);
});
test('delete with content confirmation is scoped and cannot apply from a stale preview', async () => {
  await save(asset(1)); await save(asset(2, 'BV0987654321')); const before = await wiki.view();
  await save(asset(3)); await assert.rejects(wiki.removePage(wikiVersion(before), asset(1).video.bvid, true), /stale_wiki/);
  await wiki.removePage(wikiVersion(await wiki.view()), asset(1).video.bvid, true);
  assert.deepEqual((await learning.state()).assets.map(row => row.id), [asset(2).id]);
});
test('one asset edited elsewhere remains the same Wiki content and stale edits do not overwrite it', async () => {
  const row = await save(asset(1)); const before = await wiki.view();
  const changed = await learning.edit(before.epoch, row.id, row, { ...row.personal, note: '在学习列表修改的内容' });
  assert.equal((await wiki.state()).assets[0].personal.note, changed.personal.note);
  await assert.rejects(learning.edit(before.epoch, row.id, row, { ...row.personal, note: '过时编辑' }), /stale_edit/);
  assert.equal((await wiki.state()).assets.length, 1);
});
test('manual topic decisions persist, competing previews fail, and recreation discards old membership', async () => {
  await save(asset(1)); await save(asset(2, 'BV0987654321'));
  const id = await wiki.changeTopic(wikiVersion(await wiki.view()), { action: 'create', name: '我的工程实践' });
  const version = wikiVersion(await wiki.view());
  await wiki.changeTopic(version, { action: 'relation', id, bvid: asset(1).video.bvid, mode: 'include' });
  await assert.rejects(wiki.changeTopic(version, { action: 'rename', id, name: '旧窗口名称' }), /stale_wiki/);
  database.close(); await database.open(); assert.ok((await wiki.view()).topics.find(topic => topic.id === id)?.bvids.includes(asset(1).video.bvid));
  await wiki.removePage(wikiVersion(await wiki.view()), asset(1).video.bvid); await save(asset(3));
  assert.deepEqual((await wiki.view()).topics.find(topic => topic.id === id)?.bvids, []);
});
test('Wiki capacity failure rolls back new asset and never evicts tombstones', async () => {
  const state = emptyWiki(); state.pages = Array.from({ length: WIKI_MAX_PAGES }, (_, i) => ({ bvid: `BV${String(i).padStart(10, '0')}`, createdAt: 1, deleted: true }));
  validateWiki(state); await database.lgWiki.put(state);
  await assert.rejects(save(asset(1)), /wiki_capacity/);
  assert.equal((await learning.state()).assets.length, 0); assert.equal((await wiki.state()).wiki.pages.length, WIKI_MAX_PAGES);
});
test('returning a topic to automatic releases untouched manual state but preserves explicit names', async () => {
  await save(asset(1)); await save(asset(2, 'BV0987654321'));
  const topic = (await wiki.view()).topics.find(topic => topic.automatic)!;
  await wiki.changeTopic(wikiVersion(await wiki.view()), { action: 'relation', id: topic.id, bvid: asset(1).video.bvid, mode: 'include' });
  assert.equal((await wiki.view()).state.topics.length, 1);
  await wiki.changeTopic(wikiVersion(await wiki.view()), { action: 'relation', id: topic.id, bvid: asset(1).video.bvid, mode: 'automatic' });
  assert.equal((await wiki.view()).state.topics.length, 0);
  assert.equal((await wiki.view()).topics.find(row => row.id === topic.id)?.automatic, true);
  await wiki.changeTopic(wikiVersion(await wiki.view()), { action: 'rename', id: topic.id, name: '用户确认的名称' });
  await wiki.changeTopic(wikiVersion(await wiki.view()), { action: 'relation', id: topic.id, bvid: asset(1).video.bvid, mode: 'automatic' });
  assert.equal((await wiki.view()).state.topics[0].name, '用户确认的名称');
});
test('ordinary asset restore never resurrects deleted Wiki pages or creates a new organization page', async () => {
  await save(asset(1)); await wiki.removePage(wikiVersion(await wiki.view()), asset(1).video.bvid);
  await learning.restore((await learning.state()).meta.epoch, [asset(2), asset(3, 'BV0987654321')]);
  assert.equal((await wiki.view()).pages.length, 0);
});
test('joint restore is atomic, replaces organization only after a current preview and invalidates earlier captures', async () => {
  await save(asset(1)); const organization = (await wiki.state()).wiki; const version = wikiVersion(await wiki.view());
  await wiki.removePage(version, asset(1).video.bvid);
  await assert.rejects(wiki.restore(version, [], organization), /stale_wiki/);
  const next = wikiVersion(await wiki.view()); await wiki.restore(next, [asset(2)], organization);
  assert.equal((await wiki.view()).pages[0].count, 2); await assert.rejects(save(asset(3), next.epoch), /stale_epoch/);
  const withEmpty = structuredClone(organization); withEmpty.pages.push({ bvid: 'BV8888888888', createdAt: 1, deleted: false });
  await wiki.restore(wikiVersion(await wiki.view()), [], withEmpty);
  assert.equal((await wiki.view()).pages.find(page => page.bvid === 'BV8888888888')?.count, 0);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(wiki.restore(wikiVersion(await wiki.view()), [asset(3)], organization, abort.signal), /cancelled/);
  assert.equal((await learning.state()).assets.length, 2);
});
test('legacy restore with a preview rejects later asset deletion and organization edits', async () => {
  await save(asset(1)); const before = await wiki.view();
  const options = { expectedRevision: before.assetRevision, expectedWikiRevision: before.state.revision };
  await learning.remove(before.epoch, asset(1).id);
  await assert.rejects(learning.restore(before.epoch, [asset(1)], options), /stale_preview/);
  assert.equal((await learning.state()).assets.length, 0);
  const after = await wiki.view();
  await wiki.changeTopic(wikiVersion(after), { action: 'create', name: '另一个窗口的主题' });
  await assert.rejects(learning.restore(after.epoch, [asset(1)], { expectedRevision: after.assetRevision, expectedWikiRevision: after.state.revision }), /stale_preview/);
  assert.equal((await learning.state()).assets.length, 0);
});
test('learning clear removes organization and advances the barrier; Markdown uses only saved content', async () => {
  await save(asset(1)); const text = wikiMarkdown(asset(1).video.bvid, (await wiki.state()).assets);
  assert.match(text, /稳定交付/); assert.match(text, /bilibili.com\/video\/BV1234567890/); assert.doesNotMatch(text, /Cookie|apiKey/);
  const meta = (await learning.state()).meta; await learning.clear(meta.epoch, meta.revision);
  assert.deepEqual((await wiki.state()).wiki.pages, []); await assert.rejects(save(asset(2), meta.epoch), /stale_epoch/);
});
test('clear preview cannot silently discard a later manual topic edit', async () => {
  await save(asset(1)); const before = await wiki.view();
  await wiki.changeTopic(wikiVersion(before), { action: 'create', name: '后来建立的主题' });
  await assert.rejects(learning.clear(before.epoch, before.assetRevision, before.state.revision), /stale_clear/);
  assert.equal((await learning.state()).assets.length, 1);
  assert.equal((await wiki.view()).state.topics[0].name, '后来建立的主题');
});
test('v14 upgrade admits only already-saved assets once; reopening v15 never reconstructs a deleted page', async () => {
  database.close(); await database.delete();
  const old = new Dexie(database.name); old.version(14).stores({ lgAssets: 'id', lgMeta: 'key' });
  await old.open(); await old.table('lgAssets').put(asset(1)); old.close();
  await database.open(); assert.equal((await wiki.view()).pages.length, 1);
  await wiki.removePage(wikiVersion(await wiki.view()), asset(1).video.bvid); database.close(); await database.open();
  assert.equal((await wiki.view()).pages.length, 0); assert.equal((await learning.state()).assets.length, 1);
});
