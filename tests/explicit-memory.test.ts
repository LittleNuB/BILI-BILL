import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { db } from '../src/background/storage/db.ts';
import { ExplicitMemoryRepository } from '../src/background/storage/explicit-memory-repo.ts';
import { validateMemoryDraft, memorySafeSession } from '../src/shared/explicit-memory.ts';
import { attachMemory } from '../src/background/memory-chat.ts';
import { DEFAULT_CONFIG } from '../src/shared/types/config.ts';
import { askLearningChat } from '../src/background/learning-chat.ts';
import { getCurrentVideoQaSessionsView, deleteCurrentVideoQaSession } from '../src/background/storage/current-video-qa-session-repo.ts';
import { getExplicitMemoryDataCategoryRegistration } from '../src/background/storage/explicit-memory-data-category.ts';
import { buildLearningChatMessages, CHAT_OUTPUT_TOKENS } from '../src/shared/learning-chat.ts';
import { serializedBytes, historyDigest, historyMaterial } from '../src/shared/learning-chat-context.ts';
const originalFetch = globalThis.fetch;
const repo = new ExplicitMemoryRepository(db);
let storage: Record<string, any>; let listeners: Set<Function>;
const draft = (text = '请先给出独有偏好甲，再用简短实例说明。', selected = true) => ({ kind: 'preference' as const, text, selected });
const reply = (text = '一般讨论。') => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { headers: { 'content-type': 'application/json' } });
const ask = (id: string, question = '请解释验收过程') => askLearningChat({ requestId: id, turnId: id, sessionId: 'memory', question, tabId: 1,
  resolveSource: async () => ({ text: '', source: null, stillCurrent: async () => true }) });
test.beforeEach(async () => {
  db.close(); await db.delete(); await db.open(); listeners = new Set();
  storage = { userConfig: { ...structuredClone(DEFAULT_CONFIG), ai: { apiKey: 'synthetic', chatModel: 'mock', baseURL: 'https://example.invalid' },
    assistant: { ...DEFAULT_CONFIG.assistant, currentVideoAiAssistantEnabled: true } } };
  globalThis.chrome = { storage: { local: { get: async () => structuredClone(storage), set: async values => Object.assign(storage, values) },
    onChanged: { addListener: cb => listeners.add(cb), removeListener: cb => listeners.delete(cb) } } } as any;
});
test.afterEach(async () => { globalThis.fetch = originalFetch; assert.equal(listeners.size, 0); db.close(); await db.delete(); });

