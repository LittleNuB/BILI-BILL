import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm, realpath, cp } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = await realpath(process.cwd());
let extension = await realpath(process.argv[2]);
assert.ok(extension.startsWith(root + path.sep), 'Only a workspace-owned test package may be loaded.');
const out = path.join(root, 'release-artifacts', `prompt-evaluation-extension-${Date.now()}`);
await mkdir(out);
if (process.argv.includes('--source')) {
  const source = extension;
  extension = path.join(out, 'extension');
  await cp(source, extension, { recursive: true });
  const receipt = JSON.parse(await readFile(path.join(source, '../verification.json'), 'utf8'));
  const binding = Object.fromEntries(['sourceCommit', 'buildHash', 'datasetHash', 'baselineCommit'].map(key => [key, receipt[key]]));
  await build({ entryPoints: ['src/dev/prompt-eval/worker.ts'], outfile: path.join(extension, 'prompt-eval-worker.js'),
    bundle: true, minify: true, platform: 'browser', format: 'esm', target: 'es2022',
    define: { __EVAL_BUILD__: JSON.stringify(binding), __EVAL_HAS_SEED__: 'true' } });
  await build({ entryPoints: ['src/dev/prompt-eval/page.tsx'], outfile: path.join(extension, 'prompt-eval/page.js'),
    bundle: true, minify: true, platform: 'browser', format: 'esm', target: 'es2022', jsx: 'automatic', jsxImportSource: 'preact' });
}
const { chromium } = await import(pathToFileURL(process.env.UX014_PLAYWRIGHT_MODULE).href);
const seed = JSON.parse(await readFile(path.join(extension, 'prompt-eval/prior-report.json'), 'utf8'));
const report = { status: 'running', installedExtension: true, readsPersonalBrowserState: false,
  realModelAcceptance: 'not_completed', networkBlocked: true, package: extension, browsers: [] };
try {
  for (const [name, executablePath] of [['Chrome', process.env.UX014_CHROME_EXECUTABLE], ['Edge', process.env.UX014_EDGE_EXECUTABLE]]) {
    const profile = await mkdtemp(path.join(root, 'release-artifacts/qa-'));
    let context;
    const result = { name, status: 'running', pageErrors: [], senders: [] };
    report.browsers.push(result);
    try {
      context = await chromium.launchPersistentContext(profile, { executablePath, headless: true,
        viewport: { width: 1280, height: 900 }, ignoreDefaultArgs: ['--disable-extensions'],
        args: ['--enable-unsafe-extension-debugging', '--proxy-server=http://127.0.0.1:9'] });
      await context.route(/^https?:\/\//, route => route.abort());
      context.setDefaultTimeout(10000);
      const cdp = await context.browser().newBrowserCDPSession();
      const { id } = await cdp.send('Extensions.loadUnpacked', { path: extension });
      result.version = (await cdp.send('Browser.getVersion')).product;
      await cdp.detach();
      const worker = context.serviceWorkers().find(w => w.url().includes(id))
        ?? await context.waitForEvent('serviceworker', { timeout: 10000 });
      await worker.evaluate(() => {
        globalThis.qaSenders = [];
        chrome.runtime.onConnect.addListener(port => qaSenders.push({ name: port.name, sender: port.sender }));
      });
      const page = await context.newPage();
      page.on('pageerror', error => result.pageErrors.push(error.message));
      page.setDefaultTimeout(10000);
      await page.goto(`chrome-extension://${id}/prompt-eval/index.html`);
      try {
        await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.includes('导出结果') && !b.disabled));
      } finally {
        result.pageText = await page.locator('body').innerText();
        result.senders = await worker.evaluate(() => qaSenders).catch(error => [{ error: error.message }]);
        await page.screenshot({ path: path.join(out, `${name}-startup.png`) });
      }
      const stored = await worker.evaluate(async () => (await chrome.storage.local.get('developerPromptEvaluationV1')).developerPromptEvaluationV1);
      assert.equal(stored.rows.filter(row => row.attempted).length, 32);
      assert.deepEqual(stored.rows.map(row => [row.text, row.observation]), seed.rows.map(row => [row.text, row.observation]));
      assert.match(result.pageText, /58,493/);
      assert.match(result.pageText, /请先在扩展设置中连接文字模型/);
      assert.doesNotMatch(result.pageText, /正在读取评测记录|评测页已断开/);
      assert.deepEqual(result.pageErrors, []);
      const second = await context.newPage();
      await second.goto(`chrome-extension://${id}/prompt-eval/index.html`);
      try {
        await second.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.includes('导出结果') && !b.disabled));
      } finally {
        result.secondPageText = await second.locator('body').innerText();
        await second.screenshot({ path: path.join(out, `${name}-second-page.png`) });
      }
      assert.match(result.secondPageText, /58,493/);
      await second.close();
      const downloadEvent = page.waitForEvent('download');
      await page.getByRole('button', { name: '导出结果' }).click();
      const download = await downloadEvent;
      await download.saveAs(path.join(out, `${name}-saved-export.json`));
      await page.reload();
      try {
        await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.includes('导出结果') && !b.disabled));
      } finally { result.reloadText = await page.locator('body').innerText(); }
      assert.match(await page.locator('body').innerText(), /58,493/);
      const lifecycle = await context.newCDPSession(page), versions = new Map();
      lifecycle.on('ServiceWorker.workerVersionUpdated', event => { for (const version of event.versions) versions.set(version.versionId, version); });
      await lifecycle.send('ServiceWorker.enable');
      const deadline = Date.now() + 10000;
      while (![...versions.values()].some(v => v.scriptURL === worker.url() && v.runningStatus === 'running')) {
        assert.ok(Date.now() < deadline, 'Extension worker version was not observed');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const version = [...versions.values()].find(v => v.scriptURL === worker.url() && v.runningStatus === 'running');
      await lifecycle.send('ServiceWorker.stopWorker', { versionId: version.versionId });
      const stoppedDeadline = Date.now() + 10000;
      while (versions.get(version.versionId)?.runningStatus !== 'stopped') {
        assert.ok(Date.now() < stoppedDeadline, 'Extension worker did not stop');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      await page.getByRole('button', { name: '重新连接', exact: true }).waitFor();
      await page.getByRole('button', { name: '重新连接', exact: true }).click();
      try {
        await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.includes('导出结果') && !b.disabled)
          && document.body.textContent.includes('请先在扩展设置中连接文字模型')
          && !document.body.textContent.includes('评测页已断开') && !document.body.textContent.includes('历史记录不匹配'));
      } finally { result.workerRestartText = await page.locator('body').innerText(); }
      assert.match(result.workerRestartText, /58,493/);
      assert.doesNotMatch(result.workerRestartText, /正在读取评测记录|历史记录不匹配/);
      const restored = await page.evaluate(async () => (await chrome.storage.local.get('developerPromptEvaluationV1')).developerPromptEvaluationV1);
      assert.equal(restored.rows.filter(row => row.attempted).length, 32);
      assert.deepEqual(restored.rows.map(row => [row.text, row.observation]), seed.rows.map(row => [row.text, row.observation]));
      await lifecycle.detach();
      result.status = 'pass';
    } catch (error) {
      result.status = 'fail'; result.error = error.message; throw error;
    } finally {
      await context?.close();
      const resolved = await realpath(profile);
      assert.equal(path.dirname(resolved), path.join(root, 'release-artifacts'));
      assert.ok(path.basename(resolved).startsWith('qa-'));
      await rm(resolved, { recursive: true });
    }
  }
  report.status = 'pass';
} catch (error) { report.status = 'fail'; throw error; }
finally { await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ output: out, status: report.status })); }
