import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLearningChatMessages, chatBudget } from '../src/shared/learning-chat.ts';
import { streamLearningChat } from '../src/background/ai/learning-chat-transport.ts';
import { askLearningChat, learningChatProgress } from '../src/background/learning-chat.ts';
import { db } from '../src/background/storage/db.ts';
import { DEFAULT_CONFIG } from '../src/shared/types/config.ts';
import { deleteCurrentVideoQaSession, getCurrentVideoQaSessionsView } from '../src/background/storage/current-video-qa-session-repo.ts';

const ai = { apiKey: 'synthetic', chatModel: 'synthetic-model', baseURL: 'https://example.invalid' };
const originalFetch = globalThis.fetch;
let storage: Record<string, unknown>;
test.beforeEach(async () => {
  db.close(); await db.delete(); await db.open();
  storage = { userConfig: { ...structuredClone(DEFAULT_CONFIG), ai, assistant: { ...DEFAULT_CONFIG.assistant, currentVideoAiAssistantEnabled: true } } };
  globalThis.chrome = { storage: { local: { get: async () => structuredClone(storage), set: async values => { Object.assign(storage, values); } } } } as unknown as typeof chrome;
});
test.afterEach(async () => { globalThis.fetch = originalFetch; db.close(); await db.delete(); });
const source = async () => ({ source: null, text: '', stillCurrent: async () => true });
const ask = (requestId: string, turnId = requestId) => askLearningChat({ requestId, turnId, sessionId: 'session', question: '如何改进？', tabId: 1, resolveSource: source });

test('budget is finite and oversized source fails before silent truncation', () => {
  assert.equal(chatBudget(undefined), 32768); assert.equal(chatBudget(Infinity), 32768);
  assert.equal(chatBudget(1), 8192);
  assert.throws(() => buildLearningChatMessages({ question: '全片总结', session: null, videoTitle: '视频', videoText: '原文'.repeat(20000) }), /CHAT_CONTEXT_LIMIT/);
});
test('plain provider, natural expansion, multiple turns and retry without self-history', async () => {
  const payloads: any[] = [];
  globalThis.fetch = async (_url, options) => {
    payloads.push(JSON.parse(String(options?.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: '拓展知识\n先说明目标，再拆分步骤。' } }] }), { headers: { 'content-type': 'application/json' } });
  };
  const first = await ask('a');
  assert.equal(first.answerMode, 'learning'); assert.equal(first.status, 'invalid_output'); assert.deepEqual(first.citations, []);
  await ask('b'); await ask('c'); await ask('retry-b', 'b');
  assert.equal(payloads[2].messages.filter(m => m.role === 'assistant').length, 2);
  assert.equal(payloads[3].messages.filter(m => m.role === 'assistant').length, 1);
  assert.match(payloads[0].messages[0].content, /拓展知识/);
  assert.doesNotMatch(JSON.stringify(payloads[0].messages), /synthetic-model|apiKey/);
  assert.equal((await getCurrentVideoQaSessionsView('session')).activeSession?.turns.length, 3);
});
test('SSE splits UTF8 and CRLF across packets, ignores comments, streams real content', async () => {
  const bytes = new TextEncoder().encode(': ping\r\n\r\ndata: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\ndata: [DONE]\r\n\r\n');
  globalThis.fetch = async () => new Response(new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
  const chunks: string[] = [];
  assert.equal(await streamLearningChat(ai, [], { signal: new AbortController().signal, stream: true, onText: text => chunks.push(text) }), '你好');
  assert.deepEqual(chunks, ['你好']);
});
test('stop preserves partial answer and another tab cannot read or cancel it', async () => {
  let ready!: () => void; const started = new Promise<void>(resolve => { ready = resolve; });
  globalThis.fetch = async (_url, options) => new Response(new ReadableStream({ start(c) {
    c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"拓展知识：已收到的内容"}}]}\n\n'));
    options?.signal?.addEventListener('abort', () => c.error(new DOMException('Stopped', 'AbortError')));
    setTimeout(ready, 30);
  } }), { headers: { 'content-type': 'text/event-stream' } });
  const pending = ask('stop'); await started;
  assert.equal(learningChatProgress('stop', 2, true).text, '');
  assert.match(learningChatProgress('stop', 1).text, /已收到/);
  learningChatProgress('stop', 1, true);
  const result = await pending;
  assert.equal(result.status, 'cancelled'); assert.match(result.answer, /已收到/);
  db.close(); await db.open();
  assert.match((await getCurrentVideoQaSessionsView('session')).activeSession?.turns[0].answer ?? '', /已收到/);
});
test('deleted session cannot be recreated by late streamed completion', async () => {
  let resolveFetch!: (value: Response) => void;
  let ready!: () => void; const started = new Promise<void>(resolve => { ready = resolve; });
  globalThis.fetch = async () => { ready(); return new Promise(resolve => { resolveFetch = resolve; }); };
  const pending = ask('delete'); await started;
  await deleteCurrentVideoQaSession('session');
  resolveFetch(new Response(JSON.stringify({ choices: [{ message: { content: '迟到回答' } }] })));
  await pending;
  assert.equal(await db.currentVideoQaSessions.count(), 0);
});
test('disabled setting prevents source access and model call', async () => {
  (storage.userConfig as any).assistant.currentVideoAiAssistantEnabled = false;
  globalThis.fetch = async () => { throw new Error('must not call'); };
  const result = await askLearningChat({ requestId: 'off', sessionId: 'off', turnId: 'off', question: '问题', tabId: 1,
    resolveSource: async () => { throw new Error('must not read'); } });
  assert.equal(result.status, 'disabled');
});
test('truncated stream is not presented as completed answer', async () => {
  globalThis.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"半句"}}]}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  const result = await ask('truncated');
  assert.equal(result.status, 'error'); assert.equal(result.answer, '半句'); assert.equal(result.canRetry, true);
});
