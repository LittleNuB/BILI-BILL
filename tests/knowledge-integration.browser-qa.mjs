import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { NodeKnowledgeFiles } from '../packages/open-knowledge/node-files.mjs';
import { KnowledgeDirectory } from '../src/shared/open-knowledge/directory.ts';
import { KnowledgeAgent } from '../packages/codex-knowledge/service.mjs';

const root = process.cwd(), out = path.join(root, 'release-artifacts', `knowledge-integration-${Date.now()}`);
await mkdir(out, { recursive: true });
const built = await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import { render } from 'preact';
import { KnowledgePage } from './dashboard/modules/knowledge/KnowledgePage';
import { SourcesPage } from './dashboard/modules/knowledge/SourcesPage';
import { knowledgeRepository as repo } from './dashboard/modules/knowledge/runtime';
import { KnowledgeNotes } from './src/background/storage/knowledge-notes';
import { KnowledgeDirectory } from './src/shared/open-knowledge/directory';
import { createSource, imageAttachment } from './src/shared/open-knowledge/sources';
import { retrieveOpenKnowledge } from './src/background/open-knowledge-chat';
import { refreshReadonlyReferences } from './src/background/storage/open-knowledge-references';
import { addReadonlyReferences } from './src/background/storage/open-knowledge-references';
const files = { read: async path => { const value = await window.qaFs('read', path); return value ? Uint8Array.from(value) : null; },
 putImmutable: (path, bytes) => window.qaFs('put', path, Array.from(bytes)), list: path => window.qaFs('list', path) };
const directory = new KnowledgeDirectory(files);
window.__permission = 'granted'; window.__referenceWrites = 0; window.__permissionModes = [];
FileSystemFileHandle.prototype.queryPermission = async options => { window.__permissionModes.push(options.mode); return window.__permission; };
FileSystemFileHandle.prototype.requestPermission = async options => { window.__permissionModes.push(options.mode); return window.__permission; };
const writable = FileSystemFileHandle.prototype.createWritable;
FileSystemFileHandle.prototype.createWritable = function(...args) { window.__referenceWrites++; return writable.apply(this, args); };
window.showOpenFilePicker = async () => [await (await navigator.storage.getDirectory()).getFileHandle('selected.md')];
window.qa = { repo, directory, KnowledgeNotes, createSource, imageAttachment, retrieveOpenKnowledge, refreshReadonlyReferences, addReadonlyReferences,
 mount: () => { render(null, document.getElementById('app')); render(<KnowledgePage />, document.getElementById('app')); },
 sources: () => { render(null, document.getElementById('app')); render(<SourcesPage />, document.getElementById('app')); } };
