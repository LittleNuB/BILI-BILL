import test from 'node:test';
import assert from 'node:assert/strict';
import { AcceptanceEngine } from '../src/dev/acceptance/engine.ts';
import { budget, createReport, digest, matchesTarget, validatePlan, type Material, type Plan } from '../src/dev/acceptance/contract.ts';
import { prepare, checkOutput } from '../src/dev/acceptance/production.ts';
import { DEFAULT_PROMPTS } from '../src/shared/ai-prompts.ts';

const plan: Plan = { version: 1, id: 'synthetic-v1', targets: [{ id: 'one', bvid: 'BV1Eval00001', page: 1 }], outputTokens: 16384,
  steps: [{ id: 'overview', target: 'one', feature: 'overview' }, { id: 'chat', target: 'one', feature: 'chat', question: '解释第一句' },
    { id: 'followup', target: 'one', feature: 'chat', question: '再举一个例子', after: 'chat' },
    { id: 'subtitles', target: 'one', feature: 'subtitles', subtitleBatch: 0 }, { id: 'image', target: 'one', feature: 'image', question: '解释当前画面' }] };
const build = { sourceCommit: 'synthetic-source', buildHash: 'synthetic-build' };
const prompts = { revision: '', values: {}, previous: {} };
const settings = { stamp: 'fixed', model: 'mock-text', imageModel: 'mock-vision', vision: true, stream: true, prompts };
const usage = { model: 'mock-provider', finishReason: 'stop', usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 } };
async function material(): Promise<Material> {
  const data = 'data:image/png;base64,aGVsbG8=';
  const body: Omit<Material, 'hash'> = { version: 1, target: plan.targets[0], cid: 111, title: '合成视频，仅为测试', build,
    capturedAt: '2026-10-06T00:00:00Z', source: 'bilibili_subtitle', sourceType: 'bilibili_player_v2', language: 'zh-CN', evidence: 'mock',
    lines: [{ lineNo: 1, startSeconds: 0, endSeconds: 3, text: '缓存先写入再失效。' }, { lineNo: 2, startSeconds: 3, endSeconds: 6, text: '本次字幕可能有错误。' }],
    frame: { data, timeMs: 3500, capturedAt: 1, sha256: await digest(data) } };
  return { ...body, hash: await digest(JSON.stringify(body)) };
}
async function harness(extra: any = {}, original?: any) {
  let calls = 0; const saved: any[] = [];
  const engine = new AcceptanceEngine(original ?? await createReport(plan), { build, settings: async () => settings,
    save: async report => { saved.push(structuredClone(report)); }, capture: async () => material(),
    execute: async (row, _step, _material, _signal, text, observe) => {
      calls++; assert.equal(saved.at(-1).rows.at(-1).state, 'running'); assert.equal(saved.at(-1).rows.at(-1).tokenReservation, 100000);
      assert.equal(row.parameters.max_tokens, row.feature === 'subtitles' ? 6000 : 16384);
      text('视频内容：合成回答，仅用于程序测试。'); observe(usage); return '合成回答';
    }, ...extra });
  return { engine, saved, calls: () => calls };
}
test('plan rejects arbitrary operations, unknown fields, duplicate identities and forward or cross-video histories', () => {
  assert.deepEqual(validatePlan(plan), plan);
  for (const invalid of [{ ...plan, eval: 'x' }, { ...plan, steps: [{ ...plan.steps[0], feature: 'eval' }] },
    { ...plan, targets: [...plan.targets, plan.targets[0]] }, { ...plan, steps: [{ ...plan.steps[1], after: 'followup' }] }]) assert.throws(() => validatePlan(invalid));
  assert.equal(matchesTarget('https://www.bilibili.com/video/BV1Eval00001/?p=1&spm=x', plan.targets[0]), true);
  for (const url of ['https://evilbilibili.com/video/BV1Eval00001/', 'https://www.bilibili.com/video/BV1Eval00001/?p=2', 'http://www.bilibili.com/video/BV1Eval00001/']) assert.equal(matchesTarget(url, plan.targets[0]), false);
});
test('authorization, immutable capture, cumulative floor, idempotent charged commands and production prompts', async () => {
  const h = await harness();
  assert.equal(budget(h.engine.report).measured, 58493);
  await assert.rejects(h.engine.run('chat'), /REVOKED/); assert.equal(h.calls(), 0);
  await h.engine.authorize(); await h.engine.capture('one');
  await h.engine.run('chat'); await h.engine.run('chat'); await h.engine.run('followup');
  assert.equal(h.calls(), 2); assert.equal(budget(h.engine.report).measured, 58523);
  assert.ok(h.engine.report.rows[1].messages.some(m => m.role === 'assistant' && m.content.includes('合成回答')));
  assert.ok(h.engine.report.rows[0].messages[0].content.includes(DEFAULT_PROMPTS.chat));
  const hash = h.engine.report.materials.one.hash; await h.engine.capture('one'); assert.equal(h.engine.report.materials.one.hash, hash);
  assert.equal(h.engine.report.evidence.realSiteUi, 'not_run'); assert.equal(h.engine.report.evidence.realModel, false);
});
test('missing source, frame, history and unplanned steps cannot invoke model', async () => {
  const h = await harness(); await h.engine.authorize();
  await assert.rejects(h.engine.run('overview'), /MATERIAL_REQUIRED/); await assert.rejects(h.engine.run('unknown'), /STEP/);
  await h.engine.capture('one'); await assert.rejects(h.engine.run('followup'), /HISTORY_REQUIRED/);
  delete h.engine.report.materials.one.frame; await assert.rejects(h.engine.run('image'), /FRAME_REQUIRED/); assert.equal(h.calls(), 0);
});
test('one writer, stopping a running request retains charge, text and usage without replay', async () => {
  let started!: () => void; const waiting = new Promise<void>(r => { started = r; });
  const h = await harness({ execute: async (_row: any, _s: any, _m: any, signal: AbortSignal, text: any, observe: any) => {
    text('已到达的正文'); started(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); observe(usage); throw Error('CHAT_ABORTED');
  } });
  await h.engine.authorize(); await h.engine.capture('one'); const running = h.engine.run('chat'); await waiting;
  await assert.rejects(h.engine.run('image'), /BUSY/); h.engine.revoke(); await running;
  assert.equal(h.engine.report.rows.length, 1); assert.equal(h.engine.report.rows[0].state, 'cancelled'); assert.equal(h.engine.report.rows[0].text, '已到达的正文');
  assert.equal(budget(h.engine.report).measured, 58508);
});
test('unknown usage and authentication errors are durable pauses, including after reopening', async () => {
  for (const error of [null, 'CHAT_AUTH', 'CHAT_BALANCE']) {
    const h = await harness({ execute: async (_r: any, _s: any, _m: any, _signal: any, onText: any) => { onText('已有原文'); if (error) throw Error(error); return '已有原文'; } });
    await h.engine.authorize(); await h.engine.capture('one'); await h.engine.run('chat');
    assert.equal(budget(h.engine.report).reserved, 100000); assert.ok(h.engine.report.pause);
    const recovered = await harness({}, h.engine.report); await recovered.engine.authorize();
    await assert.rejects(recovered.engine.run('image')); assert.equal(recovered.calls(), 0); assert.equal(recovered.engine.report.rows[0].text, '已有原文');
  }
});
test('storage failure before reservation never sends; interrupted reservations do not disappear', async () => {
  const h = await harness(); await h.engine.authorize(); await h.engine.capture('one');
  const report = structuredClone(h.engine.report);
  const fail = await harness({ save: async () => { throw Error('disk'); } }, report); await fail.engine.authorize();
  await assert.rejects(fail.engine.run('chat'), /STORAGE_FAILED/); assert.equal(fail.calls(), 0);
  const recovered = await harness({}, fail.engine.report);
  assert.equal(recovered.engine.report.rows[0].state, 'interrupted'); assert.equal(budget(recovered.engine.report).reserved, 100000);
});
test('prior real-plan charges accumulate and unknown prior plans block new calls', async () => {
  const h = await harness(); h.engine.report.priorCharges.push({ planHash: 'earlier', calls: 2, measured: 100000, reserved: 100000, unknown: 1 });
  await h.engine.authorize(); await h.engine.capture('one'); await assert.rejects(h.engine.run('chat'), /USAGE_UNKNOWN/);
  assert.equal(budget(h.engine.report).measured, 158493); assert.equal(budget(h.engine.report).remaining, 741507);
});
test('all four feature adapters use production contracts and subtitle batches do not hide requests', async () => {
  const h = await harness(); await h.engine.authorize(); await h.engine.capture('one');
  for (const step of plan.steps.filter(s => !s.after)) {
    const messages = prepare(h.engine.report, step, 'mock-text', prompts);
    assert.ok(messages[0].content.includes(DEFAULT_PROMPTS[step.feature]));
  }
  const step = plan.steps.find(s => s.feature === 'subtitles')!;
  assert.equal(checkOutput(h.engine.report, step, '{"lines":[{"id":"2","text":"错序"},{"id":"1","text":"错序"}]}', null, 'mock').format, false);
  const overview = plan.steps[0];
  assert.equal(checkOutput(h.engine.report, overview, '{"summarySentences":[{"text":"伪造","evidenceLineNumbers":[999]}]}', null, 'mock').format, false);
});
test('reports are versioned chunks; grading preserves original output and severe failures veto pass', async () => {
  const h = await harness(); await h.engine.authorize(); await h.engine.capture('one'); await h.engine.run('chat');
  const first = await h.engine.read(0, 100); assert.equal(first.text.length, 100);
  const text = h.engine.report.rows[0].text;
  await h.engine.grade('chat', { scores: [2, 2, 2, 2, 2], hardFactsPass: false, severe: true, cause: 'model', notes: '关键数字错误；合成审阅', reviewer: 'Codex test' });
  await assert.rejects(h.engine.read(100, 100, first.hash), /REPORT_CHANGED/);
  assert.equal(h.engine.report.rows[0].text, text); assert.equal(h.engine.report.reviews.length, 1);
  await assert.rejects(h.engine.read(0, 12001));
});
test('no-body response is generation failure, cannot be graded as observed dishonesty', async () => {
  const h = await harness({ execute: async () => '' }); await h.engine.authorize(); await h.engine.capture('one'); await h.engine.run('chat');
  assert.equal(h.engine.report.rows[0].state, 'failed'); assert.equal(h.engine.report.rows[0].error, 'ACCEPTANCE_EMPTY_OUTPUT');
  await assert.rejects(h.engine.grade('chat', { scores: [0, 0, 0, 0, 0], hardFactsPass: false, severe: true, cause: 'model', notes: 'bad', reviewer: 'test' }), /GENERATION_FAILURE/);
});
