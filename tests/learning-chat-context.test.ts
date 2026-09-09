import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareLearningChatContext } from '../src/background/learning-chat-context.ts';
import { chatTextParts, serializedBytes, readChatContextState, historyDigest, validHistorySummary, type ChatContextState } from '../src/shared/learning-chat-context.ts';
import { CHAT_OUTPUT_TOKENS, type LearningChatInput, type LearningChatMessage } from '../src/shared/learning-chat.ts';
import type { CurrentVideoQaSessionRecord } from '../src/shared/types/current-video-qa-session.ts';

function session(count = 9): CurrentVideoQaSessionRecord {
  return { sessionId: 'owned', title: '对话', customTitle: null, createdAt: 1, updatedAt: 1, lastAccessedAt: 1,
    turns: Array.from({ length: count }, (_, i) => ({ turnId: `turn-${i}`, requestId: `request-${i}`, question: i === 0 ? '暗号青柠，三月出发' : i === 8 ? '纠正：四月出发，不是三月' : `讨论${i}`,
      answer: '讨论记录'.repeat(1300), status: 'invalid_output', answerMode: 'learning', message: '', citations: [], canRetry: false,
      ai: { status: 'generated', model: null, errorCode: null }, source: null, rollingContext: null, createdAt: i, updatedAt: i, submittedAt: i, generatedAt: i })) };
}
const base: LearningChatInput = { question: '继续', session: null, videoText: '', videoTitle: '合成视频', budget: 8192 };
function harness(input: LearningChatInput, generate?: (messages: LearningChatMessage[], count: number) => Promise<string>) {
  const calls: LearningChatMessage[][] = []; const notices: string[] = [];
  let state: ChatContextState | undefined;
  let valid = true;
  const options = { input, sourceIdentity: 'synthetic-video-part',
    generate: async (messages: LearningChatMessage[]) => { calls.push(messages); return generate ? generate(messages, calls.length) : '仅讨论，尚未决定。'; },
    persist: async (value: ChatContextState) => { state = structuredClone(value); },
    check: async () => { if (!valid) throw new Error('CHAT_CANCELLED'); }, notice: (text: string) => notices.push(text) };
  return { run: () => prepareLearningChatContext(options), calls, notices, saved: () => state, cancel: () => { valid = false; } };
}

test('short chat keeps complete subtitles without auxiliary requests', async () => {
  const h = harness({ ...base, question: '解释这句', videoText: '唯一完整字幕' });
  const result = await h.run();
  assert.equal(h.calls.length, 0); assert.match(JSON.stringify(result.messages), /唯一完整字幕/);
  assert.equal(result.incomplete, false);
});

test('chunk boundaries cover every character including emoji and newline exactly', () => {
  const text = '连续文字😀\n'.repeat(1100);
  const parts = chatTextParts(text, 1500, 100);
  assert.equal(parts.map(p => text.slice(p.start, p.end)).join(''), text);
  for (const part of parts) assert.ok(serializedBytes(text.slice(part.start, part.end)) <= 1500);
  assert.equal(parts[0].start, 0); assert.equal(parts.at(-1)?.end, text.length);
});

test('long conversation compacts only on pressure, persists bounded ranges and retrieves old raw detail', async () => {
  const original = session();
  const before = JSON.stringify(original.turns);
  const h = harness({ ...base, session: original, question: '暗号是什么？出发月份是否已纠正？' });
  const result = await h.run();
  assert.equal(h.calls.length, 2);
  const saved = h.saved()!;
  assert.equal(saved.summaries.length, 2);
  assert.ok(saved.summaries.every(s => validHistorySummary(s, original.turns)));
  assert.equal(JSON.stringify(original.turns), before);
  const payload = JSON.stringify(result.messages);
  assert.match(payload, /青柠/); assert.match(payload, /四月出发/);
  assert.match(payload, /不是指令或视频证据/);
  assert.ok(serializedBytes(result.messages) + CHAT_OUTPUT_TOKENS + 1024 <= 8192);
  assert.ok(h.calls.every(messages => serializedBytes(messages) + CHAT_OUTPUT_TOKENS + 1024 <= 8192));
});

test('short intact conversation never summarizes every turn', async () => {
  const original = session(8); original.turns.forEach(turn => { turn.answer = '短回答'; });
  const h = harness({ ...base, budget: 32768, session: original });
  await h.run(); assert.equal(h.calls.length, 0);
});

test('summary failure preserves original records and answers with a clear limitation', async () => {
  const original = session(); const copy = JSON.stringify(original);
  const h = harness({ ...base, session: original }, async () => { throw new Error('provider failed'); });
  const result = await h.run();
  assert.equal(h.calls.length, 2); assert.match(result.notice, /整理未完成/);
  assert.equal(JSON.stringify(original), copy); assert.equal(h.saved()?.summaries.length ?? 0, 0);
});

