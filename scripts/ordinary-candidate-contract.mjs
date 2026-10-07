import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const DEVELOPER_MARKERS = /PROBE_HISTORY_TAIL|PROBE_FAVORITE_FOLDER_GAP|bili-bill-prompt-evaluation-v1|developerAcceptanceV1|__ACCEPTANCE_BUILD__|诊断历史尾页|收藏夹缺口诊断|导出诊断摘要|同步诊断/;

export function assertOrdinaryContent(files) {
  for (const file of files) {
    assert.equal(typeof file.content, 'string', `Missing content for ordinary scan: ${file.path}`);
    const decoded = file.content.replace(/\\u([0-9a-f]{4})/gi, (_match, hex) => String.fromCharCode(parseInt(hex, 16)));
    assert.doesNotMatch(decoded, DEVELOPER_MARKERS, `Developer interface in ordinary content: ${file.path}`);
  }
}

export async function assertOrdinaryDistribution(directory, expectedManifest) {
  const files = [], contents = [];
  async function visit(folder, prefix = '') {
    assert.equal((await lstat(folder)).isSymbolicLink(), false, 'Ordinary distribution cannot contain links.');
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const name = prefix + entry.name, fullPath = path.join(folder, entry.name);
      assert.equal((await lstat(fullPath)).isSymbolicLink(), false, `Linked distribution file: ${name}`);
      if (entry.isDirectory()) await visit(fullPath, name + '/');
      else {
        assert.ok(entry.isFile(), `Unsupported distribution entry: ${name}`);
        files.push({ path: name });
        if (/\.(?:m?js|html|json|css)$/i.test(name)) contents.push({ path: name, content: await readFile(fullPath, 'utf8') });
      }
    }
  }
  await visit(directory);
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  assertOrdinaryCandidate(manifest, expectedManifest, files);
  assertOrdinaryContent(contents);
  return { files: files.length, scannedContents: contents.length };
}

export function assertOrdinaryCandidate(manifest, expectedManifest, files) {
  assert.deepEqual(manifest, expectedManifest, 'Ordinary candidate changed its manifest contract.');
  assert.ok(!manifest.permissions?.some(permission => ['nativeMessaging', 'cookies', 'debugger'].includes(permission)), 'Developer or private permission in ordinary candidate.');
  assert.ok(!manifest.externally_connectable, 'Developer control connection in ordinary candidate.');
  for (const file of files) {
    assert.ok(!/(^|\/)(dev|tests?|fixtures?|prompt-eval|prompt-evaluation|acceptance|acceptance-bridge|native-host)(\/|[.-]|$)/i.test(file.path.replaceAll('\\', '/')), `Developer entry in ordinary candidate: ${file.path}`);
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
