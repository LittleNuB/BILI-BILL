import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLearningChatMessages, buildLearningChatContext, chatBudget } from '../src/shared/learning-chat.ts';
import { streamLearningChat } from '../src/background/ai/learning-chat-transport.ts';
import { askLearningChat, learningChatProgress } from '../src/background/learning-chat.ts';
import { db } from '../src/background/storage/db.ts';
import { DEFAULT_CONFIG } from '../src/shared/types/config.ts';
import { clearCurrentVideoQaSessions, deleteCurrentVideoQaSession, getCurrentVideoQaSessionsView } from '../src/background/storage/current-video-qa-session-repo.ts';
import { activeLearningChats } from '../src/background/learning-chat-control.ts';
import { cancelCurrentVideoFullTextQaForSource, cancelCurrentVideoFullTextQaForScope, invalidateCurrentVideoFullTextQaPart,
  invalidateCurrentVideoFullTextQaConfig, invalidateCurrentVideoFullTextQaSources } from '../src/background/current-video-full-text-qa.ts';

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

test('non-stream length limit keeps partial text and allows retry', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '未完成的回答' }, finish_reason: 'length' }] }));
  const result = await ask('length');
  assert.equal(result.status, 'error'); assert.equal(result.answer, '未完成的回答'); assert.equal(result.canRetry, true);
  assert.equal((await getCurrentVideoQaSessionsView('session')).activeSession?.turns[0].status, 'error');
});

test('older history overflow retains recent complete pairs, records omission without deleting history', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '近期回答' } }] }));
  await ask('old'); await ask('recent');
  const session = (await getCurrentVideoQaSessionsView('session')).activeSession!;
  session.turns[0].answer = '旧内容'.repeat(4000);
  await db.currentVideoQaSessions.put(session);
  const context = buildLearningChatContext({ question: '继续', session, videoText: '', videoTitle: null, budget: 8192 });
  assert.equal(context.historyOmitted, true);
  assert.deepEqual(context.messages.filter(m => m.role === 'assistant').map(m => m.content), ['近期回答']);
  assert.match(context.messages[0].content, /不可声称记得/);
  storage.learningChatBudget = 8192;
  const result = await ask('window');
  assert.equal(result.status, 'invalid_output'); assert.match(result.contextNotice ?? '', /较早对话未完整带入/);
  const saved = (await getCurrentVideoQaSessionsView('session')).activeSession!;
  assert.equal(saved.turns[0].answer, session.turns[0].answer);
  assert.equal(saved.turns[2].contextNotice, result.contextNotice);
});

for (const [name, invalidate] of [
  ['config', () => invalidateCurrentVideoFullTextQaConfig()],
  ['sources', () => invalidateCurrentVideoFullTextQaSources()],
  ['tab', () => cancelCurrentVideoFullTextQaForScope('tab-1')],
  ['delete', () => deleteCurrentVideoQaSession('session')],
  ['clear', () => clearCurrentVideoQaSessions()],
] as const) {
  test(`${name} immediately aborts an idle transport without waiting for another chunk`, async () => {
    let ready!: () => void; const started = new Promise<void>(resolve => { ready = resolve; });
    let signal: AbortSignal | undefined;
    globalThis.fetch = async (_url, options) => new Response(new ReadableStream({ start(controller) {
      signal = options?.signal ?? undefined;
      signal?.addEventListener('abort', () => controller.error(new DOMException('Stopped', 'AbortError')));
      ready();
    } }), { headers: { 'content-type': 'text/event-stream' } });
    const pending = ask(name); await started;
    const mutation = invalidate();
    assert.equal(signal?.aborted, true);
    await mutation;
    const result = await pending;
    assert.equal(result.status, 'cancelled'); assert.equal(result.answer, '');
    assert.equal(activeLearningChats.size, 0);
    if (name === 'delete' || name === 'clear') assert.equal(await db.currentVideoQaSessions.count(), 0);
  });
}

