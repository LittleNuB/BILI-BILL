import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLearningChatMessages, buildLearningChatContext, chatBudget } from '../src/shared/learning-chat.ts';
import { streamLearningChat } from '../src/background/ai/learning-chat-transport.ts';
import { askLearningChat, learningChatProgress } from '../src/background/learning-chat.ts';
import { db } from '../src/background/storage/db.ts';
import { DEFAULT_CONFIG } from '../src/shared/types/config.ts';
import { clearCurrentVideoQaSessions, deleteCurrentVideoQaSession, getCurrentVideoQaSessionsView, saveLearningChatContext,
  saveLearningChatPartial, upsertCurrentVideoQaPendingTurn, collectCurrentVideoQaSessionUsage,
  registerCurrentVideoQaSessionTurnWriteGuard, settleCurrentVideoQaSessionTurnWriteGuard, isCurrentVideoQaSessionStorageLimitError } from '../src/background/storage/current-video-qa-session-repo.ts';
import { CURRENT_VIDEO_QA_SESSION_MAX_BYTES } from '../src/shared/types/current-video-qa-session.ts';
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

test('non-stream failures describe the actual cause without suggesting a streaming toggle', async () => {
  storage.learningChatStreaming = false;
  for (const [status, expected] of [[401, /认证/], [402, /余额/], [404, /模型|地址/], [429, /频繁/], [503, /暂不可用/]] as const) {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'private provider details' } }), { status });
    const result = await ask(`http-${status}`);
    assert.match(result.message, expected);
    assert.doesNotMatch(result.message, /流式|private provider/);
  }
});

test('reasoning-only exhausted output is not treated as a stream failure or an answer', async () => {
  storage.learningChatStreaming = false;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: null, reasoning_content: 'private reasoning' }, finish_reason: 'length' }] }));
  const result = await ask('reasoning-only');
  assert.equal(result.answer, ''); assert.equal(result.status, 'error');
  assert.match(result.message, /思考.*预算/); assert.doesNotMatch(result.message, /关闭流式|private reasoning/);
});

test('image context limit is not misreported as unsupported vision', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'context_length_exceeded' } }), { status: 400 });
  await assert.rejects(streamLearningChat(ai, [{ role: 'user', content: '解释图片' }], {
    signal: new AbortController().signal, stream: false, onText: () => {}, images: ['data:image/png;base64,synthetic'],
  }), /CHAT_CONTEXT_LIMIT/);
});

test('unknown image bad request does not assert the model lacks vision', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'private details' } }), { status: 400 });
  await assert.rejects(streamLearningChat(ai, [{ role: 'user', content: '解释图片' }], {
    signal: new AbortController().signal, stream: false, onText: () => {}, images: ['data:image/png;base64,synthetic'],
  }), /CHAT_BAD_REQUEST/);
});

