import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = process.cwd(), out = path.join(root, 'release-artifacts', `knowledge-onboarding-${Date.now()}`);
await mkdir(out, { recursive: true });
const bundle = await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import { render } from 'preact';
import { App } from './dashboard/App';
import { knowledgeRepository as repo } from './dashboard/modules/knowledge/runtime';
import { DEFAULT_CONFIG } from './src/shared/types/config';
import { imageAttachment, createSource } from './src/shared/open-knowledge/sources';
import { VISION_SETTINGS_KEY } from './src/shared/chat-images';
const values = JSON.parse(localStorage.getItem('qa-storage') || 'null') || {};
const listeners = new Set();
window.qa = { repo, values, calls: JSON.parse(sessionStorage.getItem('qa-calls') || '[]'), imageAttachment, createSource, VISION_SETTINGS_KEY };
window.chrome = {
  runtime: { sendMessage: async message => {
    qa.calls.push(message);
    sessionStorage.setItem('qa-calls', JSON.stringify(qa.calls));
    const ok = data => ({ success: true, data });
    switch (message.action) {
      case 'GET_SYNC_STATUS': return ok({ lastSyncTime: 0, totalRecords: 0 });
      case 'GET_CONFIG_SNAPSHOT': return ok({ config: structuredClone(DEFAULT_CONFIG), revision: 'synthetic-config' });
      case 'TEST_AI_CONNECTION': return ok({ model: message.params.ai.chatModel, latencyMs: 1, checkedAt: Date.now() });
      case 'AI_PROMPT_SETTINGS': return ok({ version: 1, revision: 'synthetic-prompts', configRevision: 'synthetic-config', values: {}, previous: {} });
      case 'MEMORY_OPERATION': return ok({ key: 'state', revision: 0, items: [] });
      default: return { success: false, error: 'Synthetic fixture has no data for this action' };
    }
  } },
  permissions: { contains: (_input, callback) => callback(true), request: (_input, callback) => callback(true) },
  storage: {
    local: {
      get: async keys => Object.fromEntries((typeof keys === 'string' ? [keys] : keys).map(key => [key, values[key]])),
      set: async change => {
        Object.assign(values, change); localStorage.setItem('qa-storage', JSON.stringify(values));
        for (const listener of listeners) listener(Object.fromEntries(Object.entries(change).map(([key, newValue]) => [key, { newValue }])), 'local');
      }
    },
    onChanged: { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener) }
  }
};
window.__permission = 'granted';
FileSystemDirectoryHandle.prototype.queryPermission = async () => window.__permission;
FileSystemDirectoryHandle.prototype.requestPermission = async () => window.__permission;
window.showDirectoryPicker = async () => navigator.storage.getDirectory();
render(<App />, document.getElementById('app'));
` }, jsx: 'automatic', jsxImportSource: 'preact', bundle: true, write: false, format: 'esm', platform: 'browser', outdir: 'synthetic' });
const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
const css = await readFile(path.join(root, 'dashboard/styles/dashboard.css'), 'utf8') + bundle.outputFiles.find(file => file.path.endsWith('.css')).text;
const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/app.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(js); }
  else if (pathname === '/app.css') { response.setHeader('Content-Type', 'text/css'); response.end(css); }
  else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Synthetic onboarding QA</title><link rel="stylesheet" href="/app.css"><div id="app"></div><script type="module" src="/app.js"></script>'); }
});
const report = { syntheticOnly: true, status: 'running', browsers: [], limitations: ['Production App, routing, components and IndexedDB; synthetic settings runtime and OPFS picker.', 'No installed extension, real site, model connectivity or native folder picker acceptance claim.'] };
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const { chromium } = await import(pathToFileURL(process.env.UX014_PLAYWRIGHT_MODULE).href);
  const url = `http://127.0.0.1:${server.address().port}/#video-wiki`;
  for (const [name, executablePath] of [['Chrome', process.env.UX014_CHROME_EXECUTABLE], ['Edge', process.env.UX014_EDGE_EXECUTABLE]]) {
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors = [], remoteRequests = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        if (new URL(route.request().url()).hostname !== '127.0.0.1') { remoteRequests.push(route.request().url()); return route.abort(); }
        return route.continue();
      });
      await page.goto(url);
      await page.getByRole('heading', { name: '从一条笔记开始' }).waitFor();
      await page.getByRole('button', { name: '使用帮助', exact: true }).click();
      const help = page.getByRole('dialog', { name: '开始记录', exact: true });
      await help.waitFor();
      await page.keyboard.press('Escape');
      await help.waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '使用帮助');
      await page.getByRole('button', { name: '使用帮助', exact: true }).click();
      await help.getByRole('button', { name: '新建个人页', exact: true }).click();
      await page.getByLabel('页面标题', { exact: true }).fill('第一条中文学习笔记');
      await page.getByLabel('页面正文', { exact: true }).fill('没有字幕或模型也可以保存自己的记录。');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.getByText('已保存到此浏览器。', { exact: true }).waitFor();
      await page.getByRole('button', { name: '已存浏览器', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: '目录已同步', exact: true }).count(), 0);
      await page.getByRole('button', { name: '查看已保存页面', exact: true }).click();
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '页面详情');
      await page.getByRole('button', { name: '关闭提示', exact: true }).click();
      assert.equal(await page.getByRole('button', { name: '查看已保存页面', exact: true }).count(), 0);
      await page.reload();
      await page.locator('.knowledge-card').filter({ hasText: '第一条中文学习笔记' }).click();
      await page.getByText('没有字幕或模型也可以保存自己的记录。', { exact: true }).last().waitFor();
      // Include immutable source/image references in the draft used for setup/return.
      await page.evaluate(async () => {
        const { repo, imageAttachment, createSource } = qa;
        const id = (await repo.pageIds())[0], previous = (await repo.readPage(id)).heads[0];
        const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), ch => ch.charCodeAt(0));
        const image = await imageAttachment(bytes);
        const source = await createSource({ kind: 'external', video: null, label: '合成资料', language: null, version: 'synthetic:1', capturedAt: Date.now(), text: '用于检查返回时保留来源。', segments: [], derivedFrom: null, legacyAsset: null });
        await repo.save({ ...previous, attachmentIds: [image.id], sourceIds: [source.id] }, [previous.id], { attachments: [image], sources: [source] });
        qa.target = id; qa.imageId = image.id; qa.sourceId = source.id;
      });
      await page.getByRole('button', { name: '刷新知识库', exact: true }).click();
      await page.getByRole('button', { name: '编辑', exact: true }).click();
      await page.evaluate(() => { qa.originalSaveDraft = qa.repo.saveDraft.bind(qa.repo); qa.repo.saveDraft = async () => { throw Error('knowledge_offline'); }; });
      await page.getByLabel('页面正文', { exact: true }).fill('草稿写入失败时不能丢失的内容');
      await page.getByRole('button', { name: '使用帮助', exact: true }).click();
      await help.getByText('按需配置', { exact: true }).click();
      await help.getByRole('button', { name: '图片模型', exact: true }).click();
      await page.locator('.knowledge-feedback.is-error').waitFor();
      assert.equal(new URL(page.url()).hash, '#video-wiki');
      assert.equal(await page.getByLabel('页面正文', { exact: true }).inputValue(), '草稿写入失败时不能丢失的内容');
      await help.getByRole('button', { name: '关闭', exact: true }).click();
      await page.getByRole('button', { name: '关闭错误提示', exact: true }).click();
      await page.evaluate(() => { qa.repo.saveDraft = qa.originalSaveDraft; });
      await page.getByLabel('页面正文', { exact: true }).fill('配置后需要恢复的中文草稿，不能提前发给 AI。');
      await page.getByRole('button', { name: '使用帮助', exact: true }).click();
      await help.getByText('按需配置', { exact: true }).click();
      await help.getByRole('button', { name: '图片模型', exact: true }).click();
      await page.getByRole('button', { name: '返回知识库', exact: true }).waitFor();
      await page.waitForFunction(() => document.activeElement?.id === 'knowledge-setup-vision');
      assert.equal(await page.evaluate(() => qa.calls.some(call => call.action === 'TEST_AI_CONNECTION')), false);
      await page.locator('#knowledge-setup-vision input[type=text], #knowledge-setup-vision input:not([type])').fill('synthetic-vision');
      await page.getByRole('button', { name: '检查模型连接', exact: true }).click();
      await page.getByText(/此检查使用文字消息/).waitFor();
      const calls = await page.evaluate(() => qa.calls.filter(call => call.action === 'TEST_AI_CONNECTION'));
      assert.equal(calls.length, 1); assert.equal(calls[0].params.ai.chatModel, 'synthetic-vision');
      assert.equal(await page.locator('#knowledge-setup-vision input[type=checkbox]').isChecked(), false);
      await page.getByRole('button', { name: '返回知识库', exact: true }).click();
      await page.getByLabel('页面正文', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('页面正文', { exact: true }).inputValue(), '配置后需要恢复的中文草稿，不能提前发给 AI。');
      assert.equal(new URL(page.url()).searchParams.has('knowledgeResume'), false);
      const draft = await page.evaluate(async () => JSON.parse((await qa.repo.database.okDrafts.where('id').startsWith('edit:' + qa.target + ':').first()).body));
      assert.deepEqual(draft.page.attachmentIds, [await page.evaluate(() => qa.imageId)]);
      assert.deepEqual(draft.page.sourceIds, [await page.evaluate(() => qa.sourceId)]);
      await page.getByRole('button', { name: '使用帮助', exact: true }).click();
      await help.getByText('按需配置', { exact: true }).click();
      await help.getByRole('button', { name: '文字 AI', exact: true }).click();
      await page.waitForFunction(() => document.activeElement?.id === 'knowledge-setup-ai');
      await page.reload();
      await page.getByRole('button', { name: '返回知识库', exact: true }).click();
      await page.getByLabel('页面正文', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('页面正文', { exact: true }).inputValue(), '配置后需要恢复的中文草稿，不能提前发给 AI。');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.getByText('已保存到此浏览器。', { exact: true }).waitFor();
      await page.getByRole('button', { name: '使用帮助', exact: true }).click();
      await help.getByText('按需配置', { exact: true }).click();
      await help.getByRole('button', { name: '本地目录', exact: true }).click();
      await page.getByRole('dialog', { name: '本地目录', exact: true }).getByRole('button', { name: '连接目录', exact: true }).click();
      await page.getByRole('button', { name: '目录已同步', exact: true }).waitFor();
      await page.getByRole('dialog', { name: '本地目录', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
      await page.evaluate(() => { window.__permission = 'denied'; });
      await page.getByRole('button', { name: '编辑', exact: true }).click();
      await page.getByLabel('页面正文', { exact: true }).fill('目录断连后仍可保存。');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.getByText('已保存到此浏览器，目录恢复后继续写入。', { exact: true }).waitFor();
      await page.getByRole('button', { name: /已存浏览器 · .* 项待写入/ }).waitFor();
      await page.evaluate(() => { window.__permission = 'granted'; });
      await page.getByRole('button', { name: '刷新知识库', exact: true }).click();
      await page.getByRole('button', { name: '目录已同步', exact: true }).waitFor();
      for (const width of [1280, 768, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.getByRole('button', { name: '使用帮助', exact: true }).click();
        await help.waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        assert.equal(await help.evaluate(element => element.scrollWidth > element.clientWidth + 1), false);
        await page.screenshot({ path: path.join(out, `${name}-${width}-help.png`), fullPage: true });
        await help.getByRole('button', { name: '关闭', exact: true }).click();
        await page.screenshot({ path: path.join(out, `${name}-${width}-workspace.png`), fullPage: true });
      }
      assert.deepEqual(errors, []); assert.deepEqual(remoteRequests, []);
      assert.equal(await page.evaluate(() => qa.calls.filter(call => call.action === 'TEST_AI_CONNECTION').length), 1);
      assert.equal(await page.evaluate(() => qa.values.knowledgeAiAuthorization || qa.values.memoryAiAuthorization || qa.values[qa.VISION_SETTINGS_KEY]), undefined);
      report.browsers.push({ name, version: browser.version(), status: 'pass', checks: ['empty and nonempty help reopening', 'Escape returns focus', 'no config first note and reload', 'dismissible save/error feedback and page focus', 'failed draft write blocks setup without losing input', 'vision and text setup return', 'setup reload preserves Chinese draft/image/source', 'explicit model health check does not enable vision', 'browser/connected/offline/recovered status', '1280/768/390 no horizontal overflow', 'no remote or automatic model calls'] });
      await context.close();
    } finally { await browser.close(); }
  }
  report.status = 'pass';
} catch (error) { report.status = 'fail'; report.error = error.stack || String(error); process.exitCode = 1; }
finally { await new Promise(resolve => server.close(resolve)); await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ output: out, ...report }, null, 2)); }
