import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { db } from '../src/background/storage/db.ts';
import { DEFAULT_CONFIG } from '../src/shared/types/config.ts';
import { retrieveKnowledge, knowledgeSafeSession } from '../src/shared/knowledge-chat.ts';
import { attachKnowledge } from '../src/background/knowledge-chat.ts';
import { askLearningChat } from '../src/background/learning-chat.ts';
import { getCurrentVideoQaSessionsView } from '../src/background/storage/current-video-qa-session-repo.ts';
import { LearningRepository } from '../src/background/storage/learning-repo.ts';
import { buildLearningChatMessages, CHAT_OUTPUT_TOKENS } from '../src/shared/learning-chat.ts';
import { serializedBytes, historyDigest, historyMaterial } from '../src/shared/learning-chat-context.ts';
import type { LearningAsset } from '../src/shared/learning.ts';
const originalFetch = globalThis.fetch;
let storage: Record<string, any>; let listeners: Set<Function>;
const asset = (id: string, note: string, bvid = 'BV1234567890'): LearningAsset => ({ id: id.repeat(64), kind: 'note', createdAt: 1, updatedAt: 1,
  video: { bvid, title: '合成学习视频' }, part: { cid: '22', page: 1 }, personal: { title: '合成笔记', note, tags: [] }, snapshot: null, bookmarkMs: null, importedFrom: null });
const a = asset('a', '可靠交付要求先明确验收，再验证关键流程。独有词甲。');
const b = asset('b', '稳定交付也要关注测试成本与需求变更。独有词乙。', 'BV0987654321');
const unrelated = asset('c', '无关的饮食材料，不应发送。');
test.beforeEach(async () => {
  db.close(); await db.delete(); await db.open(); listeners = new Set();
  storage = { userConfig: { ...structuredClone(DEFAULT_CONFIG), ai: { apiKey: 'synthetic', chatModel: 'mock', baseURL: 'https://example.invalid' },
    assistant: { ...DEFAULT_CONFIG.assistant, currentVideoAiAssistantEnabled: true } } };
  globalThis.chrome = { storage: { local: { get: async () => structuredClone(storage), set: async values => { Object.assign(storage, values); } },
    onChanged: { addListener: cb => listeners.add(cb), removeListener: cb => listeners.delete(cb) } } } as any;
  await db.lgAssets.bulkPut([a, b, unrelated]);
});
test.afterEach(async () => { globalThis.fetch = originalFetch; assert.equal(listeners.size, 0); db.close(); await db.delete(); });
const ask = (id: string, question = '如何稳定交付？') => askLearningChat({ requestId: id, turnId: id, sessionId: 'knowledge', question, tabId: 1,
  resolveSource: async () => ({ text: '', source: null, stillCurrent: async () => true }) });
const reply = (text = '知识库·个人笔记：先明确验收。[1]\n拓展知识：视项目情况调整。') => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { headers: { 'content-type': 'application/json' } });

