import test from 'node:test';
import assert from 'node:assert/strict';
import { budget, createReport, inheritHistory, type Plan, type Material, type Report } from '../src/dev/acceptance/contract.ts';
import { canonicalJson, digest } from '../src/dev/acceptance/identity.ts';
import { recoveryCanAppend, recoveryDestinationEmpty, validateRecovery } from '../src/dev/acceptance/recovery.ts';

async function fixture() {
  const plan: Plan = { version: 1, id: 'recovery-v1', targets: [{ id: 'one', bvid: 'BV1Eval00001', page: 1 }], outputTokens: 2048, steps: [{ id: 'overview', target: 'one', feature: 'overview' }] };
  const report = await createReport(plan);
  const body: Omit<Material, 'hash'> = { version: 1, target: plan.targets[0], cid: 1, title: 'synthetic', capturedAt: '2026-10-06T00:00:00Z', build: { sourceCommit: 'synthetic', buildHash: 'synthetic' }, source: 'bilibili_subtitle', sourceType: 'bilibili_player_v2', language: 'zh-CN', lines: [{ lineNo: 1, startSeconds: 0, endSeconds: 1, text: 'synthetic' }], evidence: 'mock' };
  report.materials.one = { ...body, hash: await digest(canonicalJson(body)) };
  return { book: { version: 1, ledgerId: '1769d346-3688-4071-bec2-f340d69722e3', reports: [report] }, next: { ...plan, id: 'recovery-v2', reuseFrom: report.planHash } };
}
test('restore validates package binding and preserves the original report', async () => {
  const { book, next } = await fixture(), raw = JSON.stringify(book);
  assert.deepEqual(await validateRecovery(raw, await digest(raw), next), book);
  await assert.rejects(validateRecovery(raw + ' ', await digest(raw), next), /RECOVERY_INVALID/);
  await assert.rejects(validateRecovery(raw, await digest(raw), { ...next, reuseFrom: '0'.repeat(64) }), /RECOVERY_INVALID/);
});
test('a changed material cannot be imported with its old evidence hash', async () => {
  const { book, next } = await fixture();
  book.reports[0].materials.one.lines[0].text = 'changed';
  const raw = JSON.stringify(book);
  await assert.rejects(validateRecovery(raw, await digest(raw), next), /RECOVERY_INVALID/);
});
test('recovery refuses to overwrite any existing ledger', () => {
  assert.equal(recoveryDestinationEmpty(undefined), true);
  for (const value of [null, {}, { reports: [] }, { version: 1, reports: [{ rows: [] }] }]) assert.equal(recoveryDestinationEmpty(value), false);
});

test('a third plan can recover the complete two-round history without resetting its charges', async () => {
  const { book, next } = await fixture();
  const second = await createReport(next);
  inheritHistory(second, book.reports);
  book.reports.push(second);
  const third = { ...next, id: 'recovery-v3', reuseFrom: second.planHash };
  const raw = JSON.stringify(book);
  assert.deepEqual(await validateRecovery(raw, await digest(raw), third), book);
  const prefix = { ...book, reports: book.reports.slice(0, 1) };
  assert.equal(recoveryCanAppend(undefined, book), true);
  assert.equal(recoveryCanAppend(prefix, book), true);
  assert.equal(recoveryCanAppend(book, book), false);
  assert.equal(recoveryCanAppend({ ...prefix, ledgerId: 'other' }, book), false);
  const modified = structuredClone(prefix); modified.reports[0].pause = 'changed';
  assert.equal(recoveryCanAppend(modified, book), false);
  for (const invalid of [null, {}, { ...book, reports: [] }]) assert.equal(recoveryCanAppend(invalid, book), false);
  second.priorCharges = [];
  const missing = JSON.stringify(book);
  await assert.rejects(validateRecovery(missing, await digest(missing), third), /RECOVERY_INVALID/);
});

function networkFailure(report: Report) {
  report.rows.push({ id: 'overview', target: 'one', feature: 'overview', state: 'failed', attempted: true,
    tokenReservation: 100000, startedAt: '2026-10-06T00:00:00Z', model: 'synthetic',
    materialHash: report.materials.one.hash, build: { sourceCommit: 'synthetic', buildHash: 'synthetic' },
    parameters: {}, messages: [], inputHash: '1'.repeat(64), text: '', error: 'CHAT_NETWORK' });
  report.pause = 'ACCEPTANCE_USAGE_UNKNOWN';
  return { id: `${report.planHash}:overview`, reservation: 100000 };
}

async function unknownFixture() {
  const { book, next } = await fixture();
  const first = networkFailure(book.reports[0]);
  const second = await createReport({ ...next, retainedUnknown: [first] });
  inheritHistory(second, book.reports);
  const last = networkFailure(second);
  book.reports.push(second);
  const plan: Plan = { ...next, id: 'recovery-v3', reuseFrom: second.planHash, retainedUnknown: [first, last] };
  return { book, plan };
}

test('package recovery preserves two explicitly retained network failures without authorizing or settling them', async () => {
  const { book, plan } = await unknownFixture(), raw = JSON.stringify(book);
  const restored = await validateRecovery(raw, await digest(raw), plan);
  assert.deepEqual(restored, book);
  assert.equal(JSON.stringify(book), raw);
  const fresh = await createReport(plan); inheritHistory(fresh, restored.reports);
  assert.equal(budget(fresh).measured, 58493);
  assert.equal(budget(fresh).unknown, 2);
  assert.equal(budget(fresh).reserved, 200000);
  assert.equal(fresh.rows.length, 0);
  assert.equal(recoveryCanAppend(undefined, restored), true);
  assert.equal(recoveryCanAppend({ ...book, reports: book.reports.slice(0, 1) }, restored), true);
  const conflict = structuredClone(book); conflict.reports[0].rows[0].text = 'local edit';
  assert.equal(recoveryCanAppend({ ...conflict, reports: conflict.reports.slice(0, 1) }, restored), false);
});

test('unknown recovery requires every exact retained charge and its original reservation', async () => {
  const { book, plan } = await unknownFixture(), raw = JSON.stringify(book), hash = await digest(raw);
  for (const retainedUnknown of [undefined, plan.retainedUnknown!.slice(0, 1),
    plan.retainedUnknown!.map((charge, index) => index ? charge : { ...charge, reservation: 101000 }),
    [...plan.retainedUnknown!, { id: `${'0'.repeat(64)}:other`, reservation: 100000 }]]) {
    await assert.rejects(validateRecovery(raw, hash, { ...plan, retainedUnknown }), /RECOVERY_INVALID/);
  }
});

test('unknown recovery rejects running, interrupted, non-network and settled-but-paused substitutions', async () => {
  for (const mutation of ['running', 'interrupted', 'auth', 'settled', 'prior']) {
    const { book, plan } = await unknownFixture(), row = book.reports.at(-1)!.rows[0];
    if (mutation === 'running' || mutation === 'interrupted') row.state = mutation;
    if (mutation === 'auth') row.error = 'CHAT_AUTH';
    if (mutation === 'settled') row.observation = { model: 'synthetic', finishReason: 'stop',
      usage: { totalTokens: 0, promptTokens: 0, completionTokens: 0 } };
    if (mutation === 'prior') book.reports.at(-1)!.priorCharges[0].reserved--;
    const raw = JSON.stringify(book);
    await assert.rejects(validateRecovery(raw, await digest(raw), plan), /RECOVERY_INVALID/);
  }
});