` }, jsx: 'automatic', jsxImportSource: 'preact', bundle: true, write: false, format: 'esm', platform: 'browser', outdir: 'synthetic' });
const js = built.outputFiles.find(file => file.path.endsWith('.js')).text;
const css = await readFile(path.join(root, 'dashboard/styles/dashboard.css'), 'utf8') + built.outputFiles.find(file => file.path.endsWith('.css')).text;
const server = createServer((request, response) => {
  if (request.url === '/app.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(js); }
  else if (request.url === '/app.css') { response.setHeader('Content-Type', 'text/css'); response.end(css); }
  else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html data-theme="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Synthetic knowledge integration</title><link rel="stylesheet" href="/app.css"><div id="app"></div><script type="module" src="/app.js"></script></html>'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const { chromium } = await import(pathToFileURL(process.env.UX014_PLAYWRIGHT_MODULE).href);
const report = { syntheticOnly: true, status: 'running', browsers: [], limitations: [
  'Browser repository and Codex service access one real OS directory through a scoped test IO bridge, not native folder-picker permission.',
  'Readonly handles use real OPFS, with permission and picker substituted; human confirmation is simulated by the test host.',
  'No real Bilibili, real model or installed Codex host acceptance is claimed.'
] };
try {
  for (const [name, executablePath] of [['Chrome', process.env.UX014_CHROME_EXECUTABLE], ['Edge', process.env.UX014_EDGE_EXECUTABLE]]) {
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const folder = path.join(out, `${name}-shared-library`); await mkdir(folder);
      const files = await NodeKnowledgeFiles.open(folder), directory = new KnowledgeDirectory(files);
      let permission = true;
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await context.exposeBinding('qaFs', async (_, operation, file, bytes) => {
        if (!permission) throw Error('knowledge_permission');
        if (operation === 'read') { const data = await files.read(file); return data ? Array.from(data) : null; }
        if (operation === 'put') { await files.putImmutable(file, Uint8Array.from(bytes)); return true; }
        if (operation === 'list') return files.list(file);
        throw Error('unexpected operation');
      });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(url); await page.waitForFunction(() => !!window.qa);
      const saved = await page.evaluate(async () => {
        const q = window.qa, anchor = { bvid: 'BV1234567890', cid: '42', page: 1, title: '接口设计的学习记录', timeMs: 1500, capturedAt: Date.now(), method: 'frame' };
        const source = await q.createSource({ kind: 'subtitles', video: { bvid: anchor.bvid, cid: anchor.cid, page: anchor.page, title: anchor.title },
          label: 'B站字幕', language: 'zh', version: 'synthetic', capturedAt: anchor.capturedAt,
          text: '先界定问题。\n契约测试能够保护接口。\n最后检查边界。', segments: [{ fromMs: 0, toMs: 1000, text: '先界定问题。' },
            { fromMs: 1000, toMs: 2000, text: '契约测试能够保护接口。' }, { fromMs: 2000, toMs: 4000, text: '最后检查边界。' }], derivedFrom: null, legacyAsset: null });
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#f6f7f8'; ctx.fillRect(0, 0, 640, 360);
        ctx.fillStyle = '#18191c'; ctx.font = '24px sans-serif'; ctx.fillText('Synthetic capture: interface contract', 36, 70);
        ctx.fillStyle = '#00a1d6'; ctx.fillRect(40, 130, 150, 70); ctx.fillStyle = '#fb7299'; ctx.fillRect(240, 130, 150, 70);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        const image = await q.imageAttachment(new Uint8Array(await blob.arrayBuffer()));
        const notes = new q.KnowledgeNotes(q.repo.database), note = await notes.begin({ id: crypto.randomUUID(), key: 'BV1234567890:42:1', epoch: (await q.repo.state()).epoch,
          version: 0, anchor, text: '稳定交付需要接口契约。', quote: '', sources: [source], images: [image], savedRevision: null, savedSource: null });
        const receipt = await notes.save(note.id, note.epoch, note.version); await notes.finish(note.id, note.epoch, note.version);
        await q.repo.connect(q.directory); await q.repo.sync(q.directory); q.mount();
        return { ...receipt, sourceId: source.id, imageId: image.id, libraryId: (await q.repo.state()).libraryId };
      });
      const agent = await KnowledgeAgent.open({ libraryPath: folder, libraryId: saved.libraryId, allowAiNotesWrites: false, readOnlyMarkdown: [] });
      assert.equal((await agent.search('契约')).results[0].pageId, saved.pageId);
      assert.match((await agent.readSource(saved.pageId, saved.sourceId)).text, /最后检查边界/);
      const before = (await directory.readPage(saved.pageId)).heads[0];
      const proposal = await agent.propose({ pageId: saved.pageId, base: [before.id], changes: { body: before.body + '\n\n项目实践：先跑契约测试。' }, reason: '合成确认往返' });
      assert.equal((await directory.readPage(saved.pageId)).heads[0].id, before.id);
      assert.equal((await agent.apply(proposal.proposalId, async review => { assert.match(review.diff, /\+项目实践/); return false; })).status, 'not_applied');
      assert.equal((await agent.apply(proposal.proposalId, async review => { assert.match(review.diff, /\+项目实践/); return true; })).status, 'applied');
      await page.evaluate(async id => { await window.qa.repo.sync(window.qa.directory); window.qa.mount(); }, saved.pageId);
      await page.locator('.knowledge-card').filter({ hasText: '接口设计的学习记录' }).click();
      await page.getByText('项目实践：先跑契约测试。', { exact: true }).last().waitFor();
      const retrieval = await page.evaluate(() => window.qa.retrieveOpenKnowledge('契约测试'));
      assert.ok(retrieval.refs.some(ref => ref.excerpt.includes('项目实践')));
      const shared = (await directory.readPage(saved.pageId)).heads[0];
      permission = false;
      await page.evaluate(async id => { const { repo } = window.qa, row = (await repo.readPage(id)).heads[0]; await repo.save({ ...row, body: row.body + '\n\n浏览器离线补记。' }, [row.id]); }, saved.pageId);
      await assert.rejects(page.evaluate(() => window.qa.repo.sync(window.qa.directory)), /permission/);
      const concurrent = await agent.propose({ pageId: saved.pageId, base: [shared.id], changes: { body: shared.body + '\n\nCodex 并发补充。' }, reason: '合成冲突' });
      await agent.apply(concurrent.proposalId, async () => true); permission = true;
      await page.evaluate(async () => { await window.qa.repo.sync(window.qa.directory); window.qa.mount(); });
      await page.locator('.knowledge-card').filter({ hasText: '接口设计的学习记录' }).click();
      await page.getByRole('button', { name: '查看并合并', exact: true }).click();
      const mergeText = await page.getByLabel('页面正文', { exact: true }).inputValue();
      assert.match(mergeText, /浏览器离线补记/); assert.match(mergeText, /Codex 并发补充/);
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.getByRole('button', { name: '编辑', exact: true }).waitFor();
      await page.evaluate(() => window.qa.repo.sync(window.qa.directory));
      const merged = (await directory.readPage(saved.pageId)).heads; assert.equal(merged.length, 1);
      const restore = await agent.propose({ pageId: saved.pageId, base: [merged[0].id], changes: {}, kind: 'restore', restoreId: before.id, reason: '合成恢复' });
      await agent.apply(restore.proposalId, async () => true);
      await page.evaluate(async () => { await window.qa.repo.sync(window.qa.directory); window.qa.mount(); });
      await page.locator('.knowledge-card').filter({ hasText: '接口设计的学习记录' }).click();
      await page.getByRole('button', { name: '版本历史', exact: true }).click();
      await page.screenshot({ path: path.join(out, `${name}-history.png`), fullPage: true });
      await page.getByRole('button', { name: '关闭', exact: true }).click();
      await page.getByRole('button', { name: '知识库备份与恢复', exact: true }).click();
      const downloadReady = page.waitForEvent('download');
      await page.getByRole('button', { name: '导出备份', exact: true }).click();
      const backupPath = path.join(out, `${name}-knowledge-backup.json`); await (await downloadReady).saveAs(backupPath);
      await page.getByRole('button', { name: '关闭', exact: true }).click();
      await page.evaluate(async () => { await window.qa.repo.clear(); window.qa.mount(); });
      await page.getByRole('heading', { name: '从一条笔记开始', exact: true }).waitFor();
      await page.getByRole('button', { name: '知识库备份与恢复', exact: true }).click();
      await page.getByLabel('选择知识库备份文件', { exact: true }).setInputFiles(backupPath);
      await page.getByRole('heading', { name: '恢复预览', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.qa.repo.database.okFiles.count()), 0);
      await page.screenshot({ path: path.join(out, `${name}-restore-preview.png`), fullPage: true });
      await page.getByRole('button', { name: '确认恢复', exact: true }).click();
      await page.getByText('已恢复到本地，目录连接后继续写入。', { exact: true }).waitFor();
      await page.getByRole('button', { name: '关闭', exact: true }).click();
      await page.locator('.knowledge-card').filter({ hasText: '接口设计的学习记录' }).click();
      assert.equal(await page.evaluate(async id => (await window.qa.repo.readPage(id)).revisions.length, saved.pageId), 6);
      const imageSize = await page.evaluate(async id => (await window.qa.repo.readAttachment(id)).bytes.length, saved.imageId); assert.ok(imageSize > 100);
      for (const width of [1280, 768, 390]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        await page.screenshot({ path: path.join(out, `${name}-${width}.png`), fullPage: true });
      }
      await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        for (const [name, text] of [['selected.md', '项目经验：通过契约测试确保稳定交付。'], ['not-selected.md', '禁止被自动读取的私有文档']]) {
          const handle = await root.getFileHandle(name, { create: true }), writer = await handle.createWritable(); await writer.write(text); await writer.close();
        }
        window.__referenceWrites = 0; window.qa.sources();
      });
      await page.getByRole('button', { name: '接入文件', exact: true }).click();
      await page.getByRole('button', { name: 'selected.md', exact: true }).waitFor();
      const external = await page.evaluate(async () => ({ rows: await window.qa.repo.database.okReferences.toArray(), writes: window.__referenceWrites, modes: window.__permissionModes }));
      assert.equal(external.rows.length, 1); assert.equal(external.writes, 0); assert.deepEqual(new Set(external.modes), new Set(['read']));
      const changed = await page.evaluate(async () => {
        const handle = await (await navigator.storage.getDirectory()).getFileHandle('selected.md'), writer = await handle.createWritable();
        await writer.write('项目经验更新：契约测试仍然必要。新的独有词。'); await writer.close(); window.__referenceWrites = 0;
        return (await handle.getFile()).text();
      });
      await page.getByRole('button', { name: '刷新只读资料', exact: true }).click();
      await page.getByRole('button', { name: 'selected.md', exact: true }).click();
      await page.getByText(changed, { exact: true }).waitFor();
      await page.getByRole('button', { name: '关闭', exact: true }).click();
      await page.reload(); await page.waitForFunction(() => !!window.qa); await page.evaluate(() => window.qa.sources());
      await page.getByRole('button', { name: 'selected.md', exact: true }).waitFor();
      const readonlyRefs = await page.evaluate(() => window.qa.retrieveOpenKnowledge('新的独有词'));
      assert.equal(readonlyRefs.refs[0].location.kind, 'reference');
      await page.evaluate(async () => { window.__permission = 'denied'; await window.qa.refreshReadonlyReferences(window.qa.repo); });
      assert.equal((await page.evaluate(() => window.qa.retrieveOpenKnowledge('新的独有词'))).refs.length, 0);
      await page.evaluate(() => { window.__permission = 'granted'; });
      await page.getByRole('button', { name: '刷新只读资料', exact: true }).click();
      await page.getByRole('button', { name: '移除 selected.md 的引用', exact: true }).click();
      await page.getByText('尚未选择文件', { exact: true }).waitFor();
      const original = await page.evaluate(async () => ({ text: await (await (await (await navigator.storage.getDirectory()).getFileHandle('selected.md')).getFile()).text(), writes: window.__referenceWrites }));
      assert.equal(original.text, changed); assert.equal(original.writes, 0); assert.deepEqual(errors, []);
      report.browsers.push({ name, version: browser.version(), status: 'pass', checks: ['image_and_full_source_save', 'shared_real_directory', 'agent_bounded_read',
        'proposal_preview_reject_accept', 'browser_readback', 'browser_knowledge_retrieval', 'offline_conflict_merge', 'agent_history_restore',
        'backup_preview_restore_images_sources_history_proposals', 'readonly_selection_refresh_restart_revoke_remove', 'no_original_file_writes', '1280_768_390_layout'] });
      await context.close();
    } finally { await browser.close(); }
  }
  report.status = 'pass';
} catch (error) { report.status = 'fail'; report.error = String(error); process.exitCode = 1; }
finally { await new Promise(resolve => server.close(resolve)); await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ output: out, ...report }, null, 2)); }
