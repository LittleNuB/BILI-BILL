import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const { chromium } = await import(pathToFileURL(process.env.UX014_PLAYWRIGHT_MODULE).href);
const out = path.join(root, process.env.POPUP_QA_OUTPUT || 'release-artifacts/popup-282');
await mkdir(out, { recursive: true });
const html = await readFile(path.join(root, 'dist/popup/index.html'), 'utf8');
const mock = await readFile(path.join(root, 'tests/current-video-popup.mock.js'), 'utf8');
const browser = await chromium.launch({ executablePath: process.env.UX014_CHROME_EXECUTABLE, headless: true });
const results = [];
try {
  for (const [name, width, mode] of [['compact',380,'video'], ['narrow',320,'video'], ['window',800,'none'], ['error',380,'error'], ['empty',380,'empty'], ['sync-prepare',320,'sync-prepare'], ['sync-incremental',380,'sync-incremental'], ['sync-unknown',320,'sync-unknown'], ['sync-result',380,'sync-result']]) {
    const page = await browser.newPage({ viewport: { width, height: 720 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'popup.mock') return route.abort();
      if (url.pathname === '/popup') {
        const override = `window.__opened = []; chrome.runtime.getURL = p => 'chrome-extension://mock/' + p; chrome.tabs.create = o => { window.__opened.push(o.url); return Promise.resolve(); }; const send = chrome.runtime.sendMessage; chrome.runtime.sendMessage = m => { if (m.action === 'GET_CURRENT_VIDEO_CONTEXT' && '${mode}' === 'none') return Promise.resolve({success:true,data:{status:'no_context'}}); if (m.action === 'GET_QUICK_STATS' && '${mode}' === 'error') return Promise.resolve({success:false,error:'请稍后重试'}); if (m.action === 'GET_QUICK_STATS' && '${mode}' === 'empty') return Promise.resolve({success:true,data:null}); return send(m); };`;
        const syncOverride = !mode.startsWith('sync-') ? '' : `
          const syncFixture = { syncing: ${mode !== 'sync-result'}, mode: '${mode === 'sync-incremental' ? 'incremental' : 'full'}',
            requestedPageLimit: 50, pageLimit: 50, currentTask: '${mode === 'sync-unknown' ? 'unknown_internal_status' : 'page_limit'}',
            startedAt: Date.now(), updatedAt: Date.now(), fetchedPages: ${mode === 'sync-prepare' ? 0 : 2},
            fetchedCount: ${mode === 'sync-prepare' ? 0 : 60}, insertedCount: 0, updatedCount: 0, skippedCount: 0, duplicateCount: 0,
            unsupportedBusinessCount: 0, liveExcludedCount: 0, missingIdCount: 0, stoppedReason: 'page_limit',
            reachedEnd: false, oldestFetchedAt: null, newestFetchedAt: null, finalCursor: null };
          const syncSend = chrome.runtime.sendMessage;
          chrome.runtime.sendMessage = m => {
            if (m.action === 'GET_SYNC_STATUS') return Promise.resolve({success:true,data:{lastSyncTime:0,totalRecords:60,backfillComplete:false,syncProgress:syncFixture}});
            if (m.action === 'SYNC_NOW') return Promise.resolve({success:true,data:syncFixture});
            return syncSend(m);
          };`;
        return route.fulfill({ contentType: 'text/html', body: html.replace('</head>', `<script>${mock}\n${override}\n${syncOverride}</script></head>`) });
      }
      const local = path.resolve(root, 'dist', '.' + url.pathname);
      if (!local.startsWith(path.resolve(root, 'dist') + path.sep)) return route.abort();
      const contentType = local.endsWith('.css') ? 'text/css' : 'text/javascript';
      try { await route.fulfill({ contentType, body: await readFile(local) }); } catch { await route.abort(); }
    });
    await page.goto('http://popup.mock/popup');
    await page.getByText('打开总览', { exact: true }).waitFor();
    if (mode === 'video') await page.getByText('Popup 授权 Mock 视频', { exact: true }).waitFor();
    if (mode === 'none') await page.getByText('当前未打开视频', { exact: true }).waitFor();
    if (mode.startsWith('sync-')) {
      if (mode === 'sync-result') await page.getByTitle('全量同步并刷新数据').click();
      else await page.getByRole('button', { name: '停止本次同步', exact: true }).waitFor();
      const expected = {
        'sync-prepare': '正在准备同步',
        'sync-incremental': '历史增量同步进行中',
        'sync-unknown': '正在同步历史记录',
        'sync-result': '已到本次扫描上限，较早记录可能尚未同步',
      }[mode];
      const body = await page.locator('body').innerText();
      assert.doesNotMatch(body, /page_limit|unknown_internal_status/);
      assert.ok(body.includes(expected), `${mode}: missing ${expected}`);
    }
    assert.equal(await page.locator('.popup-diagnostics').getAttribute('open'), null);
    assert.equal(await page.getByRole('button', { name: '诊断历史尾页' }).isVisible(), false);
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(255, 255, 255)');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const actions = await page.evaluate(() => window.__popupMockMessages.map(m => m.action));
    assert.equal(actions.some(a => /^(GENERATE_|ASK_|PROBE_|REQUEST_)/.test(a)), false);
    await page.getByRole('button', { name: '打开总览', exact: true }).click();
    await page.getByRole('button', { name: '动态账单', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.__opened), ['chrome-extension://mock/dashboard/index.html', 'chrome-extension://mock/dashboard/index.html#dynamic-bill']);
    await page.screenshot({ path: path.join(out, name + '.png'), fullPage: true });
    if (mode === 'video') {
      assert.equal(await page.locator('.popup-assistant-details').getAttribute('open'), null);
      await page.locator('.popup-assistant-details > summary').click();
      await page.getByRole('button', { name: '重新检测字幕', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: path.join(out, name + '-expanded.png'), fullPage: true });
      await page.locator('.popup-assistant-details > summary').click();
    }
    await page.locator('.popup-diagnostics > summary').click();
    assert.equal(await page.getByRole('button', { name: '诊断历史尾页' }).isVisible(), true);
    assert.deepEqual(errors, []);
    results.push({ name, width, mode, pass: true });
    await page.close();
  }
} finally { await browser.close(); }
await writeFile(path.join(out, 'report.json'), JSON.stringify({ syntheticOnly:true, popupSha256:createHash('sha256').update(await readFile(path.join(root,'dist/popup.js'))).digest('hex'), results }, null, 2));
console.log(JSON.stringify({ out, results }));