test('lexical retrieval handles declared synonyms, excludes irrelevant/title-only material and bounds bytes', () => {
  const refs = retrieveKnowledge('可靠上线如何检验？', [a, b, unrelated]);
  assert.equal(new Set(refs.map(r => r.bvid)).size, 2);
  assert.ok(!refs.some(r => r.id === unrelated.id));
  const onlyTitle = asset('d', '与问题不相关的正文'); onlyTitle.video.title = '稳定交付';
  assert.deepEqual(retrieveKnowledge('如何稳定交付', [onlyTitle]), []);
  assert.deepEqual(retrieveKnowledge('天文宇宙黑洞', [a, b]), []);
  const many = Array.from({ length: 30 }, (_, i) => ({ ...a, id: i.toString(16).padStart(64, '0'), personal: { ...a.personal, note: '稳定交付'.repeat(2000) } }));
  const bounded = retrieveKnowledge('稳定交付', many); assert.ok(bounded.length <= 6); assert.ok(serializedBytes(bounded) <= 8192);
});
test('knowledge attachment cannot displace recent messages or overflow the whole request budget', () => {
  const messages = buildLearningChatMessages({ question: '稳定交付', videoText: '正文'.repeat(500), videoTitle: '合成', session: null, budget: 8192 });
  const before = structuredClone(messages); const result = attachKnowledge(messages, retrieveKnowledge('稳定交付', [a, b]), 8192);
  assert.deepEqual(messages, before); assert.equal(result.messages.at(-1)?.content, '稳定交付');
  assert.ok(serializedBytes(result.messages) <= 8192 - CHAT_OUTPUT_TOKENS - 1024);
  for (const item of before.slice(1)) assert.ok(result.messages.some(m => m.role === item.role && m.content === item.content));
  assert.deepEqual(attachKnowledge(messages, [], 8192).messages, messages);
});
test('default-off does not read the learning repository or send any saved content', async () => {
  const prior = LearningRepository.prototype.state; let reads = 0;
  LearningRepository.prototype.state = async function () { reads++; throw Error('must not read'); };
  try {
    globalThis.fetch = async (_url, options) => { const text = String(options?.body); assert.ok(!text.includes('独有词')); return reply('拓展知识：一般讨论。'); };
    const result = await ask('off'); assert.equal(result.ai.status, 'generated'); assert.equal(reads, 0); assert.equal(result.knowledgeStamp, undefined);
  } finally { LearningRepository.prototype.state = prior; }
});
test('authorized production request sends two relevant sources, preserves references through restart, and excludes unrelated notes', async () => {
  storage.knowledgeAiAuthorization = { enabled: true, generation: 'grant1' };
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(String(options?.body)); const text = JSON.stringify(body.messages);
    assert.match(text, /独有词甲/); assert.match(text, /独有词乙/); assert.doesNotMatch(text, /无关的饮食|apiKey|digest|sourceHash/);
    assert.match(text, /冲突时并列/); return reply();
  };
  const result = await ask('on'); assert.equal(result.knowledgeReferences?.length, 2); assert.equal(result.knowledgeStamp, 'grant1:0:0');
  db.close(); await db.open();
  const turn = (await getCurrentVideoQaSessionsView('knowledge')).activeSession!.turns[0];
  assert.deepEqual(turn.knowledgeReferences, result.knowledgeReferences); assert.equal(turn.knowledgeStamp, 'grant1:0:0');
});
test('deleting material removes dependent old answers and later derived discussion from future requests without deleting history', async () => {
  storage.knowledgeAiAuthorization = { enabled: true, generation: 'grant1' };
  globalThis.fetch = async () => reply('独有词甲曾被引用。[1]'); await ask('first');
  globalThis.fetch = async () => reply('派生的独有讨论'); await ask('second', '继续解释');
  await new LearningRepository(db).remove(0, a.id);
  globalThis.fetch = async (_url, options) => { assert.doesNotMatch(String(options?.body), /独有词甲|派生的独有讨论/); return reply('拓展知识：继续讨论。'); };
  const result = await ask('third', '一般问题'); assert.match(result.contextNotice!, /未带入相关旧讨论/);
  assert.equal((await getCurrentVideoQaSessionsView('knowledge')).activeSession?.turns.length, 3);
});
test('switching knowledge off excludes earlier dependent conversation even when all saved material still exists', async () => {
  storage.knowledgeAiAuthorization = { enabled: true, generation: 'grant1' }; globalThis.fetch = async () => reply('独有词甲。[1]'); await ask('before');
  storage.knowledgeAiAuthorization = { enabled: false, generation: 'grant2' };
  globalThis.fetch = async (_url, options) => { assert.doesNotMatch(String(options?.body), /独有词甲/); return reply('一般讨论'); };
  const result = await ask('after', '继续'); assert.match(result.contextNotice!, /授权或材料已变化/);
});
for (const interimQuestion of [false, true]) test(`new authorization cannot reuse prior knowledge conversation after restart (interim=${interimQuestion})`, async () => {
  storage.knowledgeAiAuthorization = { enabled: true, generation: 'grant1' };
  globalThis.fetch = async () => reply('上次授权派生的独有结论。[1]'); await ask('old-grant');
  storage.knowledgeAiAuthorization = { enabled: false, generation: 'grant2' };
  if (interimQuestion) { globalThis.fetch = async () => reply('关闭期间的后续讨论'); await ask('off-grant', '天文黑洞'); }
  storage.knowledgeAiAuthorization = { enabled: true, generation: 'grant3' };
  db.close(); await db.open();
  globalThis.fetch = async (_url, options) => {
    assert.doesNotMatch(String(options?.body), /上次授权派生|关闭期间的后续讨论|独有词甲/); return reply('拓展知识：天文讨论');
  };
  const result = await ask('new-grant', '天文黑洞'); assert.match(result.contextNotice!, /未带入相关旧讨论/);
  assert.equal((await getCurrentVideoQaSessionsView('knowledge')).activeSession?.turns.length, interimQuestion ? 3 : 2);
});
test('persisted summary after restart cannot reintroduce withdrawn learning material', async () => {
  storage.knowledgeAiAuthorization = { enabled: true, generation: 'grant1' }; globalThis.fetch = async () => reply('独有词甲来自旧材料。[1]'); await ask('summarized');
  const row = (await db.currentVideoQaSessions.toArray())[0]; const turn = row.turns[0];
  row.learningContext = { version: 1, video: null, summaries: [{ turnIds: [turn.turnId], digest: historyDigest([turn]), start: 0,
    end: historyMaterial(turn).length, text: '保存过的摘要独有词甲' }] };
  await db.currentVideoQaSessions.put(row); db.close(); await db.open();
  assert.equal((await getCurrentVideoQaSessionsView('knowledge')).activeSession?.learningContext?.summaries.length, 1);
  await new LearningRepository(db).remove(0, a.id);
  globalThis.fetch = async (_url, options) => { assert.doesNotMatch(String(options?.body), /独有词甲|保存过的摘要/); return reply('一般讨论'); };
  await ask('after-summary', '请继续');
  assert.equal((await getCurrentVideoQaSessionsView('knowledge')).activeSession?.turns.length, 2);
});
test('permission revocation aborts idle provider transport without waiting for its next chunk', async () => {
  storage.knowledgeAiAuthorization = { enabled: true, generation: 'grant1' };
  let started!: () => void; const ready = new Promise<void>(r => { started = r; });
  globalThis.fetch = async (_url, options) => new Response(new ReadableStream({ start(c) {
    c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"已收到"}}]}\n\n'));
    options?.signal?.addEventListener('abort', () => c.error(new DOMException('stop', 'AbortError'))); started();
  } }), { headers: { 'content-type': 'text/event-stream' } });
  const pending = ask('revoke'); await ready; storage.knowledgeAiAuthorization = { enabled: false, generation: 'grant2' };
  for (const listener of listeners) listener({ knowledgeAiAuthorization: { newValue: storage.knowledgeAiAuthorization } }, 'local');
  const result = await pending; assert.equal(result.status, 'cancelled');
});
test('repository mutation aborts an idle response and keeps provenance on the partial turn', async () => {
  storage.knowledgeAiAuthorization = { enabled: true, generation: 'grant1' };
  let started!: () => void; const ready = new Promise<void>(r => { started = r; });
  globalThis.fetch = async (_url, options) => new Response(new ReadableStream({ start(c) {
    c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"部分笔记回答[1]"}}]}\n\n'));
    options?.signal?.addEventListener('abort', () => c.error(new DOMException('stop', 'AbortError'))); started();
  } }), { headers: { 'content-type': 'text/event-stream' } });
  const pending = ask('remove'); await ready; await new LearningRepository(db).remove(0, a.id);
  const result = await pending; assert.equal(result.status, 'cancelled');
  assert.equal((await getCurrentVideoQaSessionsView('knowledge')).activeSession?.turns[0].knowledgeStamp, 'grant1:0:0');
});
test('retrieval failure degrades to ordinary chat without private old context', async () => {
  storage.knowledgeAiAuthorization = { enabled: true, generation: 'grant1' };
  const prior = LearningRepository.prototype.state;
  LearningRepository.prototype.state = async function () { throw Error('unavailable'); };
  try { globalThis.fetch = async () => reply('一般讨论'); const result = await ask('fail'); assert.equal(result.ai.status, 'generated'); assert.match(result.contextNotice!, /暂不可检索/); }
  finally { LearningRepository.prototype.state = prior; }
  assert.deepEqual(knowledgeSafeSession(null, null), { session: null, omitted: false });
});