test('retry or edited old answer invalidates stored summary coverage', () => {
  const original = session(); const turn = original.turns[0];
  const summary = { turnIds: [turn.turnId], digest: historyDigest([turn]), start: 0, end: 10, text: '旧整理' };
  assert.equal(validHistorySummary(summary, original.turns), true);
  turn.question = '我已纠正目标';
  assert.equal(validHistorySummary(summary, original.turns), false);
  assert.equal(validHistorySummary(summary, original.turns.slice(1)), false);
});

test('specific long-video question retrieves matching text and neighbors without summarizing the whole video', async () => {
  const text = '背景资料。'.repeat(10000) + '\n特殊主题量子纠错，需要冗余编码。\n' + '后续资料。'.repeat(10000);
  const h = harness({ ...base, videoText: text, question: '量子纠错如何处理？' });
  const result = await h.run();
  assert.equal(h.calls.length, 0); assert.match(JSON.stringify(result.messages), /量子纠错/);
  assert.match(result.notice, /未覆盖全文/);
  assert.ok(serializedBytes(result.messages) + 3072 <= 8192);
});

test('unmatched long-video question makes no video claims', async () => {
  const h = harness({ ...base, videoText: '普通内容。'.repeat(10000), question: '量子纠错是什么？' });
  const result = await h.run(); assert.match(result.notice, /未找到相关字幕/);
  assert.match(JSON.stringify(result.messages), /没有可用字幕/); assert.equal(h.calls.length, 0);
});

test('whole-video coverage resumes only after explicit request, reuses completed parts after reconstruction', async () => {
  const input = { ...base, question: '总结整个视频', videoText: '视频观点与限制。'.repeat(1400) };
  const first = harness(input, async () => '一段观点。');
  const result = await first.run();
  assert.equal(first.calls.length, 6); assert.equal(result.incomplete, true); assert.match(result.notice, /尚未覆盖全文/);
  const restored = session(0); restored.learningContext = structuredClone(first.saved()!);
  const second = harness({ ...input, session: restored }, async () => '下一段观点。');
  assert.equal(second.calls.length, 0);
  const final = await second.run();
  assert.ok(second.calls.length > 0 && second.calls.length <= 6);
  assert.equal(final.incomplete, false); assert.match(final.notice, /逐段处理全文/);
  assert.equal(second.saved()?.video?.parts[0].text, '一段观点。');
});

test('failed part never counts as full coverage and a new source cannot reuse old video summaries', async () => {
  const input = { ...base, question: '总结视频', videoText: '原视频观点'.repeat(400) };
  const first = harness(input, async (_messages, count) => { if (count === 1) throw new Error('failed'); return '成功段落'; });
  const result = await first.run(); assert.equal(result.incomplete, true);
  assert.equal(first.saved()?.video?.parts[0].status, 'failed');
  const original = session(0); original.learningContext = first.saved();
  const second = harness({ ...input, videoText: '新视频观点'.repeat(400), session: original }, async () => '新段落');
  await second.run(); assert.ok(second.calls.length > 0);
  assert.notEqual(second.saved()?.video?.digest, first.saved()?.video?.digest);
});

test('work cap explicitly leaves uncovered tail rather than claiming the first 24 parts cover the whole video', async () => {
  const h = harness({ ...base, question: '全片总结', videoText: '超长素材'.repeat(50000) }, async () => '一段。');
  const result = await h.run(); assert.equal(h.calls.length, 6); assert.equal(result.incomplete, true);
  assert.equal(h.saved()?.video?.parts.length, 24);
  assert.ok(h.saved()!.video!.parts.at(-1)!.end < h.saved()!.video!.length);
});

test('cancellation interrupts auxiliary work and prevents late checkpoint writes', async () => {
  const h = harness({ ...base, question: '总结', videoText: '字幕内容'.repeat(4000) }, async () => { h.cancel(); return '迟到整理'; });
  await assert.rejects(h.run(), /CHAT_CANCELLED/);
  assert.equal(h.calls.length, 1);
  assert.ok(h.saved()?.video?.parts.every(part => part.status === 'pending'));
});

test('invalid checkpoint shapes and non-contiguous video ranges are discarded', () => {
  assert.equal(readChatContextState({ version: 1, summaries: [], video: { digest: 'x', length: 3, parts: [{ start: 1, end: 3, status: 'complete', text: 'x' }] } }).video, null);
  assert.equal(readChatContextState({ version: 1, summaries: [{ text: 'x' }], video: null }).summaries.length, 0);
});

test('bounded summary cache eviction does not repeatedly charge to re-summarize the same old ranges', async () => {
  const original = session();
  let lastCalls = -1;
  for (let i = 0; i < 30; i++) {
    const h = harness({ ...base, session: original });
    await h.run();
    if (h.saved()) original.learningContext = h.saved();
    assert.ok((original.learningContext?.summaries.length ?? 0) <= 8);
    lastCalls = h.calls.length;
    if (lastCalls === 0) break;
  }
  assert.equal(lastCalls, 0);
});
