import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { db } from '../src/background/storage/db.ts';
import { ExplicitMemoryRepository } from '../src/background/storage/explicit-memory-repo.ts';
const root = process.cwd(), out = path.join(root, 'release-artifacts/memory-293'); await mkdir(out, { recursive: true });
const { chromium } = await import(pathToFileURL(process.env.UX014_PLAYWRIGHT_MODULE).href);
const browser = await chromium.launch({ executablePath: process.env.UX014_CHROME_EXECUTABLE, headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
const repo = new ExplicitMemoryRepository(db); await db.open();
const errors = [], report = { syntheticOnly: true, bridge: 'production repository in fake IndexedDB; production UI with controlled runtime bridge', status: 'running' };
let page;
await context.exposeBinding('__memoryBridge', async (_source, input) => {
  try { return { success: true, data: await repo.operate(input) }; }
  catch (error) { return { success: false, error: error.message }; }
});
await context.exposeBinding('__sessionBridge', async (_source, sessionId) => {
  await db.currentVideoQaSessions.put({ sessionId, title: '合成对话', customTitle: null, createdAt: 1, updatedAt: 1, lastAccessedAt: 1, turns: [] });
});
try {
  page = await context.newPage(); page.setDefaultTimeout(8000); page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.addInitScript(() => {
    const stored = {}; const listeners = new Set(); window.__calls = [];
    window.chrome = { runtime: { getURL: file => `https://extension.invalid/${file}`, sendMessage: async message => {
      window.__calls.push(message);
      if (message.action === 'MEMORY_OPERATION') return window.__memoryBridge(message.params);
      if (message.action === 'GET_CONFIG_SNAPSHOT') return { success: true, data: { revision: 'synthetic', config: { ai: { baseURL: 'https://example.invalid', apiKey: '', chatModel: 'mock' }, assistant: { currentVideoAiAssistantEnabled: true, smartFavoritesQaAiEnabled: false }, dynamicBill: { aiExplanationsEnabled: false } } } };
      return { success: false, error: '合成环境不提供该数据' };
    } }, storage: { local: { get: async () => structuredClone(stored), set: async values => { const changes = {}; for (const key of Object.keys(values)) { changes[key] = { oldValue: stored[key], newValue: values[key] }; stored[key] = values[key]; } listeners.forEach(cb => cb(changes, 'local')); } }, onChanged: { addListener: cb => listeners.add(cb), removeListener: cb => listeners.delete(cb) } } };
    window.__memoryEnabled = () => stored.memoryAiAuthorization?.enabled;
  });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url()); if (url.hostname !== 'extension.invalid') return route.abort();
    const file = path.resolve(root, 'dist', '.' + url.pathname); if (!file.startsWith(path.join(root, 'dist') + path.sep)) return route.abort();
    try { return route.fulfill({ body: await readFile(file), contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }); }
    catch { return route.abort(); }
  });
  await page.goto('https://extension.invalid/dashboard/index.html#settings');
  const region = page.getByRole('region', { name: '目标与偏好', exact: true });
  await region.getByText('尚未保存目标或偏好。').waitFor();
  const toggle = region.locator('label.settings-toggle input'); assert.equal(await toggle.isChecked(), false);
  await toggle.check({ force: true }); await page.waitForFunction(() => window.__memoryEnabled() === true);
  await region.getByRole('button', { name: '添加目标或偏好', exact: true }).click();
  await region.getByRole('textbox', { name: '记忆内容', exact: true }).fill('请用中文，先讲结论再举例。');
  await region.getByLabel('选用于后续对话').check();
  assert.equal(await page.evaluate(() => { const event = new Event('bb-before-navigate', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), true);
  await region.getByRole('button', { name: '确认记住', exact: true }).click(); await region.getByText('已保存。', { exact: true }).waitFor();
  assert.equal((await repo.read()).items[0].selected, true);
  await region.getByRole('button', { name: '编辑记忆', exact: true }).click(); await region.getByRole('textbox', { name: '记忆内容', exact: true }).fill('请先给出一个可运行的小例子。');
  let state = await repo.read(); await repo.save(state.revision, { ...state.items[0], text: '其他窗口刚更新' });
  await region.getByRole('button', { name: '确认记住', exact: true }).click(); await region.getByText(/记忆已在其他页面更新/).waitFor();
  assert.equal(await region.getByRole('textbox', { name: '记忆内容', exact: true }).inputValue(), '请先给出一个可运行的小例子。');
  await region.getByRole('button', { name: '刷新并保留草稿', exact: true }).click();
  await region.getByRole('button', { name: '确认记住', exact: true }).click(); await region.getByText('已保存。', { exact: true }).waitFor();
  await region.getByRole('button', { name: '添加目标或偏好', exact: true }).click();
  await region.getByRole('textbox', { name: '记忆内容', exact: true }).fill('密码：synthetic-only');
  await region.getByRole('button', { name: '确认记住', exact: true }).click(); await region.getByText(/不要保存密码、密钥或登录信息。请删除敏感内容/).waitFor();
  await region.getByRole('button', { name: '取消', exact: true }).click();
  for (const [width, height] of [[1280, 960], [390, 760], [320, 620]]) {
    await page.setViewportSize({ width, height }); await region.scrollIntoViewIfNeeded();
    assert.equal(await region.evaluate(el => el.scrollWidth > el.clientWidth), false);
    await region.screenshot({ path: path.join(out, `memory-settings-${width}.png`) });
  }
  await toggle.uncheck({ force: true }); await page.waitForFunction(() => window.__memoryEnabled() === false);
  assert.equal(await page.evaluate(() => window.__calls.some(call => /ASK_|GENERATE_/.test(call.action))), false);
  await region.getByRole('button', { name: '删除记忆', exact: true }).click(); await region.getByText('尚未保存目标或偏好。').waitFor();

  const chat = await context.newPage(); chat.setDefaultTimeout(8000); chat.on('pageerror', error => errors.push(error.message));
  const html = await readFile(path.join(root, 'tests/current-video-assistant-shell.mock.html'));
  const bundle = await readFile(path.join(root, 'dist/content/player-monitor.js'));
  await chat.route('**/*', route => { const url = new URL(route.request().url());
    if (url.pathname.startsWith('/video/')) return route.fulfill({ contentType: 'text/html', body: html });
    if (url.pathname === '/dist/content/player-monitor.js') return route.fulfill({ contentType: 'application/javascript', body: bundle }); return route.abort();
  });
  await chat.goto('https://www.bilibili.com/video/BV1ShellMock9');
  await chat.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime); window.__memoryCalls = [];
    chrome.runtime.sendMessage = async message => {
      window.__memoryCalls.push(message);
      if (message.action === 'MEMORY_OPERATION') return window.__memoryBridge(message.params);
      if (message.action === 'ASK_LEARNING_CHAT') { await window.__sessionBridge(message.params.sessionId); return original({ ...message, action: 'ASK_CURRENT_VIDEO_FULL_TEXT' }); }
      return original(message);
    };
  });
  await chat.getByRole('button', { name: '展开助手', exact: true }).click();
  await chat.getByRole('textbox', { name: '聊天输入', exact: true }).fill('我希望用项目实例来学习。');
  await chat.getByRole('button', { name: '发送', exact: true }).click();
  await chat.getByRole('button', { name: '记住为目标或偏好', exact: true }).last().click();
  const modal = chat.getByRole('dialog', { name: '记住目标或偏好', exact: true });
  await modal.getByRole('button', { name: '确认记住', exact: true }).waitFor();
  assert.equal((await repo.read()).items.length, 0);
  await modal.getByRole('button', { name: '确认记住', exact: true }).click(); await modal.getByText(/已记住/).waitFor();
  assert.equal((await repo.read()).items.length, 1);
  await modal.screenshot({ path: path.join(out, 'memory-chat-confirmed.png') });
  await modal.getByRole('button', { name: '完成', exact: true }).click();
  await chat.getByLabel('会话与聊天设置', { exact: true }).click();
  await chat.getByRole('button', { name: '删除会话', exact: true }).click();
  const deletion = chat.getByRole('dialog', { name: '删除这个本地会话？', exact: true });
  const linked = deletion.getByLabel('同时删除从此会话保存的关联记忆'); assert.equal(await linked.isChecked(), false); await linked.check();
  await deletion.getByRole('button', { name: '确认删除', exact: true }).click();
  await chat.waitForFunction(() => window.__memoryCalls.some(call => call.action === 'DELETE_CURRENT_VIDEO_QA_SESSION' && call.params.deleteAssociatedMemory === true));
  assert.deepEqual(errors, []); report.status = 'pass';
  report.checks = ['default-off and explicit enable', 'production repository CRUD', 'stale revision retains draft', 'secret rejection', 'draft navigation guard', 'three settings viewports', 'no automatic AI', 'chat action requires confirmation', 'chat deletion default retain and explicit associated removal parameter'];
} catch (error) { report.status = 'fail'; report.error = error.stack; await page?.screenshot({ path: path.join(out, 'failure.png') }); process.exitCode = 1; }
finally { await browser.close(); db.close(); await db.delete(); await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
