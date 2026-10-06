import test from 'node:test';
import assert from 'node:assert/strict';
import { createReport, type Plan, type Material } from '../src/dev/acceptance/contract.ts';
import { canonicalJson, digest } from '../src/dev/acceptance/identity.ts';
import { recoveryDestinationEmpty, validateRecovery } from '../src/dev/acceptance/recovery.ts';

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
