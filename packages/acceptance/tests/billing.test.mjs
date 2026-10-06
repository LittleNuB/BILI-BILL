import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBillingGuard } from '../billing.mjs';

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
