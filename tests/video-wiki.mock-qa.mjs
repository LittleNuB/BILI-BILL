import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd(), out = path.join(root, 'release-artifacts/wiki-292');
await mkdir(out, { recursive: true });
const { chromium } = await import(pathToFileURL(process.env.UX014_PLAYWRIGHT_MODULE).href);
const server = createServer(async (request, response) => {
  const file = path.resolve(root, 'dist', '.' + new URL(request.url, 'http://localhost').pathname);
  if (!file.startsWith(path.join(root, 'dist') + path.sep)) { response.writeHead(403).end(); return; }
  try { const body = await readFile(file); response.writeHead(200, { 'content-type': file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }); response.end(body); }
  catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.UX014_CHROME_EXECUTABLE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(8000);
const errors = []; page.on('pageerror', error => errors.push(error.message));
const report = { syntheticOnly: true, productionWorkers: true, checks: [], status: 'running' };
const row = (id, bvid, title, part = 1) => ({ id: id.repeat(64), kind: 'note', video: { bvid, title }, part: { cid: String(part), page: part },
  personal: { title: '交付检查笔记', note: '稳定交付需要先明确需求，再测试验证。', tags: [] }, snapshot: null, bookmarkMs: null, importedFrom: null, createdAt: 1, updatedAt: 1 });
const assets = [row('a', 'BV1234567890', '从需求到交付：我的工程实践'), row('b', 'BV1234567890', '从需求到交付：我的工程实践', 2), row('c', 'BV0987654321', '测试与验收的成本')];
assets[1].personal = { title: 'P2 关键原句', note: '', tags: [] }; assets[1].kind = 'excerpt';
assets[1].snapshot = { origin: 'subtitle', body: '验收应该覆盖关键流程。', source: { kind: 'bilibili', hash: 'e'.repeat(64) }, citations: [{ fromMs: 1000, toMs: 2000, text: '验收应该覆盖关键流程。' }] };
const wiki = { key: 'state', revision: 1, pages: ['BV1234567890', 'BV0987654321'].map(bvid => ({ bvid, createdAt: 1, deleted: false })), topics: [], relations: [] };
try {
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.addInitScript(() => {
    window.__calls = [];
    window.__db = () => new Promise((resolve, reject) => { const request = indexedDB.open('BiliAnalyticsDB'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    window.__read = async () => {
      const db = await window.__db();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(['lgAssets', 'lgMeta', 'lgWiki'], 'readonly');
        const a = tx.objectStore('lgAssets').getAll(), m = tx.objectStore('lgMeta').get('state'), w = tx.objectStore('lgWiki').get('state');
        tx.oncomplete = () => { db.close(); resolve({ assets: a.result, meta: m.result, wiki: w.result }); }; tx.onerror = () => { db.close(); reject(tx.error); };
      });
    };
    window.chrome = { runtime: { getURL: file => location.origin + '/' + file, sendMessage: async message => {
      window.__calls.push(message);
      if (message.action === 'LEARNING_LIST') {
        const state = await window.__read();
        return { success: true, data: { epoch: state.meta.epoch, total: state.assets.length, allTotal: state.assets.length, bytes: 1000, videos: state.assets.map(a => a.video), offset: 0, items: [] } };
      }
      if (message.action === 'LEARNING_EDIT') {
        const db = await window.__db(), p = message.params;
        return new Promise(resolve => {
          const tx = db.transaction(['lgAssets', 'lgMeta'], 'readwrite'); let result;
          const request = tx.objectStore('lgAssets').get(p.id);
          request.onsuccess = () => {
            const meta = tx.objectStore('lgMeta').get('state');
            meta.onsuccess = () => {
              if (meta.result.epoch !== p.epoch || JSON.stringify(request.result) !== JSON.stringify(p.expected)) { tx.abort(); return; }
              result = { ...request.result, personal: p.personal, updatedAt: 2 }; tx.objectStore('lgAssets').put(result);
              tx.objectStore('lgMeta').put({ ...meta.result, revision: meta.result.revision + 1 });
            };
          };
          tx.oncomplete = () => { db.close(); resolve({ success: true, data: result }); };
          tx.onabort = () => { db.close(); resolve({ success: false, error: '记录已变化' }); };
        });
      }
      if (message.action === 'LEARNING_OPEN_SOURCE') return { success: true, data: { returnId: 'synthetic', message: '合成来源已打开' } };
      if (message.action === 'LEARNING_RETURN_SOURCE') return { success: true, data: { message: '已返回合成笔记' } };
      return { success: false, error: '合成环境不提供该数据' };
    } }, storage: { local: { get: async () => ({}) }, onChanged: { addListener() {}, removeListener() {} } } };
  });
  await page.goto(origin + '/dashboard/index.html#video-wiki');
  await page.getByText('没有符合筛选的视频页', { exact: true }).waitFor();
  await page.evaluate(async ({ assets, wiki }) => {
    const db = await window.__db();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['lgAssets', 'lgMeta', 'lgWiki'], 'readwrite');
      assets.forEach(asset => tx.objectStore('lgAssets').put(asset)); tx.objectStore('lgMeta').put({ key: 'state', epoch: 0, revision: 1 }); tx.objectStore('lgWiki').put(wiki);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    }); db.close();
  }, { assets, wiki });
  await page.getByRole('button', { name: '刷新视频 Wiki', exact: true }).click();
  const first = () => page.locator('.wiki-page-row').filter({ hasText: '从需求到交付' }); await first().waitFor();
  assert.equal(await page.locator('.wiki-page-row').count(), 2);
  await first().click(); await page.getByText('P2 关键原句', { exact: true }).waitFor();
  await page.getByRole('button', { name: '预览来源', exact: true }).last().click();
  const preview = page.getByRole('region', { name: '来源预览', exact: true }); await preview.waitFor();
  assert.equal(await page.evaluate(() => window.__calls.some(call => call.action === 'LEARNING_OPEN_SOURCE')), false);
  await preview.getByRole('button', { name: '确认打开来源' }).click();
  await page.getByRole('button', { name: '返回笔记与原位置' }).click();
  await page.getByRole('button', { name: '编辑笔记', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: '编辑学习笔记' });
  await dialog.getByRole('textbox', { name: '我的笔记', exact: true }).fill('稳定交付：我的验收清单更新了。');
  assert.equal(await page.evaluate(() => window.dispatchEvent(new Event('bb-before-navigate', { cancelable: true }))), false);
  await dialog.getByRole('button', { name: '保存修改' }).click(); await dialog.waitFor({ state: 'hidden' });
  assert.equal((await page.evaluate(() => window.__read())).assets.find(row => row.id === 'a'.repeat(64)).personal.note, '稳定交付：我的验收清单更新了。');
  await page.getByRole('button', { name: '新建主题', exact: true }).click(); await page.getByRole('textbox', { name: '新主题名称' }).fill('我的验收实践');
  await page.getByRole('button', { name: '新建', exact: true }).click(); await page.getByText('主题已新建。', { exact: true }).waitFor();
  await page.locator('.wiki-membership > summary').click();
  await page.getByRole('combobox', { name: '我的验收实践 的归属方式' }).selectOption('include'); await page.getByText('主题归属已更新。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '重命名当前主题' }).click(); await page.getByRole('textbox', { name: '主题名称', exact: true }).fill('长期保留的工程实践');
  await page.getByRole('button', { name: '保存', exact: true }).click(); await page.getByText('主题名称已更新。', { exact: true }).waitFor();
  await page.locator('.wiki-membership > summary').click();
  for (const [width, height] of [[1440, 1000], [390, 844], [320, 640]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => scrollTo(0, 0));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await page.locator('.bb-video-wiki').evaluate(el => el.scrollWidth > el.clientWidth), false);
    await page.screenshot({ path: path.join(out, `wiki-${width}.png`) });
  }
  const markdownEvent = page.waitForEvent('download'); await page.getByRole('button', { name: '导出 Markdown' }).click();
  const markdown = await markdownEvent; await markdown.saveAs(path.join(out, 'synthetic-wiki.md'));
  assert.match(await readFile(path.join(out, 'synthetic-wiki.md'), 'utf8'), /我的验收清单更新了/);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '删除视频页', exact: true }).click(); await page.getByRole('button', { name: '确认删除页面', exact: true }).click();
  await page.getByText('视频页已删除，学习内容仍保留。', { exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.__read())).assets.length, 3);
  await page.reload(); await page.getByRole('button', { name: '刷新视频 Wiki' }).waitFor();
  assert.equal(await first().count(), 0);
  await page.goto(origin + '/dashboard/index.html#learning-notes'); await page.getByText('备份与空间', { exact: true }).click();
  const backupEvent = page.waitForEvent('download'); await page.getByRole('button', { name: '导出备份', exact: true }).click();
  const backup = await backupEvent; const backupPath = path.join(out, 'synthetic-backup.json'); await backup.saveAs(backupPath);
  const saved = JSON.parse(await readFile(backupPath, 'utf8')); assert.equal(saved.format, 'bili-bill-learning-wiki');
  assert.equal(saved.wiki.pages.find(page => page.bvid === 'BV1234567890').deleted, true);
  assert.equal(saved.wiki.topics.find(topic => topic.name === '长期保留的工程实践').term, null);
  await page.getByLabel('选择学习备份').setInputFiles(backupPath);
  await page.getByRole('region', { name: '恢复预览', exact: true }).waitFor();
  assert.match(await page.getByRole('region', { name: '恢复预览' }).textContent(), /组织将由备份替换/);
  await page.getByRole('button', { name: '确认恢复', exact: true }).click(); await page.getByText('已恢复，新增 0 条', { exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.__read())).wiki.pages.find(page => page.bvid === 'BV1234567890').deleted, true);
  assert.equal(await page.evaluate(() => window.__calls.some(call => /ASK_|GENERATE_/.test(call.action))), false);
  assert.deepEqual(errors, []);
  report.status = 'pass'; report.checks = ['real production Wiki and backup workers', 'two-video grouping and two parts', 'single-asset edit with navigation guard', 'source preview / confirm / return', 'manual topic create / include / rename', 'three responsive layouts', 'Markdown saved content', 'delete keeps assets across reload', 'joint backup and confirmed restore preserve tombstone'];
} catch (error) { report.status = 'fail'; report.error = error.stack; report.state = await page.locator('body').innerText(); await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }); process.exitCode = 1; }
finally { await browser.close(); await new Promise(resolve => server.close(resolve)); await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
