import assert from 'node:assert/strict';

export function assertOrdinaryCandidate(manifest, expectedManifest, files) {
  assert.deepEqual(manifest, expectedManifest, 'Ordinary candidate changed its manifest contract.');
  assert.ok(!manifest.permissions?.some(permission => ['nativeMessaging', 'cookies', 'debugger'].includes(permission)), 'Developer or private permission in ordinary candidate.');
  assert.ok(!manifest.externally_connectable, 'Developer control connection in ordinary candidate.');
  for (const file of files) {
    assert.ok(!/(^|\/)(dev|prompt-eval|prompt-evaluation|acceptance-bridge|native-host)(\/|[.-]|$)/i.test(file.path), `Developer entry in ordinary candidate: ${file.path}`);
  }
}
