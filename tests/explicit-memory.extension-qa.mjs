import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, realpath, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = await realpath(process.cwd());
const out = path.join(root, 'release-artifacts/memory-293', `runtime-${Date.now()}`);
const profile = path.join(out, 'synthetic-browser'); await mkdir(out, { recursive: true });
const { chromium } = await import(pathToFileURL(process.env.UX014_PLAYWRIGHT_MODULE).href);
const report = { syntheticOnly: true, productionExtension: true, readsPersonalBrowserState: false,
  profile, profileRemoved: false, sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).trim(),
  workingTreeDirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), status: 'running', checks: [] };
let context;
async function launch() {
  context = await chromium.launchPersistentContext(profile, { executablePath: process.env.UX014_BROWSER_EXECUTABLE, headless: true,
    viewport: { width: 1280, height: 900 }, ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${path.join(root, 'dist')}`, `--load-extension=${path.join(root, 'dist')}`, '--proxy-server=http://127.0.0.1:9'] });
  await context.route(/^https?:\/\//, route => route.abort());
  const worker = context.serviceWorkers().find(worker => /chrome-extension:\/\/[^/]+\/background\.js$/.test(worker.url()))
    ?? await context.waitForEvent('serviceworker', { timeout: 15000 });
  // URL.origin is opaque for extension URLs in Node.
  const extension = worker.url().replace(/\/background\.js$/, '');
  const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('dialog', dialog => dialog.accept());
  await page.goto(extension + '/dashboard/index.html#settings');
  return { page, worker, extension };
}
try {
  let { page, worker, extension } = await launch();
  report.extensionId = new URL(worker.url()).hostname;
  report.manifest = await worker.evaluate(() => ({ name: chrome.runtime.getManifest().name, version: chrome.runtime.getManifest().version }));
  let region = page.getByRole('region', { name: '目标与偏好', exact: true });
  await region.getByText('尚未保存目标或偏好。').waitFor();
  assert.equal(await region.locator('label.settings-toggle input').isChecked(), false);
  await region.getByRole('button', { name: '添加目标或偏好', exact: true }).click();
  await region.getByRole('textbox', { name: '记忆内容', exact: true }).fill('合成验收：讲解时先给出一个具体例子。');
  await region.getByLabel('选用于后续对话').check();
  await region.getByRole('button', { name: '确认记住', exact: true }).click();
  await region.getByText('已保存。', { exact: true }).waitFor();
  const saved = await page.evaluate(() => chrome.runtime.sendMessage({ action: 'MEMORY_OPERATION', params: { op: 'read' } }));
  assert.equal(saved.success, true); assert.equal(saved.data.items.length, 1);
  assert.equal(saved.data.items[0].text, '合成验收：讲解时先给出一个具体例子。');
  const learning = await page.evaluate(() => chrome.runtime.sendMessage({ action: 'LEARNING_LIST', params: {} }));
  assert.equal(learning.success, true);
  const disabledChat = await page.evaluate(() => chrome.runtime.sendMessage({ action: 'ASK_LEARNING_CHAT', params: { requestId: 'synthetic', sessionId: 'synthetic', turnId: 'synthetic', question: '合成离线加载检查' } }));
  assert.equal(disabledChat.success, true); assert.equal(disabledChat.data.status, 'disabled');
  await region.screenshot({ path: path.join(out, 'real-extension-memory.png') });
  await context.close(); context = undefined;
  ({ page, worker, extension } = await launch());
  region = page.getByRole('region', { name: '目标与偏好', exact: true });
  await region.getByText('合成验收：讲解时先给出一个具体例子。', { exact: true }).waitFor();
  const restored = await page.evaluate(() => chrome.runtime.sendMessage({ action: 'MEMORY_OPERATION', params: { op: 'read' } }));
  assert.deepEqual(restored, saved);
  await region.getByRole('button', { name: '删除记忆', exact: true }).click();
  await region.getByText('尚未保存目标或偏好。').waitFor();
  const stale = await page.evaluate(draft => chrome.runtime.sendMessage({ action: 'MEMORY_OPERATION', params: { op: 'save', revision: draft.revision, draft: draft.items[0] } }), saved.data);
  assert.equal(stale.success, false);
  await page.goto(extension + '/dashboard/index.html#video-wiki');
  await page.getByRole('heading', { name: '视频 Wiki', exact: true }).waitFor();
  await page.screenshot({ path: path.join(out, 'real-extension-wiki-empty.png') });
  await page.goto(extension + '/popup/index.html'); await page.screenshot({ path: path.join(out, 'real-extension-popup.png') });
  report.checks = ['production extension loads', 'default-off management', 'runtime dispatcher saves to real IndexedDB', 'learning and chat static module graph works without DOM', 'whole browser restart preserves exact record', 'delete and stale write rejection', 'Wiki production worker opens', 'popup renders'];
  report.distSha256 = {};
  for (const file of await readdir(path.join(root, 'dist'), { recursive: true, withFileTypes: true })) {
    if (!file.isFile()) continue;
    const absolute = path.join(file.parentPath, file.name); const relative = path.relative(path.join(root, 'dist'), absolute).replaceAll('\\', '/');
    report.distSha256[relative] = createHash('sha256').update(await readFile(absolute)).digest('hex');
  }
  report.status = 'pass';
} catch (error) {
  report.status = 'fail'; report.error = error.stack; process.exitCode = 1;
  const current = context?.pages().at(-1);
  report.memoryStatus = await current?.locator('#explicit-memory').textContent().catch(() => null);
  report.memoryResponse = await current?.evaluate(() => chrome.runtime.sendMessage({ action: 'MEMORY_OPERATION', params: { op: 'read' } })).catch(error => ({ error: error.message }));
  await current?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
}
finally { await context?.close(); await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ out, ...report })); }
