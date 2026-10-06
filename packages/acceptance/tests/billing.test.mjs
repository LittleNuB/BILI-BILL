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