test('image transport preserves selected model, non-stream flag and final user image bytes', async () => {
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    assert.equal(body.model, 'deepseek-flash'); assert.equal(body.stream, false);
    assert.equal(body.messages[0].content, '安全规则');
    assert.deepEqual(body.messages[1].content, [{ type: 'text', text: '解释图片' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,synthetic' } }]);
    return new Response(JSON.stringify({ choices: [{ message: { content: '图像回答' }, finish_reason: 'stop' }] }));
  };
  assert.equal(await streamLearningChat({ ...ai, chatModel: 'deepseek-flash' }, [{ role: 'system', content: '安全规则' }, { role: 'user', content: '解释图片' }], {
    signal: new AbortController().signal, stream: false, onText: () => {}, images: ['data:image/png;base64,synthetic'],
  }), '图像回答');
});

test('official DeepSeek image requests reserve their bounded output for the answer, not default thinking', async () => {
  for (const baseURL of ['https://api.deepseek.com', 'https://api.deepseek.com/v1/']) {
    for (const stream of [false, true]) {
      globalThis.fetch = async (_url, options) => {
        const body = JSON.parse(String(options?.body));
        assert.deepEqual(body.thinking, { type: 'disabled' });
        assert.equal(body.stream, stream); assert.equal(body.max_tokens, 2048);
        assert.equal(body.messages.at(-1).content[1].type, 'image_url');
        return stream
          ? new Response('data: {"choices":[{"delta":{"content":"画面观察：图片内容"},"finish_reason":"stop"}]}\n\n', { headers: { 'content-type': 'text/event-stream' } })
          : new Response(JSON.stringify({ choices: [{ message: { content: '画面观察：图片内容' }, finish_reason: 'stop' }] }));
      };
      const result = await streamLearningChat({ ...ai, baseURL, chatModel: 'deepseek-flash' }, [{ role: 'user', content: '解释图片' }], {
        signal: new AbortController().signal, stream, onText: () => {}, images: ['data:image/png;base64,synthetic'],
      });
      assert.equal(result, '画面观察：图片内容');
    }
  }
});

test('DeepSeek image compatibility does not alter text-only, other models, or third-party endpoints', async () => {
  for (const [baseURL, chatModel, images] of [
    ['https://api.deepseek.com', 'deepseek-flash', []],
    ['https://example.invalid/v1', 'deepseek-flash', ['data:image/png;base64,synthetic']],
    ['https://api.deepseek.com.example.invalid', 'deepseek-flash', ['data:image/png;base64,synthetic']],
    ['https://api.deepseek.com/anthropic', 'deepseek-flash', ['data:image/png;base64,synthetic']],
    ['https://api.deepseek.com', 'other-model', ['data:image/png;base64,synthetic']],
  ] as const) {
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      assert.equal('thinking' in body, false);
      return new Response(JSON.stringify({ choices: [{ message: { content: '回答' } }] }));
    };
    await streamLearningChat({ ...ai, baseURL, chatModel }, [{ role: 'user', content: '问题' }], {
      signal: new AbortController().signal, stream: false, onText: () => {}, images: [...images],
    });
  }
});

test('explicit bounded explanation uses JSON output with original images and low thinking; default chat stays free form', async () => {
  const raw = '{"purpose":"合成画面","observations":["合成观察"],"captionRelation":"","limitations":""}';
  for (const stream of [false, true]) {
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      assert.deepEqual(body.response_format, { type: 'json_object' });
      assert.deepEqual(body.thinking, { type: 'enabled' }); assert.equal(body.reasoning_effort, 'low');
      assert.equal(body.max_tokens, 2048); assert.equal('temperature' in body, false);
      assert.equal(body.messages.at(-1).content[1].image_url.url, 'data:image/webp;base64,synthetic');
      return stream ? new Response(`data: ${JSON.stringify({choices:[{delta:{content:raw},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`, {headers:{'content-type':'text/event-stream'}})
        : new Response(JSON.stringify({choices:[{message:{content:raw},finish_reason:'stop'}]}));
    };
    const chunks: string[] = [];
    assert.equal(await streamLearningChat({ ...ai, baseURL: 'https://api.deepseek.com', chatModel: 'deepseek-flash' },
      [{ role: 'user', content: '解释图片，输出 JSON' }], { signal: new AbortController().signal, stream,
        onText: value => chunks.push(value), images: ['data:image/webp;base64,synthetic'], imageThinking: 'low', imageAnswer: 'bounded_explanation' }), raw);
    assert.equal(chunks.at(-1), raw);
  }
  let calls = 0; globalThis.fetch = async () => { calls++; throw Error('unexpected'); };
  await assert.rejects(streamLearningChat(ai, [{role:'user',content:'问题'}], {signal:new AbortController().signal,
    stream:false,onText:()=>{},imageAnswer:'bounded_explanation'}), /CHAT_IMAGE_JSON_UNSUPPORTED/);
  assert.equal(calls, 0);
});

test('explicit low-thinking image probe preserves image bytes and the bounded output in both transports', async () => {
  for (const chatModel of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
    for (const stream of [false, true]) {
      globalThis.fetch = async (_url, options) => {
        const body = JSON.parse(String(options?.body));
        assert.deepEqual(body.thinking, { type: 'enabled' });
        assert.equal(body.reasoning_effort, 'low');
        assert.equal('temperature' in body, false);
        assert.equal(body.max_tokens, 2048);
        assert.equal(body.messages[0].content, '图片来源规则');
        assert.deepEqual(body.messages[1].content, [{ type: 'text', text: '解释图片' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,synthetic' } }]);
        return stream
          ? new Response('data: {"choices":[{"delta":{"reasoning_content":"synthetic reasoning"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{"content":"画面观察"},"finish_reason":"stop"}]}\n\n', { headers: { 'content-type': 'text/event-stream' } })
          : new Response(JSON.stringify({ choices: [{ message: { reasoning_content: 'synthetic reasoning', content: '画面观察' }, finish_reason: 'stop' }] }));
      };
      assert.equal(await streamLearningChat({ ...ai, baseURL: 'https://api.deepseek.com/v1/', chatModel },
        [{ role: 'system', content: '图片来源规则' }, { role: 'user', content: '解释图片' }], {
          signal: new AbortController().signal, stream, onText: () => {}, images: ['data:image/png;base64,synthetic'], imageThinking: 'low',
        }), '画面观察');
    }
  }
});

test('low-thinking image probe rejects unsupported providers and missing image before any request', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw Error('must not send'); };
  for (const [baseURL, chatModel, images] of [
    ['https://example.invalid/v1', 'deepseek-flash', ['data:image/png;base64,synthetic']],
    ['https://api.deepseek.com.example.invalid', 'deepseek-flash', ['data:image/png;base64,synthetic']],
    ['https://api.deepseek.com/anthropic', 'deepseek-flash', ['data:image/png;base64,synthetic']],
    ['https://api.deepseek.com', 'other-model', ['data:image/png;base64,synthetic']],
    ['https://api.deepseek.com', 'deepseek-flash', []],
  ] as const) await assert.rejects(streamLearningChat({ ...ai, baseURL, chatModel }, [{ role: 'user', content: '问题' }], {
    signal: new AbortController().signal, stream: false, onText: () => {}, images: [...images], imageThinking: 'low',
  }), /CHAT_IMAGE_THINKING_UNSUPPORTED/);
  assert.equal(calls, 0);
});

test('bounded subtitle correction disables default thinking only for supported official Flash endpoints', async () => {
  for (const [baseURL, chatModel, disabled] of [
    ['https://api.deepseek.com/v1/', 'deepseek-v4-flash', true],
    ['https://api.deepseek.com', 'deepseek-flash', true],
    ['https://api.deepseek.com/anthropic', 'deepseek-flash', false],
    ['https://api.deepseek.com.example.invalid', 'deepseek-v4-flash', false],
    ['https://example.invalid/v1', 'deepseek-v4-flash', false],
    ['https://api.deepseek.com', 'other-model', false],
  ] as const) {
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      assert.deepEqual(body.thinking, disabled ? { type: 'disabled' } : undefined);
      assert.equal(body.max_tokens, 6000); assert.equal(body.stream, false);
      assert.equal(typeof body.messages.at(-1).content, 'string');
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"lines":[]}' }, finish_reason: 'stop' }] }));
    };
    await streamLearningChat({ ...ai, baseURL, chatModel }, [{ role: 'user', content: '合成字幕' }], {
      signal: new AbortController().signal, stream: false, maxOutputTokens: 6000, onText: () => {}, intent: 'subtitle_correction',
    });
  }
});

