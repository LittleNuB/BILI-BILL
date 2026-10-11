import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd(), out = path.join(root, 'release-artifacts', `ordinary-extension-${Date.now()}`);
await mkdir(out, { recursive: true });
const { chromium } = await import(pathToFileURL(process.env.UX014_PLAYWRIGHT_MODULE).href);
const report = { status: 'running', kind: 'ordinary_installed_extension_offline', networkBlocked: true,
  realModelCalls: 0, personalBrowserStateRead: false, realSiteAcceptance: 'not_completed', browsers: [] };
const forbidden = /诊断历史尾页|同步诊断|收藏夹缺口诊断|导出诊断摘要|提示词评测|开发验收/;
try {
  for (const [name, executablePath] of [['Chrome', process.env.UX014_CHROME_EXECUTABLE], ['Edge', process.env.UX014_EDGE_EXECUTABLE]]) {
    const profile = await mkdtemp(path.join(tmpdir(), `bb-ordinary-${name}-`));
    const context = await chromium.launchPersistentContext(profile, { executablePath, headless: true,
      viewport: { width: 1280, height: 900 }, ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging', '--proxy-server=http://127.0.0.1:9'] });
    const checks = [], errors = [];
    try {
      await context.route(/^https?:\/\//, route => route.abort());
      context.setDefaultTimeout(10000);
      const cdp = await context.browser().newBrowserCDPSession();
      const { id } = await cdp.send('Extensions.loadUnpacked', { path: path.join(root, 'dist') });
      await cdp.detach();
      const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
      await page.setViewportSize({ width: 390, height: 900 });
      await page.goto(`chrome-extension://${id}/popup/index.html`);
      await page.locator('.popup-shell').waitFor();
      assert.doesNotMatch(await page.locator('body').innerText(), forbidden);
      for (const action of ['PROBE_HISTORY_TAIL', 'PROBE_FAVORITE_FOLDER_GAP']) {
        const response = await page.evaluate(action => chrome.runtime.sendMessage({ action }), action);
        assert.deepEqual(response, { success: false, error: `Unknown action: ${action}` });
      }
      await page.screenshot({ path: path.join(out, `${name}-popup.png`), fullPage: true });
      checks.push('ordinary popup has no diagnostics; removed runtime actions are rejected');
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`chrome-extension://${id}/dashboard/index.html#video-wiki`);
      await page.getByRole('heading', { name: '从一条笔记开始' }).waitFor();
      await page.getByRole('button', { name: '新建页面', exact: true }).click();
      await page.getByLabel('页面标题', { exact: true }).fill('普通体验包的第一条笔记');
      await page.getByLabel('页面正文', { exact: true }).fill('不配置 AI、目录或 Agent，也可以记录与找回。');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.getByText('已保存到此浏览器。', { exact: true }).waitFor();
      await page.reload();
      await page.locator('.knowledge-card').filter({ hasText: '普通体验包的第一条笔记' }).click();
      await page.getByText('不配置 AI、目录或 Agent，也可以记录与找回。', { exact: true }).last().waitFor();
      assert.doesNotMatch(await page.locator('body').innerText(), forbidden);
      await page.screenshot({ path: path.join(out, `${name}-knowledge.png`), fullPage: true });
      checks.push('packaged knowledge UI saves and reloads a personal page without optional setup');
      await page.goto(`chrome-extension://${id}/dashboard/index.html#legacy-favorites`);
      await page.getByRole('button', { name: '同步收藏夹', exact: true }).waitFor();
      assert.doesNotMatch(await page.locator('body').innerText(), forbidden);
      await page.screenshot({ path: path.join(out, `${name}-favorites.png`), fullPage: true });
      checks.push('legacy favorites retains normal controls without probe or audit table');
      await page.goto(`chrome-extension://${id}/dashboard/index.html#settings`);
      await page.getByRole('button', { name: '测试连接', exact: true }).waitFor();
      await page.getByText('本地数据与隐私管理', { exact: true }).click();
      await page.getByRole('button', { name: '刷新状态', exact: true }).waitFor();
      assert.doesNotMatch(await page.locator('body').innerText(), forbidden);
      await page.screenshot({ path: path.join(out, `${name}-settings.png`), fullPage: true });
      checks.push('settings retains connection and privacy controls without diagnostic export');
      assert.deepEqual(errors, []);
      report.browsers.push({ name, checks, errors });
    } finally { await context.close(); }
  }
  report.status = 'pass';
} catch (error) { report.status = 'fail'; report.error = String(error); throw error; }
finally { await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ output: out, status: report.status })); }
