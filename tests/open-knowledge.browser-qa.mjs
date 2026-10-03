import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { NodeKnowledgeFiles } from '../packages/open-knowledge/node-files.mjs';
import { KnowledgeDirectory } from '../src/shared/open-knowledge/directory.ts';
import { createRevision } from '../src/shared/open-knowledge/format.ts';

const root = process.cwd(), out = path.join(root, 'release-artifacts', `open-knowledge-storage-${Date.now()}`);
await mkdir(out, { recursive: true });
const bundle = await build({ stdin: { resolveDir: root, contents: `
export { BiliAnalyticsDB } from './src/background/storage/db.ts';
export { KnowledgeRepository } from './src/background/storage/open-knowledge-repo.ts';
export { BrowserKnowledgeFiles } from './src/shared/open-knowledge/browser-files.ts';
export { KnowledgeDirectory } from './src/shared/open-knowledge/directory.ts';
export { videoPageId } from './src/shared/open-knowledge/format.ts';` }, bundle: true, write: false, format: 'esm', platform: 'browser' });
const js = bundle.outputFiles[0].text;
const server = createServer((request, response) => {
  if (request.url === '/module.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(js); }
  else if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Synthetic knowledge storage QA</title>'); }
  else { response.statusCode = 404; response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const { chromium } = await import(pathToFileURL(process.env.UX014_PLAYWRIGHT_MODULE).href);
const report = { syntheticOnly: true, status: 'running', bundleSha256: createHash('sha256').update(js).digest('hex'), browsers: [],
  limitations: ['OPFS exercises real browser file handles, not the user-selected folder permission prompt.',
    'Node/browser interchange uses identical file bytes, not simultaneous access to one OS directory.',
    'No real Bilibili, model, image capture or installed Codex plugin acceptance is claimed.'] };
try {
  for (const [name, executablePath] of [['Chrome', process.env.UX014_CHROME_EXECUTABLE], ['Edge', process.env.UX014_EDGE_EXECUTABLE]]) {
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const context = await browser.newContext(), errors = [];
      let page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.goto(url);
      const exported = await page.evaluate(async () => {
        const api = await import('/module.js'), db = new api.BiliAnalyticsDB('synthetic-knowledge');
        const repository = new api.KnowledgeRepository(db);
        const storage = await navigator.storage.getDirectory(), handle = await storage.getDirectoryHandle('Bili-Bill', { create: true });
        const files = new api.BrowserKnowledgeFiles(handle), directory = new api.KnowledgeDirectory(files);
        const row = await repository.save({ pageId: api.videoPageId('BV1234567890'), kind: 'video', bvid: 'BV1234567890', title: '合成知识条目',
          body: '浏览器保存的中文笔记', aiNotes: '', topics: ['设计'], sourceIds: [], attachmentIds: [], legacyIds: [], createdAt: 1 }, []);
        await repository.saveDraft('synthetic-video', '尚未发送的草稿');
        const pendingBefore = (await repository.status()).pending;
        await repository.connect(directory, handle); await repository.sync(directory);
        const paths = ['library.json', `pages/${row.pageId}/${row.id}.md`], entries = [];
        for (const path of paths) entries.push({ path, bytes: Array.from(await files.read(path)) });
        return { entries, pageId: row.pageId, revisionId: row.id, pendingBefore, pendingAfter: (await repository.status()).pending };
      });
      assert.equal(exported.pendingBefore, 1); assert.equal(exported.pendingAfter, 0);
      const nodeRoot = path.join(out, `node-library-${name.toLowerCase()}`); await mkdir(nodeRoot);
      const nodeFiles = await NodeKnowledgeFiles.open(nodeRoot), directory = new KnowledgeDirectory(nodeFiles);
      for (const entry of exported.entries) await nodeFiles.putImmutable(entry.path, Uint8Array.from(entry.bytes));
      await directory.connect(); const original = (await directory.readPage(exported.pageId)).heads[0];
      assert.equal(original.body, '浏览器保存的中文笔记');
      const update = await createRevision({ ...original, body: 'Node 补充的项目实践' }, [original.id], 'codex', original.updatedAt + 1);
      await directory.append(update);
      const updatePath = `pages/${update.pageId}/${update.id}.md`, updateBytes = Array.from(await nodeFiles.read(updatePath));
      await page.close(); page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.goto(url);
      const readback = await page.evaluate(async input => {
        const api = await import('/module.js'), db = new api.BiliAnalyticsDB('synthetic-knowledge'), repository = new api.KnowledgeRepository(db);
        const handle = (await repository.state()).handle, files = new api.BrowserKnowledgeFiles(handle);
        await files.putImmutable(input.path, Uint8Array.from(input.bytes));
        await repository.sync(new api.KnowledgeDirectory(files));
        const page = await repository.readPage(input.pageId);
        return { body: page.heads[0].body, revisions: page.revisions.length, draft: await repository.draft('synthetic-video'), pending: (await repository.status()).pending };
      }, { path: updatePath, bytes: updateBytes, pageId: update.pageId });
      assert.deepEqual(readback, { body: 'Node 补充的项目实践', revisions: 2, draft: '尚未发送的草稿', pending: 0 });
      assert.deepEqual(errors, []);
      report.browsers.push({ name, version: browser.version(), status: 'pass', realIndexedDb: true, realOpfs: true, persistedHandleAfterPageRestart: true, nodeByteInterchange: true });
      await context.close();
    } finally { await browser.close(); }
  }
  report.status = 'pass';
} catch (error) { report.status = 'fail'; report.error = String(error); process.exitCode = 1; }
finally {
  await new Promise(resolve => server.close(resolve));
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output: out, ...report }, null, 2));
}
