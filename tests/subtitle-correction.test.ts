import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/shared/types/config.ts';
import { correctionBatches, parseCorrection, SUBTITLE_CORRECTION_PREFERENCE } from '../src/shared/subtitle-correction.ts';

test('correction preserves one-to-one line identity and rejects invented or expanded rows', () => {
  const rows = [{ id: 'a', text: '一段字幕' }, { id: 'b', text: '第二段' }];
  assert.deepEqual(parseCorrection(JSON.stringify({ lines: [{ id: 'a', text: '一段字幕。' }, { id: 'b', text: '第二段。' }] }), rows), { a: '一段字幕。', b: '第二段。' });
  for (const lines of [[rows[1], rows[0]], [rows[0]], [{ ...rows[0], text: 'A'.repeat(500) }, rows[1]]]) {
    assert.throws(() => parseCorrection(JSON.stringify({ lines }), rows));
  }
  assert.equal(correctionBatches(Array.from({ length: 70 }, (_, i) => ({ id: String(i), text: '字幕' }))).length, 3);
});

test('real correction service supports partial resume, cache, cancellation, source fencing and revoke', async () => {
  const listeners: Array<(changes: Record<string, unknown>, area: string) => void> = [];
  const local: Record<string, unknown> = { userConfig: { ...structuredClone(DEFAULT_CONFIG), ai: { ...DEFAULT_CONFIG.ai, baseURL: 'https://synthetic.invalid/v1', apiKey: 'synthetic-test', chatModel: 'synthetic' } }, [SUBTITLE_CORRECTION_PREFERENCE]: true };
  const session: Record<string, unknown> = {};
  const area = (data: Record<string, unknown>, name: string) => ({
    get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, data[key]])),
    set: async (values: Record<string, unknown>) => { Object.assign(data, values); for (const fn of listeners) fn(Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { newValue: value }])), name); },
    remove: async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
  });
  const priorChrome = globalThis.chrome, priorFetch = globalThis.fetch;
  Object.assign(globalThis, { chrome: { storage: { local: area(local, 'local'), session: area(session, 'session'), onChanged: { addListener: (fn: typeof listeners[number]) => listeners.push(fn) } } } });
  let calls = 0, fail = true, current = true, revoke = false;
  globalThis.fetch = async (_url, init) => {
    calls++; const rows = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    if (revoke) await chrome.storage.local.set({ [SUBTITLE_CORRECTION_PREFERENCE]: false });
    if (fail && rows[0].id === '32') return new Response('', { status: 503 });
    return Response.json({ choices: [{ message: { content: JSON.stringify({ lines: rows.map((row: { id: string; text: string }) => ({ ...row, text: row.text + '。' })) }) } }] });
  };
  try {
    const { subtitleCorrection, clearSubtitleCorrections } = await import('../src/background/ai/subtitle-correction.ts');
    const options = { tabId: 1, sourceIdentityKey: 'synthetic-source', lines: Array.from({ length: 70 }, (_, i) => ({ id: String(i), text: '原始字幕' })), step: true, current: async () => current };
    let state = await subtitleCorrection(options); assert.equal(state.done, 32);
    state = await subtitleCorrection(options); assert.deepEqual(state.failed, [1]);
    state = await subtitleCorrection(options); assert.equal(state.status, 'partial'); assert.equal(state.done, 38);
    await subtitleCorrection(options); assert.equal(calls, 3);
    fail = false; state = await subtitleCorrection({ ...options, retry: true }); assert.equal(state.status, 'complete'); assert.equal(state.done, 70);
    assert.equal(calls, 4); await subtitleCorrection(options); assert.equal(calls, 4);
    await clearSubtitleCorrections(); current = false;
    state = await subtitleCorrection(options); assert.equal(state.status, 'stopped'); assert.equal(calls, 4);
    current = true; revoke = true; state = await subtitleCorrection(options); assert.equal(state.status, 'stopped');
    assert.equal((await subtitleCorrection({ ...options, step: false })).done, 0);
    await subtitleCorrection(options); assert.equal(calls, 5);
    await clearSubtitleCorrections(); assert.deepEqual(session, {});
  } finally { Object.assign(globalThis, { chrome: priorChrome }); globalThis.fetch = priorFetch; }
});
