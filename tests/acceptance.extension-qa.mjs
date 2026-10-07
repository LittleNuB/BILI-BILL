import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = await realpath(process.cwd()), extension = await realpath(process.argv[2]);
assert.ok(extension.startsWith(root + path.sep));
const out = path.join(root, 'release-artifacts', `acceptance-offline-${Date.now()}`); await mkdir(out);
const { chromium } = await import(pathToFileURL(process.env.UX014_PLAYWRIGHT_MODULE).href);
const report = { kind: 'installed_extension_offline', nativeHostInstalled: false, networkBlocked: true,
  personalBrowserStateRead: false, realModel: false, realSiteUi: false, browsers: [] };
try {
  for (const [name, executablePath] of [['Chrome', process.env.UX014_CHROME_EXECUTABLE], ['Edge', process.env.UX014_EDGE_EXECUTABLE]]) {
    const profile = await mkdtemp(path.join(out, `${name}-isolated-`)), errors = [];
    const context = await chromium.launchPersistentContext(profile, { executablePath, headless: true, viewport: { width: 1280, height: 900 },
      ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging', '--proxy-server=http://127.0.0.1:9'] });
    try {
      await context.route(/^https?:\/\//, route => route.abort()); context.setDefaultTimeout(10000);
      const cdp = await context.browser().newBrowserCDPSession(); const { id } = await cdp.send('Extensions.loadUnpacked', { path: extension });
      const version = (await cdp.send('Browser.getVersion')).product; await cdp.detach();
      const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
      await page.goto(`chrome-extension://${id}/acceptance/index.html`);
      await page.getByText('已读取记录。尚未授权本次会话。', { exact: true }).waitFor();
      assert.match(await page.locator('#budget').innerText(), /58,493/);
      assert.equal(await page.getByRole('button', { name: '批准本计划并连接（30分钟）' }).isDisabled(), true);
      const second = await context.newPage(); await second.goto(page.url());
      await second.getByText('已读取记录。尚未授权本次会话。', { exact: true }).waitFor(); await second.close();
      await page.locator('#consent').check(); await page.locator('#legacy').check();
      await page.evaluate(() => document.getElementById('approve').click());
      assert.match(await page.locator('#notice').innerText(), /尚未授权/);
      await page.getByRole('button', { name: '批准本计划并连接（30分钟）' }).click();
      await page.locator('#notice').filter({ hasText: '请先在本扩展设置中配置文字模型。密钥仅留在扩展后台。' }).waitFor();
      await page.reload(); await page.getByText('已读取记录。尚未授权本次会话。', { exact: true }).waitFor();
      const worker = context.serviceWorkers().find(w => w.url().includes(id));
      const stored = await worker.evaluate(async () => (await chrome.storage.local.get('developerAcceptanceV1')).developerAcceptanceV1);
      assert.equal(stored.reports[0].rows.length, 0); assert.deepEqual(stored.reports[0].materials, {});
      assert.match(stored.ledgerId, /^[a-f0-9-]{36}$/);
      // A hash-suffixed page is not the exact trusted approval page and must not get the ledger.
      const rejected = await context.newPage(); await rejected.goto(`chrome-extension://${id}/acceptance/index.html#untrusted`);
      await rejected.waitForTimeout(500); assert.match(await rejected.locator('#budget').innerText(), /尚未读取/); await rejected.close();
      await page.screenshot({ path: path.join(out, `${name}-wide.png`), fullPage: true });
      await page.setViewportSize({ width: 420, height: 860 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.screenshot({ path: path.join(out, `${name}-narrow.png`), fullPage: true });
      assert.deepEqual(errors, []); report.browsers.push({ name, version, status: 'pass', extensionId: id, attempts: 0 });
    } finally { await context.close(); }
  }
} finally { await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); }
console.log(JSON.stringify({ output: out, ...report }));
