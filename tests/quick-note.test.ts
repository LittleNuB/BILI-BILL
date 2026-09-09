import 'fake-indexeddb/auto';
import test from 'node:test';
import { BiliAnalyticsDB } from '../src/background/storage/db.ts';
import { LearningRepository } from '../src/background/storage/learning-repo.ts';
import assert from 'node:assert/strict';
import { QuickNotes } from '../src/content/player-monitor/quick-note.ts';
import { resolveLearningSelection } from '../src/shared/learning-selection.ts';
import { buildCurrentVideoSubtitleViewingSource } from '../src/shared/current-video-subtitle-view.ts';
import { validateLearningAsset, type LearningPrepared, type LearningSourceRequest } from '../src/shared/learning.ts';

const key = 'BV1234567890:42:1';
const prepared = (): LearningPrepared => ({ epoch: 0, capture: { token: 'a'.repeat(64), kind: 'bookmark', video: { bvid: 'BV1234567890', title: '测试' }, part: { cid: '42', page: 1 }, bookmarkMs: 12500 } });
test('empty note saves a valid timestamp asset without AI; duplicate clicks cannot submit twice', async () => {
  const notes = new QuickNotes(); const row = notes.begin(key, 12500, null); const calls: string[] = [];
  const request = async <T>(action: string, params: Record<string, unknown>): Promise<T> => {
    calls.push(action);
    if (action === 'LEARNING_PREPARE') { assert.equal(params.positionMs, 12500); return prepared() as T; }
    validateLearningAsset(params.asset); assert.equal(params.asset.personal.note, ''); return true as T;
  };
  await Promise.all([notes.save(key, request), notes.save(key, request)]);
  assert.deepEqual(calls, ['LEARNING_PREPARE', 'LEARNING_SAVE']); assert.equal(notes.get(key), undefined); assert.equal(row.status, '已保存');
});
test('uncertain save retains identical ID/content for retry and does not replace the original timestamp', async () => {
  const notes = new QuickNotes(); const row = notes.begin(key, 12500, null); row.text = '保留原稿'; const attempts: unknown[] = [];
  const request = async <T>(action: string, params: Record<string, unknown>): Promise<T> => {
    if (action === 'LEARNING_PREPARE') return prepared() as T;
    attempts.push(structuredClone(params)); if (attempts.length === 1) throw Error('连接中断'); return true as T;
  };
  await notes.save(key, request); assert.equal(row.text, '保留原稿'); assert.ok(row.pending);
  assert.equal(notes.begin(key, 99000, null).timeMs, 12500);
  await notes.save(key, request); assert.deepEqual(attempts[0], attempts[1]);
});
test('committed write with lost acknowledgement survives repository restart and confirms without duplicate insertion', async () => {
  const db = new BiliAnalyticsDB(`quick-note-${crypto.randomUUID()}`);
  let repo = new LearningRepository(db); const notes = new QuickNotes(); notes.begin(key, 12500, null).text = '已提交但回执丢失';
  let writes = 0; let sourceChecks = 0;
  try {
    const request = async <T>(action: string, params: Record<string, unknown>): Promise<T> => {
      if (action === 'LEARNING_PREPARE') return prepared() as T;
      const row = await repo.save(params.epoch as number, params.asset, { assertCurrent: async () => { sourceChecks++; } });
      if (++writes === 1) throw Error('连接中断'); return row as T;
    };
    await notes.save(key, request); const checks = sourceChecks; const revision = (await repo.state()).meta.revision;
    assert.ok(notes.get(key)!.pending); db.close(); await db.open(); repo = new LearningRepository(db);
    await notes.save(key, request);
    assert.equal(notes.get(key), undefined); assert.equal((await repo.state()).assets.length, 1);
    assert.equal((await repo.state()).meta.revision, revision); assert.equal(sourceChecks, checks);
  } finally { db.close(); await db.delete(); }
});
test('video mismatch cannot save and drafts are isolated and bounded without eviction', async () => {
  const notes = new QuickNotes(); notes.begin(key, 12500, null).text = '原视频';
  const request = async <T>(action: string): Promise<T> => { assert.equal(action, 'LEARNING_PREPARE'); const p = prepared(); p.capture.part!.cid = '43'; return p as T; };
  await notes.save(key, request); assert.match(notes.get(key)!.status, /视频已变化/);
  for (let i = 0; i < 15; i++) notes.begin(`other-${i}`, 0, null);
  assert.throws(() => notes.begin('overflow', 0, null), /草稿已满/); assert.equal(notes.get(key)!.text, '原视频');
});
test('unreadable time does not invent a timestamp or issue a save', async () => {
  const notes = new QuickNotes(); notes.begin(key, null, null);
  await notes.save(key, async () => { throw Error('must not request'); }); assert.match(notes.get(key)!.status, /未能读取/);
  assert.equal(notes.begin(key, 12000, null).timeMs, 12000);
});
function selectionFixture() {
  const view = buildCurrentVideoSubtitleViewingSource({ bvid: 'BV1234567890', cid: 42, page: 1, source: 'bilibili_subtitle', sourceType: 'bilibili_player_wbi_v2', language: 'zh-CN',
    lines: [{ lineId: 'one', startSeconds: 1, endSeconds: 3, text: '首先明确问题' }, { lineId: 'two', startSeconds: 3, endSeconds: 6, text: '然后验证假设' }] })!;
  const request: LearningSourceRequest = { origin: 'subtitle', sourceIdentityKey: view.identity.sourceIdentityKey,
    subtitleSelection: { lines: view.lines.map(line => ({ id: line.lineId, binding: line.lineBindingKey })), start: 2, end: 4 } };
  return { view, request };
}
test('multi-line selection keeps exact offsets, original text and real line time ranges', () => {
  const { view, request } = selectionFixture(); const snapshot = resolveLearningSelection(request, view);
  assert.equal(snapshot.body, '明确问题\n然后验证'); assert.deepEqual(snapshot.citations.map(c => [c.fromMs, c.toMs]), [[1000, 3000], [3000, 6000]]);
});
test('stale, noncontiguous, reordered and invalid-offset selections cannot become evidence', () => {
  const { view, request } = selectionFixture();
  const invalid = [ { ...request, sourceIdentityKey: 'other' },
    { ...request, subtitleSelection: { ...request.subtitleSelection!, start: -1 } },
    { ...request, subtitleSelection: { ...request.subtitleSelection!, end: 99 } },
    { ...request, subtitleSelection: { ...request.subtitleSelection!, lines: [...request.subtitleSelection!.lines].reverse() } } ];
  for (const item of invalid) assert.throws(() => resolveLearningSelection(item, view), /stale_capture/);
});
test('selected note uses revalidated snapshot while personal text remains separate', async () => {
  const { view, request: source } = selectionFixture(); const snapshot = resolveLearningSelection(source, view);
  const notes = new QuickNotes(); notes.begin(key, 12500, { source, text: snapshot.body, timeMs: 1000 }).text = '我自己的想法';
  await notes.save(key, async <T>(action: string, params: Record<string, unknown>): Promise<T> => {
    if (action === 'LEARNING_PREPARE_SOURCE') { const p = prepared(); p.capture.kind = 'note'; p.capture.bookmarkMs = null; p.snapshot = snapshot; return p as T; }
    validateLearningAsset(params.asset); assert.equal(params.asset.kind, 'excerpt'); assert.equal(params.asset.snapshot?.body, snapshot.body); assert.equal(params.asset.personal.note, '我自己的想法'); return true as T;
  });
  assert.equal(notes.get(key), undefined);
});
