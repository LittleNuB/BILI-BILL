import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBillingGuard } from '../billing.mjs';

test('manual retry grant is bound to exact unknown reservations and finite new charge ids without settling unknown usage', async () => {
  const directory = await mkdtemp(path.join(fileURLToPath(new URL('../../../release-artifacts/', import.meta.url)), 'billing-retry-test-'));
  const file = path.join(directory, 'billing.json'), ledgerId = randomUUID();
  const prior = { id: 'a'.repeat(64) + ':failed', tokens: null, running: false, reservation: 100000 };
  const first = { id: 'b'.repeat(64) + ':first', tokens: null, running: true, reservation: 100000 };
  const second = { ...first, id: 'b'.repeat(64) + ':second' };
  const grant = { planHash: 'b'.repeat(64), stepIds: ['first', 'second'], retainedUnknown: [{ id: prior.id, reservation: 100000 }] };
  let checkpoint = createBillingGuard(file); checkpoint(ledgerId, [prior]);
  assert.throws(() => checkpoint(ledgerId, [prior, first]), /BUDGET/);
  assert.throws(() => checkpoint(ledgerId, [prior, first], { ...grant, retainedUnknown: [] }), /RETRY/);
  assert.throws(() => checkpoint(ledgerId, [prior, first], { ...grant, retainedUnknown: [{ id: prior.id, reservation: 150000 }] }), /RETRY/);
  assert.throws(() => checkpoint(ledgerId, [prior, first], { ...grant, stepIds: ['first', 'first'] }), /RETRY/);
  checkpoint(ledgerId, [prior], grant); checkpoint(ledgerId, [prior, first], grant);
  assert.throws(() => checkpoint(ledgerId, [prior, first, second], grant), /BUDGET/);
  const done = { ...first, tokens: 20, running: false }; checkpoint(ledgerId, [prior, done], grant);
  checkpoint = createBillingGuard(file); checkpoint(ledgerId, [prior, done], grant);
  assert.throws(() => checkpoint(ledgerId, [prior, done, { ...second, id: 'c'.repeat(64) + ':other' }], grant), /RETRY/);
  checkpoint(ledgerId, [prior, done, second], grant);
  const unknownAgain = { ...second, running: false }; checkpoint(ledgerId, [prior, done, unknownAgain], grant);
  checkpoint = createBillingGuard(file);
  checkpoint(ledgerId, [prior, done, unknownAgain], grant);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(stored.charges[0].tokens, null); assert.equal(stored.charges[0].reservation, 100000);
  assert.equal(stored.continuations.length, 1); assert.deepEqual(stored.continuations[0].grant, grant);
  assert.throws(() => checkpoint(ledgerId, [{ ...prior, tokens: 0 }, done, unknownAgain], grant), /ROLLBACK/);
});

test('a newly unknown retry allows identical-charge review checkpoints and reconnect but blocks its unattempted paid step', async () => {
  const directory = await mkdtemp(path.join(fileURLToPath(new URL('../../../release-artifacts/', import.meta.url)), 'billing-retry-review-'));
  const file = path.join(directory,'billing.json'), ledgerId = randomUUID();
  const prior = {id:'a'.repeat(64)+':failed',tokens:null,running:false,reservation:100000};
  const first = {id:'b'.repeat(64)+':first',tokens:null,running:true,reservation:100000};
  const second = {...first,id:'b'.repeat(64)+':second'};
  const grant = {planHash:'b'.repeat(64),stepIds:['first','second'],retainedUnknown:[{id:prior.id,reservation:100000}]};
  let checkpoint = createBillingGuard(file); checkpoint(ledgerId,[prior]);
  checkpoint(ledgerId,[prior],grant); checkpoint(ledgerId,[prior,first],grant);
  const failed = {...first,running:false}; checkpoint(ledgerId,[prior,failed],grant);
  const before = JSON.parse(await readFile(file,'utf8'));
  checkpoint(ledgerId,[prior,failed],grant); checkpoint = createBillingGuard(file);
  checkpoint(ledgerId,[prior,failed],grant);
  assert.deepEqual(JSON.parse(await readFile(file,'utf8')),before);
  assert.throws(()=>checkpoint(ledgerId,[prior,failed,second],grant),/RETRY_HISTORY/);
  assert.throws(()=>checkpoint(ledgerId,[prior,{...failed,tokens:0}],grant),/ROLLBACK/);
  assert.throws(()=>checkpoint(ledgerId,[prior,{...failed,reservation:150000}],grant),/ROLLBACK/);
  assert.throws(()=>checkpoint(ledgerId,[prior,failed],{...grant,retainedUnknown:[...grant.retainedUnknown,{id:failed.id,reservation:100000}]}),/RETRY/);
  assert.deepEqual(JSON.parse(await readFile(file,'utf8')),before);
});