test('memory is empty after upgrade/open; explicit CRUD persists and stale edit cannot resurrect removal', async () => {
  assert.equal((await repo.read()).items.length, 0);
  const saved = await repo.save(0, draft()); assert.equal(saved.items.length, 1);
  db.close(); await db.open(); assert.deepEqual(await repo.read(), saved);
  const edited = await repo.save(saved.revision, { ...saved.items[0], text: '更简短' });
  await assert.rejects(repo.save(saved.revision, { ...saved.items[0], text: '旧编辑' }), /MEMORY_STALE/);
  await repo.remove(edited.revision, edited.items[0].id);
  await assert.rejects(repo.save(edited.revision, edited.items[0]), /MEMORY_STALE/);
  assert.equal((await repo.read()).items.length, 0);
});
test('bounded user-confirmed types, bytes and common secret forms are validated before any write', async () => {
  for (const text of ['密码：synthetic-secret', 'api_key=synthetic-only', 'Bearer synthetic-token-123', 'sk-synthetic-only-example', '-----BEGIN PRIVATE KEY-----']) {
    await assert.rejects(repo.save(0, draft(text)), /MEMORY_SECRET/);
  }
  assert.throws(() => validateMemoryDraft({ ...draft(), kind: 'skill' as any }), /MEMORY_INVALID/);
  await assert.rejects(repo.save(0, draft('汉'.repeat(171))), /MEMORY_TEXT_LIMIT/);
  assert.equal((await repo.read()).revision, 0);
});
test('item and selected quotas reject atomically; clearing retains revision against late writes', async () => {
  let state = await repo.read();
  for (let i = 0; i < 32; i++) state = await repo.save(state.revision, draft(`明确偏好 ${i}`, i < 6));
  await assert.rejects(repo.save(state.revision, draft('额外一项', false)), /MEMORY_CAPACITY/);
  await assert.rejects(repo.save(state.revision, { ...state.items[6], selected: true }), /MEMORY_CAPACITY/);
  assert.deepEqual(await repo.read(), state);
  await repo.clear(state.revision); await assert.rejects(repo.save(state.revision, draft()), /MEMORY_STALE/);
});
test('deleting chat may retain independent memories or atomically remove associated memories, never late create', async () => {
  globalThis.fetch = async () => reply(); await ask('create');
  let state = await repo.save(0, { ...draft(), originSessionId: 'memory' });
  state = await repo.save(state.revision, draft('独立记忆', false));
  await deleteCurrentVideoQaSession('memory'); assert.equal((await repo.read()).items.length, 2);
  state = await repo.save(state.revision, { ...state.items[0], text: '保留后仍可编辑' });
  await assert.rejects(repo.save(state.revision, { ...draft(), originSessionId: 'memory' }), /MEMORY_SESSION_GONE/);
  await ask('recreate'); await deleteCurrentVideoQaSession('memory', true);
  assert.equal((await repo.read()).items.length, 1); assert.equal((await repo.read()).items[0].text, '独立记忆');
  await assert.rejects(repo.save(state.revision, { ...draft(), originSessionId: 'memory' }), /MEMORY_STALE/);
});
test('registered global clear removes memories with revision retained and readback empty', async () => {
  await repo.save(0, draft()); const category = getExplicitMemoryDataCategoryRegistration();
  assert.equal(category.includeInClearAll, true); assert.equal((await category.collectUsage()).count, 1);
  assert.deepEqual((await category.clear()).cleared, { explicitMemory: 1 }); assert.equal((await category.readAfterClear()).empty, true);
  assert.equal((await repo.read()).revision, 2);
});
test('ordinary chat never saves memories and default off never reads or sends remembered items', async () => {
  await repo.save(0, draft()); const prior = ExplicitMemoryRepository.prototype.read; let reads = 0;
  ExplicitMemoryRepository.prototype.read = async function () { reads++; throw Error('must not read'); };
  try {
    globalThis.fetch = async (_url, options) => { assert.doesNotMatch(String(options?.body), /独有偏好甲/); return reply(); };
    const result = await ask('off'); assert.equal(result.ai.status, 'generated'); assert.equal(reads, 0); assert.equal(result.memoryStamp, undefined);
  } finally { ExplicitMemoryRepository.prototype.read = prior; }
  assert.equal((await repo.read()).items.length, 1);
});
test('authorized request contains selected preferences only, with persisted dependency but not source claims', async () => {
  const state = await repo.save(0, draft()); await repo.save(state.revision, draft('不选中的独有偏好乙', false));
  storage.memoryAiAuthorization = { enabled: true, generation: 'grant1' };
  globalThis.fetch = async (_url, options) => { const body = String(options?.body); assert.match(body, /独有偏好甲/); assert.doesNotMatch(body, /独有偏好乙|originSessionId/); assert.match(body, /不是视频事实/); return reply(); };
  const result = await ask('on'); assert.equal(result.memoryStamp, 'grant1:2'); assert.match(result.contextNotice!, /带入 1 项/);
  db.close(); await db.open(); assert.equal((await getCurrentVideoQaSessionsView('memory')).activeSession?.turns[0].memoryStamp, 'grant1:2');
});
test('memory attachment preserves recent chat and stays within the same shared budget', async () => {
  const state = await repo.save(0, draft());
  const messages = buildLearningChatMessages({ question: '当前问题', session: null, videoTitle: '合成', videoText: '正文'.repeat(500), budget: 8192 });
  const before = structuredClone(messages); const attached = attachMemory(messages, state.items, 8192);
  assert.deepEqual(messages, before); assert.equal(attached.messages.at(-1)?.content, '当前问题');
  assert.ok(serializedBytes(attached.messages) <= 8192 - CHAT_OUTPUT_TOKENS - 1024);
  for (const item of before.slice(1)) assert.ok(attached.messages.some(m => m.content === item.content && m.role === item.role));
});
for (const action of ['delete', 'edit', 'deselect', 'off', 'off-on']) test(`${action} excludes memory-derived history and persisted summaries after restart`, async () => {
  const state = await repo.save(0, draft()); storage.memoryAiAuthorization = { enabled: true, generation: 'grant1' };
  globalThis.fetch = async () => reply('曾引用独有偏好甲的讨论'); await ask('first');
  globalThis.fetch = async () => reply('后续派生结论'); await ask('second');
  const row = (await db.currentVideoQaSessions.toArray())[0]; const turn = row.turns[0];
  row.learningContext = { version: 1, video: null, summaries: [{ turnIds: [turn.turnId], digest: historyDigest([turn]), start: 0, end: historyMaterial(turn).length, text: '独有旧摘要' }] };
  await db.currentVideoQaSessions.put(row);
  if (action === 'delete') await repo.remove(state.revision, state.items[0].id);
  if (action === 'edit') await repo.save(state.revision, { ...state.items[0], text: '新的偏好' });
  if (action === 'deselect') await repo.save(state.revision, { ...state.items[0], selected: false });
  if (action === 'off') storage.memoryAiAuthorization = { enabled: false, generation: 'grant2' };
  if (action === 'off-on') storage.memoryAiAuthorization = { enabled: true, generation: 'grant3' };
  db.close(); await db.open();
  globalThis.fetch = async (_url, options) => { const body = String(options?.body); assert.doesNotMatch(body, /曾引用|后续派生|独有旧摘要/); if (action !== 'off-on') assert.doesNotMatch(body, /独有偏好甲/); return reply(); };
  const result = await ask('after'); assert.match(result.contextNotice!, /记忆或授权已变化/);
  assert.equal((await getCurrentVideoQaSessionsView('memory')).activeSession?.turns.length, 3);
});
for (const action of ['delete', 'off']) test(`in-flight ${action} cancels idle transport with partial provenance retained`, async () => {
  const state = await repo.save(0, draft()); storage.memoryAiAuthorization = { enabled: true, generation: 'grant1' };
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  globalThis.fetch = async (_url, options) => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"已收到"}}]}\n\n'));
    options?.signal?.addEventListener('abort', () => controller.error(new DOMException('stop', 'AbortError'))); started();
  } }), { headers: { 'content-type': 'text/event-stream' } });
  const pending = ask('cancel'); await ready;
  if (action === 'delete') await repo.remove(state.revision, state.items[0].id);
  else { storage.memoryAiAuthorization = { enabled: false, generation: 'grant2' }; for (const listener of listeners) listener({ memoryAiAuthorization: { newValue: storage.memoryAiAuthorization } }, 'local'); }
  const result = await pending; assert.equal(result.status, 'cancelled');
  assert.equal((await getCurrentVideoQaSessionsView('memory')).activeSession?.turns[0].memoryStamp, 'grant1:1');
});
test('read failure excludes remembered context and degrades to ordinary discussion', async () => {
  storage.memoryAiAuthorization = { enabled: true, generation: 'grant1' }; const prior = ExplicitMemoryRepository.prototype.read;
  ExplicitMemoryRepository.prototype.read = async () => { throw Error('unavailable'); };
  try { globalThis.fetch = async () => reply(); const result = await ask('failed'); assert.equal(result.ai.status, 'generated'); assert.match(result.contextNotice!, /记忆暂不可读取/); }
  finally { ExplicitMemoryRepository.prototype.read = prior; }
  assert.deepEqual(memorySafeSession(null, null), { session: null, omitted: false });
});