test('source, part and tab cancellation preserve unrelated active requests', () => {
  const make = (tabId: number, bvid: string, sourceIdentityKey: string) => ({ controller: new AbortController(), tabId, sessionId: String(tabId), turnId: 't', text: '',
    source: { bvid, cid: tabId, page: 1, sourceIdentityKey } as any });
  const first = make(1, 'BV1', 'source-one'); const second = make(2, 'BV2', 'source-two');
  activeLearningChats.set('one', first); activeLearningChats.set('two', second);
  try {
    cancelCurrentVideoFullTextQaForSource('missing'); assert.equal(first.controller.signal.aborted, false);
    invalidateCurrentVideoFullTextQaPart({ bvid: 'BV1', cid: 1, page: 1 });
    assert.equal(first.controller.signal.aborted, true); assert.equal(second.controller.signal.aborted, false);
    cancelCurrentVideoFullTextQaForScope('tab-1'); assert.equal(second.controller.signal.aborted, false);
    cancelCurrentVideoFullTextQaForSource('source-two'); assert.equal(second.controller.signal.aborted, true);
  } finally { activeLearningChats.clear(); }
});

const longSource = async () => {
  const text = '视频观点与限制。'.repeat(1400);
  return { source: { title: '合成视频', partTitle: null, page: 1, bvid: 'BV1Synthetic', cid: 1, url: null,
    sourceLabel: 'B站字幕' as const, language: 'zh', sourceIdentityKey: 'synthetic-only',
    textSize: { lineCount: 1, charCount: text.length, utf8Bytes: new TextEncoder().encode(text).length }, capturedAt: 1 }, text, stillCurrent: async () => true };
};
test('production chat persists video coverage, resumes explicitly after storage reopen and keeps partial final answer retryable', async () => {
  storage.learningChatBudget = 8192;
  const calls: any[] = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(String(options?.body)); calls.push(body);
    return new Response(JSON.stringify({ choices: [{ message: { content: body.messages[0].content.includes('仅整理') ? '一段观点。' : '根据已处理部分回答。' }, finish_reason: 'stop' }] }));
  };
  const input = { requestId: 'coverage-1', sessionId: 'coverage', turnId: 'turn', question: '全片总结', tabId: 1, resolveSource: longSource };
  const first = await askLearningChat(input);
  assert.equal(first.canRetry, true); assert.match(first.contextNotice ?? '', /尚未覆盖全文/);
  assert.equal(calls.length, 7);
  db.close(); await db.open();
  const saved = (await getCurrentVideoQaSessionsView('coverage')).activeSession!;
  assert.equal(saved.learningContext?.video?.parts.filter(p => p.status === 'complete').length, 6);
  assert.equal(calls.length, 7);
  const second = await askLearningChat({ ...input, requestId: 'coverage-2' });
  assert.equal(second.canRetry, false); assert.match(second.contextNotice ?? '', /逐段处理全文/);
  assert.ok(calls.length > 8 && calls.length < 14);
  assert.equal((await getCurrentVideoQaSessionsView('coverage')).activeSession?.turns.length, 1);
});

test('production deletion during auxiliary work immediately aborts and does not recreate context', async () => {
  storage.learningChatBudget = 8192;
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  let signal: AbortSignal | undefined;
  globalThis.fetch = async (_url, options) => new Response(new ReadableStream({ start(controller) {
    signal = options?.signal ?? undefined;
    signal?.addEventListener('abort', () => controller.error(new DOMException('Stopped', 'AbortError')));
    started();
  } }), { headers: { 'content-type': 'text/event-stream' } });
  const pending = askLearningChat({ requestId: 'helper-delete', sessionId: 'session', turnId: 't', question: '全片总结', tabId: 1, resolveSource: longSource });
  await ready;
  assert.match(learningChatProgress('helper-delete', 1).notice ?? '', /正在整理视频/);
  const deleting = deleteCurrentVideoQaSession('session');
  assert.equal(signal?.aborted, true); await deleting; await pending;
  assert.equal(await db.currentVideoQaSessions.count(), 0);
});

test('provider context window errors map to bounded retryable status without exposing payload details', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'context_length_exceeded', message: 'raw provider internals' } }), { status: 400 });
  const result = await ask('provider-limit');
  assert.equal(result.status, 'context_too_long'); assert.equal(result.canRetry, true);
  assert.doesNotMatch(result.message, /raw provider/);
});
