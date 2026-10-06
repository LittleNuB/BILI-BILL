import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenQuickNotes, type OpenQuickNote } from '../src/content/player-monitor/knowledge-notes.ts';
import type { NoteAnchor } from '../src/shared/open-knowledge/captures.ts';

const anchor: NoteAnchor = { bvid: 'BV1234567890', cid: '42', page: 1, title: '合成视频', timeMs: 12500, capturedAt: 1, method: 'note' };
const key = 'BV1234567890:42:1';
function fixture() {
  const rows = new Map<string, NonNullable<OpenQuickNote['remote']>>();
  const calls: Record<string, unknown>[] = [];
  let fail = false;
  const request = async <T>(params: Record<string, unknown>): Promise<T> => {
    calls.push(structuredClone(params));
    if (params.mode === 'epoch') return 0 as T;
    if (params.mode === 'load') return null as T;
    if (params.mode === 'begin') {
      const row = { id: params.id as string, key, epoch: 0, version: 1, anchor: params.anchor as NoteAnchor, text: '', quote: '', sources: [],
        images: params.image ? [{ id: 'image', data: params.image as string }] : [], savedRevision: null, savedSource: null,
        captions: { overlapping: [], nearby: [] } };
      rows.set(params.id as string, row); return structuredClone(row) as T;
    }
    const row = rows.get(params.id as string)!;
    if (params.mode === 'edit') { row.text = params.text as string; row.version++; return structuredClone(row) as T; }
    if (params.mode === 'save') {
      if (fail) throw Error('合成写入失败');
      row.savedRevision = 'saved'; return { revision: 'saved', status: 'local' } as T;
    }
    if (params.mode === 'finish') { rows.delete(params.id as string); return undefined as T; }
    throw Error(`Unexpected mode: ${params.mode}`);
  };
  return { notes: new OpenQuickNotes(request, () => anchor, () => {}), calls, failSave: () => { fail = true; }, allowSave: () => { fail = false; } };
}

test('chat image preserves the active note text, quote, timestamp and identity', async () => {
  const { notes, calls } = fixture();
  const quote = { text: '固定原字幕', timeMs: 1000, source: { origin: 'subtitle' as const, sourceIdentityKey: 'synthetic' } };
  const draft = notes.begin(key, 12500, quote); draft.text = '尚未提交的中文笔记';
  await notes.flush(key);
  const captured = await notes.image(key, { ...anchor, timeMs: 99000, method: 'frame' }, 'synthetic-image', undefined, true);
  assert.equal(notes.get(key), draft); assert.equal(draft.text, '尚未提交的中文笔记');
  assert.equal(draft.timeMs, 1000); assert.deepEqual(draft.quote, quote);
  assert.notEqual(captured.id, draft.id); assert.equal(captured.remote?.savedRevision, 'saved');
  assert.equal(calls.filter(call => call.mode === 'save').length, 1);
  assert.equal(calls.filter(call => call.mode === 'finish').length, 1);
  assert.equal(calls.find(call => call.mode === 'finish')?.id, captured.id);
  assert.equal(calls.some(call => String(call.mode).includes('ASK')), false);
  await notes.save(key); assert.equal(notes.get(key), undefined);
});

test('failed chat image does not replace or freeze the original note; retry stays on the original note', async () => {
  const { notes, failSave, allowSave, calls } = fixture();
  const draft = notes.begin(key, 12500, null); draft.text = '保留原稿'; await notes.flush(key);
  failSave();
  const captured = await notes.image(key, { ...anchor, method: 'upload' }, 'synthetic-image', undefined, true);
  assert.equal(captured.remote?.savedRevision, null); assert.match(captured.status, /失败/);
  assert.equal(notes.get(key), draft); assert.equal(draft.pending, false); assert.equal(draft.busy, false);
  allowSave(); await notes.save(key);
  assert.equal(calls.filter(call => call.mode === 'save').at(-1)?.id, draft.id);
});

test('note screenshot still becomes the editable note and saves only once per click', async () => {
  const { notes, calls } = fixture();
  const captured = await notes.image(key, { ...anchor, timeMs: 16000, method: 'frame' }, 'synthetic-image');
  assert.equal(notes.get(key), captured); assert.equal(captured.timeMs, 16000);
  assert.equal(calls.filter(call => call.mode === 'save').length, 1);
});

test('empty composer re-render cannot restore an in-flight chat image as its note draft', async () => {
  let notes: OpenQuickNotes;
  let loadingCalls = 0;
  let finish: (() => void) | undefined;
  const pause = new Promise<void>(resolve => { finish = resolve; });
  const request = async <T>(params: Record<string, unknown>): Promise<T> => {
    if (params.mode === 'load') { loadingCalls++; return null as T; }
    if (params.mode === 'epoch') return 0 as T;
    if (params.mode === 'begin') {
      await pause;
      return { id: params.id, anchor, text: '', images: [], version: 0, savedRevision: null } as T;
    }
    if (params.mode === 'save') return { revision: 'saved', status: 'local' } as T;
    if (params.mode === 'finish') return undefined as T;
    throw Error('Unexpected request');
  };
  notes = new OpenQuickNotes(request, () => anchor, () => { void notes.restore(key); });
  const image = notes.image(key, { ...anchor, method: 'frame' }, 'synthetic-image', undefined, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loadingCalls, 1); assert.equal(notes.get(key), undefined);
  finish!(); await image;
  assert.equal(notes.get(key), undefined);
});
