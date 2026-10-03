import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = process.cwd(), out = path.join(root, 'release-artifacts', `knowledge-workspace-${Date.now()}`);
await mkdir(out, { recursive: true });
const baseCss = await readFile(path.join(root, 'dashboard/styles/dashboard.css'), 'utf8');
const bundle = await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import { render } from 'preact';
import { KnowledgePage } from './dashboard/modules/knowledge/KnowledgePage';
import { SourcesPage } from './dashboard/modules/knowledge/SourcesPage';
import { knowledgeRepository as repo } from './dashboard/modules/knowledge/runtime';
import { personalPage } from './src/shared/open-knowledge/workspace';
import { createRevision, videoPageId } from './src/shared/open-knowledge/format';
import { BrowserKnowledgeFiles } from './src/shared/open-knowledge/browser-files';
import { KnowledgeDirectory } from './src/shared/open-knowledge/directory';
window.__permission = 'granted';
FileSystemDirectoryHandle.prototype.queryPermission = async () => window.__permission;
FileSystemDirectoryHandle.prototype.requestPermission = async () => window.__permission;
window.showDirectoryPicker = async () => navigator.storage.getDirectory();
window.qa = { repo, personalPage, createRevision, videoPageId, BrowserKnowledgeFiles, KnowledgeDirectory,
  mount: () => render(<KnowledgePage />, document.getElementById('app')),
  sources: () => render(<SourcesPage />, document.getElementById('app')) };
