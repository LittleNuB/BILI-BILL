import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { assertOfflineAcceptance, assertOrdinaryCandidate, assertOrdinaryContent } from '../scripts/ordinary-candidate-contract.mjs';

const manifest = JSON.parse(readFileSync(new URL('../public/manifest.json', import.meta.url), 'utf8'));

test('ordinary candidate preserves version, permissions and manifest', () => {
  assertOrdinaryCandidate(structuredClone(manifest), manifest, [{ path: 'background.js' }, { path: 'dashboard/index.html' }]);
  for (const change of [{ version: '0.14.0' }, { permissions: [...manifest.permissions, 'nativeMessaging'] }, { externally_connectable: { matches: ['http://localhost/*'] } }]) {
    assert.throws(() => assertOrdinaryCandidate({ ...manifest, ...change }, manifest, []));
  }
});

test('ordinary candidate excludes developer control and evaluation entries', () => {
  for (const path of ['dev/index.html', 'prompt-eval.js', 'assets/prompt-evaluation-worker.js', 'acceptance-bridge/index.html', 'native-host/host.js', 'acceptance/page.js', 'fixtures/chart.png', 'tests/index.html']) {
    assert.throws(() => assertOrdinaryCandidate(manifest, manifest, [{ path }]));
  }
});

test('ordinary content rejects test interfaces even inside normal hashed chunks', () => {
  for (const marker of ['PROBE_HISTORY_TAIL', 'PROBE_FAVORITE_FOLDER_GAP', 'bili-bill-prompt-evaluation-v1', 'developerAcceptanceV1', '诊断历史尾页', '收藏夹缺口诊断', '导出诊断摘要']) {
    for (const content of [JSON.stringify(marker), JSON.stringify(marker).replace(/[\u0080-\uffff]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'))]) {
      assert.throws(() => assertOrdinaryContent([{ path: 'chunks/dashboard-hash.js', content }]));
    }
  }
});

test('ordinary content retains product connection, backup and subtitle controls', () => {
  assertOrdinaryContent([{ path: 'background.js', content: 'TEST_AI_CONNECTION EXPORT_DATA PROBE_CURRENT_VIDEO_SUBTITLE_SOURCE GET_SYNC_STATUS' }]);
});

test('production entry points no longer import or expose old diagnostic probes', () => {
  for (const file of ['popup/App.tsx', 'dashboard/modules/favorites/SmartFavoritesPage.tsx', 'dashboard/modules/settings/SettingsPage.tsx', 'src/background/messages/handlers.ts', 'src/shared/types/messages.ts']) {
    const content = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    assertOrdinaryContent([{ path: file, content }]);
    assert.doesNotMatch(content, /history-tail-probe|folder-gap-probe|settings-diagnostic-download|buildLocalDataDiagnosticExport/);
  }
});

const binding = { sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), productionContentSha256: 'c'.repeat(64) };
const offline = { ...binding, sourceDirty: false, status: 'pass', kind: 'offline_page_regression',
  realModelCalls: 0, personalBrowserStateRead: false, realSiteUi: 'not_run', modelQuality: 'not_evaluated',
  suites: ['session', 'subtitles-and-parts', 'notes-images-and-conversations', 'extension-context-invalidation']
    .map(name => ({ name, status: 'pass' })) };

test('offline acceptance belongs to the current clean source and production bundle', () => {
  assertOfflineAcceptance(offline, binding);
  for (const change of [{ sourceCommit: 'd'.repeat(40) }, { sourceTree: 'd'.repeat(40) },
    { productionContentSha256: 'd'.repeat(64) }, { sourceDirty: true }]) {
    assert.throws(() => assertOfflineAcceptance({ ...offline, ...change }, binding));
  }
});

test('offline acceptance cannot imply real acceptance or omit failed browser flows', () => {
  for (const change of [{ realModelCalls: 1 }, { personalBrowserStateRead: true }, { realSiteUi: 'pass' },
    { modelQuality: 'pass' }, { status: 'fail' }, { suites: offline.suites.slice(1) },
    { suites: offline.suites.map(suite => ({ ...suite, status: 'fail' })) },
    { suites: [...offline.suites.slice(1), offline.suites[1]] }]) {
    assert.throws(() => assertOfflineAcceptance({ ...offline, ...change }, binding));
  }
});
