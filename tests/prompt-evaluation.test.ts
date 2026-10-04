import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { CASES } from '../src/dev/prompt-eval/cases.ts';
import { prepareCase } from '../src/dev/prompt-eval/prepare.ts';
import { EvalEngine, createReport, checkOutput, verdict, recoverReport, validateGrade } from '../src/dev/prompt-eval/engine.ts';
import { observeAiResponse } from '../src/shared/ai-response-observation.ts';
import { streamLearningChat } from '../src/background/ai/learning-chat-transport.ts';
import { chatJson } from '../src/background/ai/openai-compatible.ts';

const baseline = JSON.parse(await readFile(new URL('./fixtures/prompt-eval/baseline.json', import.meta.url), 'utf8'));
const binding = { sourceCommit: 'synthetic-test', buildHash: 'test', datasetHash: 'fixed', baselineCommit: 'prior' };
const config = { stamp: 'same', model: 'text', imageModel: 'vision', vision: true, parameters: {} };
function harness(extra: Record<string, any> = {}) {
  let calls = 0; const saved: any[] = [];
  const engine = new EvalEngine(createReport(binding), { baseline, current: async () => config,
    save: async report => { saved.push(structuredClone(report)); },
    execute: async (_item, _messages, _signal, onText) => { calls++; assert.ok(saved.at(-1).rows.some((r: any) => r.state === 'running' && r.attempted)); onText('合成回答，不是模型效果证据。'); return '合成回答'; }, ...extra });
  return { engine, saved, calls: () => calls };
}
test('16 frozen cases, image bytes and original production baseline remain bound', async () => {
  assert.equal(CASES.length, 16); assert.equal(new Set(CASES.map(c => c.id)).size, 16);
  for (const feature of ['overview', 'chat', 'subtitles', 'image']) assert.equal(CASES.filter(c => c.feature === feature).length, 4);
  const manifest = JSON.parse(await readFile(new URL('./fixtures/prompt-eval/manifest.json', import.meta.url), 'utf8'));
  for (const [file, hash] of Object.entries(manifest.hashes)) assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), hash, file);
  for (const item of CASES) {
    assert.ok(item.facts.length && item.forbidden.length && item.format);
    const candidate = prepareCase(item);
    assert.deepEqual(candidate.slice(1), baseline[item.id].slice(1), item.id + ' fixed identical inputs/history');
    assert.notEqual(candidate[0].content, baseline[item.id][0].content);
  }
});
test('format checks reject missing evidence, repeated overview, changed line order, extra fields and fake citations', () => {
  const overview = CASES[0];
  const output = { summarySentences: [{ text: '版本检查帮助发现旧值。', evidenceLineNumbers: [1, 3] }],
    keyPoints: [{ text: '价格从100变为80。', evidenceLineNumbers: [2] }], highlights: [{ title: '价格演示', description: '第二次请求返回80元。', evidenceLineNumbers: [4] }] };
  assert.equal(checkOutput(overview, JSON.stringify(output))?.format, true);
  assert.equal(checkOutput(overview, JSON.stringify({ ...output, startSeconds: 999 }))?.format, false);
  assert.equal(checkOutput(overview, JSON.stringify({ ...output, highlights: [{ title: '重复', description: output.summarySentences[0].text, evidenceLineNumbers: [1] }] }))?.format, false);
  assert.equal(checkOutput(overview, JSON.stringify({ ...output, highlights: [{ title: '错误', description: '不存在的行。', evidenceLineNumbers: [999] }] }))?.format, false);
  const correction = CASES.find(c => c.id === 'subtitles-punctuation')!;
  assert.equal(checkOutput(correction, JSON.stringify({ lines: [{ id: '2', text: '后行' }, { id: '1', text: '前行' }] }))?.format, false);
  const knowledge = CASES.find(c => c.id === 'chat-knowledge')!;
  assert.equal(checkOutput(knowledge, '根据个人笔记[2]。')?.format, false);
  assert.equal(checkOutput(knowledge, '知识库·个人笔记[1]：先删除缓存。\n\n视频内容：先写入，再失效。')?.format, true);
});
test('32 serial calls reserve before sending, keep every output and never self-award semantic pass', async () => {
  const h = harness(); await h.engine.run(); assert.equal(h.calls(), 32);
  assert.ok(h.engine.report.rows.every(row => row.state === 'complete' && row.text && row.promptHash && row.inputHash));
  assert.ok(h.engine.report.rows.every(row => verdict(row) === 'unreviewed'));
  assert.equal(h.engine.report.realModelAcceptance, 'review_required');
  for (const item of CASES) {
    const pair = h.engine.report.rows.filter(row => row.caseId === item.id);
    assert.equal(pair[0].inputHash, pair[1].inputHash);
    assert.equal(pair[0].model, pair[1].model);
  }
  await h.engine.run(); assert.equal(h.calls(), 32);
});
test('authentication/balance failure halts without automatic retry and preserves failure', async () => {
  for (const code of ['CHAT_AUTH', 'CHAT_BALANCE', 'AI_REQUEST_FAILED_401', 'AI_REQUEST_FAILED_402', 'AI_REQUEST_FAILED_403']) {
    let calls = 0; const h = harness({ execute: async () => { calls++; throw Error(code); } });
    await h.engine.run(); assert.equal(calls, 1); assert.equal(h.engine.report.rows[0].error, code);
    assert.equal(h.engine.report.rows.filter(row => row.state === 'queued').length, 31);
  }
});
test('48-call cap includes failed and interrupted requests; retries append without overwriting', async () => {
  const h = harness(); await h.engine.run();
  for (let i = 0; i < 16; i++) await h.engine.retry(h.engine.report.rows[0].id, '核对稳定性');
  assert.equal(h.calls(), 48); assert.equal(h.engine.report.rows.length, 48);
  await assert.rejects(h.engine.retry(h.engine.report.rows[0].id, '再试'), /EVAL_LIMIT/);
  assert.equal(h.engine.report.rows[32].retryOf, h.engine.report.rows[0].id);
});
test('stop preserves partial text; restart does not resend interrupted attempts', async () => {
  const h = harness({ execute: async (_c: any, _m: any, signal: AbortSignal, onText: Function) => {
    onText('已经收到的片段'); h.engine.stop(); assert.ok(signal.aborted); throw new DOMException('Aborted', 'AbortError');
  } });
  await h.engine.run(); assert.equal(h.engine.report.rows[0].state, 'cancelled'); assert.equal(h.engine.report.rows[0].text, '已经收到的片段');
  assert.equal(h.engine.report.rows[1].state, 'queued');
  const interrupted = structuredClone(h.engine.report); interrupted.rows[0].state = 'running';
  assert.equal(recoverReport(interrupted).rows[0].state, 'interrupted');
  assert.equal(interrupted.rows[0].attempted, true);
});
test('config drift and disabled vision stop before another request; storage failure sends nothing', async () => {
  let n = 0; const h = harness({ current: async () => ({ ...config, stamp: ++n > 1 ? 'changed' : 'same' }) });
  await assert.rejects(h.engine.run(), /EVAL_CONFIG_CHANGED/); assert.equal(h.calls(), 1);
  const disabled = harness({ current: async () => ({ ...config, vision: false }) });
  await assert.rejects(disabled.engine.run(), /EVAL_VISION_DISABLED/); assert.equal(disabled.calls(), 0);
  const broken = harness({ save: async () => { throw Error('disk full'); } });
  await assert.rejects(broken.engine.run(), /disk full/); assert.equal(broken.calls(), 0);
});
test('grading cannot hide severe failures or skip factual review, even with full scores', () => {
  const grade = validateGrade({ scores: [2, 2, 2, 2, 2], hardFactsPass: true, severe: true, cause: 'model', notes: '编造了一个来源', reviewer: '测试审核' });
  const row: any = { state: 'complete', checks: { format: true, failures: [] }, grade };
  assert.equal(verdict(row), 'fail'); row.grade.severe = false; assert.equal(verdict(row), 'pass');
  row.grade.hardFactsPass = false; assert.equal(verdict(row), 'fail');
  assert.throws(() => validateGrade({ ...grade, scores: [3, 3, 3, 3, 3] }), /EVAL_GRADE/);
  assert.throws(() => validateGrade({ ...grade, notes: '' }), /EVAL_GRADE/);
});
test('supplemental results bind their own build without relabeling previous attempts', async () => {
  const original = harness(); await original.engine.run();
  const upgraded = new EvalEngine(structuredClone(original.engine.report), { baseline, build: { sourceCommit: 'repair', buildHash: 'repair-build' },
    save: async () => {}, current: async () => config, execute: async (_c, _m, _s, onText) => { onText('补测回答'); return '补测回答'; } });
  await upgraded.retry(upgraded.report.rows[0].id, '修复后核对');
  assert.equal(upgraded.report.rows[0].sourceCommit, 'synthetic-test');
  assert.equal(upgraded.report.rows[32].sourceCommit, 'repair');
  assert.equal(upgraded.report.rows.filter(row => row.attempted).length, 33);
});
test('response observations allowlist usage and do not expose arbitrary provider data', () => {
  assert.deepEqual(observeAiResponse({ apiKey: 'do-not-export', headers: { secret: 'x' }, model: 'example-model', choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, secret: 'x' } }),
    { model: 'example-model', finishReason: 'stop', usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } });
  assert.equal(observeAiResponse({ usage: { total_tokens: -1 } }).usage.totalTokens, null);
});
test('production transports expose raw text and usage without changing outgoing parameters', async () => {
  const original = globalThis.fetch; const bodies: any[] = [], observations: any[] = [], texts: string[] = [];
  globalThis.fetch = async (_url, options) => { bodies.push(JSON.parse(String(options?.body))); return new Response(JSON.stringify({ model: 'model-actual', usage: { total_tokens: 7 }, choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] })); };
  try {
    const config = { baseURL: 'https://example.invalid', apiKey: 'synthetic', chatModel: 'test' };
    const messages = [{ role: 'user' as const, content: 'synthetic' }];
    await chatJson(config, messages, { onText: text => texts.push(text), onResponse: v => observations.push(v) });
    await chatJson(config, messages); assert.deepEqual(bodies[0], bodies[1]);
    await streamLearningChat(config, messages, { signal: new AbortController().signal, stream: false, onText: text => texts.push(text), onResponse: v => observations.push(v) });
    assert.equal(observations.length, 2); assert.equal(observations[0].usage.totalTokens, 7);
    assert.equal(observations[1].model, 'model-actual'); assert.deepEqual(texts, ['{"ok":true}', '{"ok":true}']);
  } finally { globalThis.fetch = original; }
});