test('retaining unknown usage does not expand the cumulative token ceiling', async () => {
  const directory = await mkdtemp(path.join(fileURLToPath(new URL('../../../release-artifacts/', import.meta.url)), 'billing-retry-limit-'));
  const checkpoint = createBillingGuard(path.join(directory, 'billing.json')), ledgerId = randomUUID();
  const prior = { id: 'd'.repeat(64) + ':unknown', tokens: null, running: false, reservation: 100000 };
  const settled = { id: 'e'.repeat(64) + ':settled', tokens: 9841508, running: false, reservation: 100000 };
  const grant = { planHash: 'f'.repeat(64), stepIds: ['retry'], retainedUnknown: [{ id: prior.id, reservation: 100000 }] };
  checkpoint(ledgerId, [prior, settled]);
  assert.throws(() => checkpoint(ledgerId, [prior, settled, { id: grant.planHash + ':retry', tokens: null, running: true, reservation: 100000 }], grant), /BUDGET/);
});

test('native billing survives restart and rejects profile reset, rollback, repeated settled charge and unknown-budget expansion', async () => {
  const artifacts = fileURLToPath(new URL('../../../release-artifacts/', import.meta.url));
  await mkdir(artifacts, { recursive: true }); const directory = await mkdtemp(path.join(artifacts, 'billing-test-'));
  const file = path.join(directory, 'billing.json'), ledgerId = randomUUID(), id = 'a'.repeat(64) + ':chat';
  let checkpoint = createBillingGuard(file); checkpoint(ledgerId, []);
  checkpoint(ledgerId, [{ id, tokens: null, running: true }]);
  checkpoint = createBillingGuard(file);
  assert.throws(() => checkpoint(randomUUID(), []), /PROFILE/);
  assert.throws(() => checkpoint(ledgerId, []), /ROLLBACK/);
  assert.throws(() => checkpoint(ledgerId, [{ id, tokens: null, running: true }, { id: 'a'.repeat(64) + ':next', tokens: null, running: true }]), /BUDGET/);
  checkpoint(ledgerId, [{ id, tokens: 20, running: false }]);
  assert.throws(() => checkpoint(ledgerId, [{ id, tokens: null, running: true }]), /ROLLBACK/);
  assert.throws(() => checkpoint(ledgerId, [{ id, tokens: 0, running: false }]), /ROLLBACK/);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).charges[0].tokens, 20);
});

test('native ten-million ceiling includes old usage and survives a guard restart', async () => {
  const artifacts = fileURLToPath(new URL('../../../release-artifacts/', import.meta.url));
  const directory = await mkdtemp(path.join(artifacts, 'billing-limit-test-'));
  const file = path.join(directory, 'billing.json'), ledgerId = randomUUID(), prefix = 'b'.repeat(64);
  const prior = { id: prefix + ':prior', tokens: 9841507, running: false };
  let checkpoint = createBillingGuard(file); checkpoint(ledgerId, [prior]);
  checkpoint = createBillingGuard(file);
  const next = { id: prefix + ':next', tokens: null, running: true };
  checkpoint(ledgerId, [prior, next]);
  checkpoint(ledgerId, [prior, { ...next, tokens: 15, running: false }]);
  checkpoint = createBillingGuard(file);
  assert.throws(() => checkpoint(ledgerId, [prior, { ...next, tokens: 15, running: false },
    { id: prefix + ':over', tokens: null, running: true }]), /BUDGET/);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(stored.tokenLimit, 10000000); assert.equal(stored.legacyTokens, 58493);
  assert.equal(stored.charges[0].tokens, 9841507);
});

test('larger per-call reservations cannot be lowered and older fixed reservations migrate without changing costs', async () => {
  const artifacts = fileURLToPath(new URL('../../../release-artifacts/', import.meta.url));
  const directory = await mkdtemp(path.join(artifacts, 'billing-reservation-test-'));
  const file = path.join(directory, 'billing.json'), ledgerId = randomUUID(), prefix = 'd'.repeat(64);
  const prior = { id: prefix + ':prior', tokens: 1000, running: false };
  let checkpoint = createBillingGuard(file); checkpoint(ledgerId, [prior]);
  const migrated = { ...prior, reservation: 100000 };
  checkpoint(ledgerId, [migrated]);
  const next = { id: prefix + ':long', tokens: null, running: true, reservation: 150000 };
  checkpoint(ledgerId, [migrated, next]); checkpoint = createBillingGuard(file);
  assert.throws(() => checkpoint(ledgerId, [migrated, { ...next, reservation: 100000 }]), /ROLLBACK/);
  assert.throws(() => checkpoint(ledgerId, [migrated, { ...next, reservation: 99999 }]), /INVALID/);
  assert.throws(() => checkpoint(ledgerId, [migrated, { ...next, reservation: 200001 }]), /INVALID/);
  checkpoint(ledgerId, [migrated, { ...next, tokens: 25000, running: false }]);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).charges[0].tokens, 1000);
});
