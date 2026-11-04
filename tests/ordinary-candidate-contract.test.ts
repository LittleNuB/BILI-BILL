import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { assertOrdinaryCandidate } from '../scripts/ordinary-candidate-contract.mjs';

const manifest = JSON.parse(readFileSync(new URL('../public/manifest.json', import.meta.url), 'utf8'));

test('ordinary candidate preserves version, permissions and manifest', () => {
  assertOrdinaryCandidate(structuredClone(manifest), manifest, [{ path: 'background.js' }, { path: 'dashboard/index.html' }]);
  for (const change of [{ version: '0.14.0' }, { permissions: [...manifest.permissions, 'nativeMessaging'] }, { externally_connectable: { matches: ['http://localhost/*'] } }]) {
    assert.throws(() => assertOrdinaryCandidate({ ...manifest, ...change }, manifest, []));
  }
});

test('ordinary candidate excludes developer control and evaluation entries', () => {
  for (const path of ['dev/index.html', 'prompt-eval.js', 'assets/prompt-evaluation-worker.js', 'acceptance-bridge/index.html', 'native-host/host.js']) {
    assert.throws(() => assertOrdinaryCandidate(manifest, manifest, [{ path }]));
  }
});
