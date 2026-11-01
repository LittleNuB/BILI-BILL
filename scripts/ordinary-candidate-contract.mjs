import assert from 'node:assert/strict';

export function assertOrdinaryCandidate(manifest, expectedManifest, files) {
  assert.deepEqual(manifest, expectedManifest, 'Ordinary candidate changed its manifest contract.');
  assert.ok(!manifest.permissions?.some(permission => ['nativeMessaging', 'cookies', 'debugger'].includes(permission)), 'Developer or private permission in ordinary candidate.');
  assert.ok(!manifest.externally_connectable, 'Developer control connection in ordinary candidate.');
  for (const file of files) {
    assert.ok(!/(^|\/)(dev|prompt-eval|prompt-evaluation|acceptance-bridge|native-host)(\/|[.-]|$)/i.test(file.path), `Developer entry in ordinary candidate: ${file.path}`);
  }
}

export function assertOfflineAcceptance(report, binding) {
  assert.equal(report.kind, 'offline_page_regression');
  assert.equal(report.status, 'pass');
  assert.equal(report.sourceDirty, false, 'Offline evidence came from a dirty source tree.');
  for (const field of ['sourceCommit', 'sourceTree', 'productionContentSha256']) {
    assert.equal(report[field], binding[field], `Offline evidence binding mismatch: ${field}`);
  }
  assert.equal(report.realModelCalls, 0);
  assert.equal(report.personalBrowserStateRead, false);
  assert.equal(report.realSiteUi, 'not_run');
  assert.equal(report.modelQuality, 'not_evaluated');
  const expected = ['session', 'subtitles-and-parts', 'notes-images-and-conversations', 'extension-context-invalidation'].sort();
  assert.deepEqual(report.suites.map(suite => suite.name).sort(), expected);
  assert.ok(report.suites.every(suite => suite.status === 'pass'), 'Offline page flow failed.');
}