test('network errors and malformed bodies do not escape as raw provider details', async () => {
  globalThis.fetch = async () => { throw new TypeError('private network URL'); };
  assert.match((await ask('network')).message, /无法连接/);
  globalThis.fetch = async () => new Response('<html>private error</html>');
  assert.match((await ask('malformed')).message, /格式无法读取/);
  globalThis.fetch = async () => new Response('null');
  assert.match((await ask('empty')).message, /没有返回回答正文/);
});

test('reasoning-only streamed limit stays private and accurately classified', async () => {
  globalThis.fetch = async () => new Response('data: {"choices":[{"delta":{"reasoning_content":"private reasoning"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  const result = await ask('stream-reasoning');
  assert.equal(result.answer, ''); assert.match(result.message, /思考.*预算/);
  assert.doesNotMatch(result.message, /private reasoning/);
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

test('quota pressure rejects derived context and partial writes without evicting any original conversation', async () => {
  const input = { sessionId: 'target', turnId: 'turn', requestId: 'quota', question: '整理', source: null, answerMode: 'learning' as const };
  const guard = registerCurrentVideoQaSessionTurnWriteGuard(input);
  try {
    await upsertCurrentVideoQaPendingTurn({ ...input, writeGuard: guard });
    const target = (await db.currentVideoQaSessions.where({ sessionId: 'target' }).first())!;
    const other = structuredClone(target); delete other.id; other.sessionId = 'original'; other.lastAccessedAt = 1;
    const id = await db.currentVideoQaSessions.add(other);
    const usage = await collectCurrentVideoQaSessionUsage();
    other.id = Number(id); other.turns[0].answer = 'a'.repeat(CURRENT_VIDEO_QA_SESSION_MAX_BYTES - usage.usageBytes - 1000);
    await db.currentVideoQaSessions.put(other);
    assert.ok((await collectCurrentVideoQaSessionUsage()).usageBytes < CURRENT_VIDEO_QA_SESSION_MAX_BYTES);
    await assert.rejects(saveLearningChatContext('target', { version: 1, video: null, summaries: [
      { turnIds: ['old'], digest: 'synthetic', start: 0, end: 1, text: 'x'.repeat(1600) },
    ] }, guard, () => true), isCurrentVideoQaSessionStorageLimitError);
    await assert.rejects(saveLearningChatPartial('target', 'turn', 'quota', 'b'.repeat(2000), guard), isCurrentVideoQaSessionStorageLimitError);
    assert.equal(await db.currentVideoQaSessions.count(), 2);
    assert.equal((await db.currentVideoQaSessions.where({ sessionId: 'original' }).first())?.turns[0].answer.length, other.turns[0].answer.length);
    const unchanged = await db.currentVideoQaSessions.where({ sessionId: 'target' }).first();
    assert.equal(unchanged?.learningContext, undefined); assert.equal(unchanged?.turns[0].answer, '');
  } finally { settleCurrentVideoQaSessionTurnWriteGuard(guard); }
});