` }, jsx: 'automatic', jsxImportSource: 'preact', bundle: true, write: false, format: 'esm', platform: 'browser', outdir: 'synthetic' });
const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
const css = baseCss + bundle.outputFiles.find(file => file.path.endsWith('.css')).text;
const server = createServer((request, response) => {
  if (request.url === '/app.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(js); }
  else if (request.url === '/app.css') { response.setHeader('Content-Type', 'text/css'); response.end(css); }
  else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Synthetic knowledge workspace</title><link rel="stylesheet" href="/app.css"><div id="app"></div><script type="module" src="/app.js"></script>'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const { chromium } = await import(pathToFileURL(process.env.UX014_PLAYWRIGHT_MODULE).href);
const report = { syntheticOnly: true, status: 'running', browsers: [], limitations: ['Real components and IndexedDB; folder picker and permission state substituted with OPFS.', 'No Bilibili, real model or installed Codex plugin claim.'] };
try {
  for (const [name, executablePath] of [['Chrome', process.env.UX014_CHROME_EXECUTABLE], ['Edge', process.env.UX014_EDGE_EXECUTABLE]]) {
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(url); await page.waitForFunction(() => !!window.qa);
      await page.evaluate(async () => {
        const { repo, personalPage, videoPageId } = window.qa;
        await repo.save({ ...personalPage('接口设计的实践'), body: '先确定用户真正要完成的任务，再决定接口。\n\n同一个请求重复执行，不应重复创建结果。', topics: ['工程实践'] }, []);
        await repo.save({ ...personalPage('组合与继承'), pageId: videoPageId('BV1234567890'), kind: 'video', bvid: 'BV1234567890', body: '组合能够减少对父类实现的依赖。\n\n实践记录：为不同交付方式设计独立实现。', topics: ['软件设计'], aiNotes: '待验证：把交付方式应用到当前项目。' }, []);
        window.qa.mount();
      });
      await page.getByRole('button', { name: '新建页面', exact: true }).click();
      await page.getByRole('button', { name: '编辑', exact: true }).click();
      await page.getByLabel('页面标题', { exact: true }).fill('我的中文实践');
      await page.getByLabel('页面正文', { exact: true }).fill('中文输入法记录：保留我的实践结论。');
      await page.getByLabel('页面主题', { exact: true }).fill('工程，实践');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.getByRole('heading', { name: '我的中文实践', exact: true }).last().waitFor();
      await page.getByRole('button', { name: '编辑', exact: true }).click();
      await page.getByLabel('页面正文', { exact: true }).fill('关闭后仍要保留的中文草稿');
      await page.getByRole('button', { name: '关闭编辑', exact: true }).click();
      await page.reload(); await page.waitForFunction(() => !!window.qa); await page.evaluate(() => window.qa.mount());
      await page.locator('.knowledge-card').filter({ hasText: '我的中文实践' }).click();
      assert.equal(await page.getByLabel('页面正文', { exact: true }).inputValue(), '关闭后仍要保留的中文草稿');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.getByRole('button', { name: '连接目录', exact: true }).click();
      await page.getByRole('button', { name: '目录已同步', exact: true }).waitFor();
      await page.evaluate(async () => {
        const { repo, createRevision, BrowserKnowledgeFiles, KnowledgeDirectory } = window.qa;
        const directory = new KnowledgeDirectory(new BrowserKnowledgeFiles((await repo.state()).handle));
        const rows = await Promise.all((await repo.pageIds()).map(id => repo.readPage(id)));
        const previous = rows.flatMap(row => row.heads).find(row => row.title === '我的中文实践');
        window.qa.target = previous.pageId; window.__permission = 'denied';
        await repo.save({ ...previous, body: '浏览器离线修改' }, [previous.id]);
        await directory.append(await createRevision({ ...previous, body: 'Codex 外部修改' }, [previous.id], 'codex'));
      });
      await page.getByRole('button', { name: '刷新知识库', exact: true }).click();
      await page.getByText('浏览器离线修改', { exact: true }).last().waitFor();
      await page.evaluate(() => { window.__permission = 'granted'; });
      await page.getByRole('button', { name: '刷新知识库', exact: true }).click();
      await page.getByRole('button', { name: '查看并合并', exact: true }).click();
      const merged = await page.getByLabel('页面正文', { exact: true }).inputValue();
      assert.match(merged, /浏览器离线修改/); assert.match(merged, /Codex 外部修改/);
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.getByRole('button', { name: '版本历史', exact: true }).click();
      await page.locator('.knowledge-history-row').last().click();
      await page.getByRole('button', { name: '恢复为新版本', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('dialog'));
      const state = await page.evaluate(async () => window.qa.repo.readPage(window.qa.target));
      assert.equal(state.heads.length, 1); assert.equal(state.heads[0].actor, 'restore'); assert.ok(state.revisions.length >= 6);
      await page.locator('input[type=file]').setInputFiles({ name: '只读参考.md', mimeType: 'text/markdown', buffer: Buffer.from('# 原文\n\n保持原文件不变，采用一致性模型。') });
      await page.getByRole('heading', { name: '只读参考', exact: true }).last().waitFor();
      await page.getByLabel('搜索知识库', { exact: true }).fill('一致性模型');
      await page.locator('.knowledge-card').filter({ hasText: '只读参考' }).waitFor();
      await page.getByLabel('搜索知识库', { exact: true }).fill('');
      for (const width of [1280, 768, 390]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        await page.screenshot({ path: path.join(out, `${name}-${width}.png`), fullPage: true });
      }
      const requests = [];
      let emptyFolder = false;
      await page.route('https://api.bilibili.com/**', async route => {
        const api = new URL(route.request().url()); requests.push(api.pathname + api.search);
        let data;
        if (api.pathname.endsWith('/nav')) data = { mid: 123, isLogin: true };
        else if (api.pathname.includes('/folder/')) data = { list: [{ id: 11, title: '选中的学习收藏', media_count: 1 }, { id: 12, title: '不应读取的收藏', media_count: 1 }] };
        else {
          assert.equal(api.searchParams.get('media_id'), '11');
          data = { medias: emptyFolder ? [] : [{ id: 1, type: 2, bvid: 'BV1234567890', title: '平台上的视频标题', duration: 120 }], has_more: false };
        }
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ code: 0, data }) });
      });
      await page.evaluate(() => window.qa.sources());
      await page.getByRole('heading', { name: '尚未接入收藏夹' }).waitFor();
      assert.equal(requests.length, 0);
      await page.getByRole('button', { name: '读取收藏夹', exact: true }).click();
      await page.getByLabel('选中的学习收藏').waitFor();
      assert.equal(await page.getByRole('button', { name: '导入所选', exact: true }).isDisabled(), true);
      await page.getByLabel('选中的学习收藏').check();
      await page.getByRole('button', { name: '导入所选', exact: true }).click();
      await page.getByText('已新增或更新 1 条资料，0 条未变化。', { exact: true }).waitFor();
      await page.getByText('已有笔记', { exact: true }).waitFor();
      await page.getByRole('button', { name: '导入所选', exact: true }).click();
      await page.getByText('已新增或更新 0 条资料，1 条未变化。', { exact: true }).waitFor();
      emptyFolder = true;
      await page.getByRole('button', { name: '导入所选', exact: true }).click();
      await page.getByText(/已有笔记均保留/).waitFor();
      assert.equal(await page.locator('.knowledge-source-list button').count(), 1);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.screenshot({ path: path.join(out, `${name}-sources.png`), fullPage: true });
      assert.deepEqual(errors, []);
      report.browsers.push({ name, version: browser.version(), status: 'pass', checks: ['personal_edit', 'draft_after_restart', 'folder_sync', 'offline_save', 'external_readback', 'conflict_merge', 'history_restore', 'readonly_markdown_search', 'responsive_layout', 'explicit_folder_selection', 'idempotent_reimport', 'remote_deletion_preserves_notes'] });
      await context.close();
    } finally { await browser.close(); }
  }
  report.status = 'pass';
} catch (error) { report.status = 'fail'; report.error = String(error); process.exitCode = 1; }
finally { await new Promise(resolve => server.close(resolve)); await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ output: out, ...report }, null, 2)); }
