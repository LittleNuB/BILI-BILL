import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const { chromium } = await import(pathToFileURL(process.env.UX014_PLAYWRIGHT_MODULE).href);
const html = await readFile(path.join(root, 'tests/current-video-assistant-shell.mock.html'));
const bundle = await readFile(path.join(root, 'dist/content/player-monitor.js'));
const out = path.join(root, 'release-artifacts/knowledge-291'); await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.UX014_CHROME_EXECUTABLE, headless: true });
const report = { syntheticOnly: true, checks: [] };
let observed;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); const errors = [];
  observed = page;
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/video/')) return route.fulfill({ contentType: 'text/html', body: html });
    if (url.pathname === '/dist/content/player-monitor.js') return route.fulfill({ contentType: 'application/javascript', body: bundle });
    return route.abort();
  });
  await page.goto('https://www.bilibili.com/video/BV1ShellMock9');
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'light');
    chrome.runtime.getURL = path => `chrome-extension://synthetic/${path}`;
    const send = chrome.runtime.sendMessage.bind(chrome.runtime); const replies = new Map(); window.__knowledgeCalls = [];
    chrome.runtime.sendMessage = async message => {
      window.__knowledgeCalls.push(message);
      if (message.action === 'LEARNING_GET') return { success: true, data: window.__deletedKnowledge ? null : { id: 'a'.repeat(64) } };
      if (message.action === 'ASK_LEARNING_CHAT') {
        const result = await send({ ...message, action: 'ASK_CURRENT_VIDEO_FULL_TEXT' });
        Object.assign(result.data, { answerMode: 'learning', status: 'invalid_output', answer: '知识库·个人笔记：先明确验收标准。[1]\n拓展知识：这不保证覆盖所有项目。[99]', canRetry: false, citations: [],
          knowledgeReferences: [{ number: 1, id: 'a'.repeat(64), title: '交付检查笔记', videoTitle: '合成学习视频', bvid: 'BV1234567890', page: 2, label: '个人笔记', excerpt: '先明确验收标准，再验证关键流程。', digest: 'b'.repeat(64) }] });
        replies.set(message.params.turnId, result.data); return result;
      }
      const result = await send(message);
      if (message.action === 'GET_CURRENT_VIDEO_QA_SESSIONS' && result.data?.activeSession) for (const turn of result.data.activeSession.turns) {
        const reply = replies.get(turn.turnId); if (reply) Object.assign(turn, reply);
      }
      return result;
    };
  });
  await page.getByRole('button', { name: '展开助手', exact: true }).click();
  await page.getByRole('textbox', { name: '聊天输入', exact: true }).fill('如何稳定交付？');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const cite = page.getByRole('button', { name: '查看知识引用 1', exact: true }); await cite.waitFor(); await cite.click();
  const preview = page.getByRole('region', { name: '知识引用 1', exact: true });
  await preview.getByText('先明确验收标准，再验证关键流程。', { exact: true }).waitFor();
  await preview.getByText('原条目已有更新；以上为本次回答保存时的节选。', { exact: true }).waitFor();
  const href = await preview.getByRole('link', { name: '打开完整条目', exact: true }).getAttribute('href');
  assert.equal(new URL(href).searchParams.get('learningAsset'), 'a'.repeat(64)); assert.equal(new URL(href).hash, '#learning-notes');
  assert.equal(await page.getByRole('button', { name: '查看知识引用 99', exact: true }).count(), 0);
  assert.match(await page.locator('.bdc-chat-answer').last().textContent(), /未关联来源/);
  for (const [width, height] of [[1440, 1000], [390, 700], [320, 480]]) {
    await page.setViewportSize({ width, height });
    const card = page.locator('#bdc-current-video-assistant');
    await page.waitForFunction(() => { const b = document.querySelector('#bdc-current-video-assistant').getBoundingClientRect(); return b.right <= innerWidth && b.bottom <= innerHeight; });
    assert.equal(await card.evaluate(el => el.scrollWidth > el.clientWidth), false);
    await page.screenshot({ path: path.join(out, `citation-${width}.png`) });
  }
  await page.getByRole('button', { name: '关闭引用', exact: true }).click();
  await page.evaluate(() => window.__deletedKnowledge = true); await cite.click();
  await preview.getByText('原条目已删除；以上为本次回答保存时的节选。', { exact: true }).waitFor();
  assert.equal(await preview.getByRole('link').count(), 0);
  assert.equal(await page.evaluate(() => window.__knowledgeCalls.filter(c => c.action === 'ASK_LEARNING_CHAT').length), 1);

  const dashboard = await browser.newPage({ viewport: { width: 1280, height: 960 } }); dashboard.on('pageerror', e => errors.push(e.message));
  await dashboard.addInitScript(() => {
    const stored = {}; const listeners = new Set(); window.__dashboardCalls = [];
    const row = { id: 'a'.repeat(64), kind: 'note', video: { bvid: 'BV1234567890', title: '合成学习视频' }, part: { page: 2, cid: '22' }, personal: { title: '交付检查笔记', note: '先明确验收标准，再验证关键流程。', tags: [] }, snapshot: null, bookmarkMs: null, importedFrom: null, createdAt: 1, updatedAt: 1 };
    window.chrome = { runtime: { sendMessage: async message => {
      window.__dashboardCalls.push(message);
      if (message.action === 'GET_CONFIG_SNAPSHOT') return { success: true, data: { revision: 'mock', config: { ai: { baseURL: 'https://example.invalid', apiKey: '', chatModel: 'mock' }, assistant: { currentVideoAiAssistantEnabled: true, smartFavoritesQaAiEnabled: false }, dynamicBill: { aiExplanationsEnabled: false } } } };
      if (message.action === 'LEARNING_GET') return { success: true, data: row };
      if (message.action === 'LEARNING_LIST') return { success: true, data: { epoch: 0, total: 1, allTotal: 1, bytes: 300, videos: [row.video], offset: 0, items: [] } };
      return { success: false, error: '合成环境未提供该数据' };
    } }, storage: { local: { get: async () => ({ ...stored }), set: async values => { const changes = {}; for (const key of Object.keys(values)) { changes[key] = { oldValue: stored[key], newValue: values[key] }; stored[key] = values[key]; } listeners.forEach(cb => cb(changes, 'local')); } },
      onChanged: { addListener: cb => listeners.add(cb), removeListener: cb => listeners.delete(cb) } } };
    window.__knowledgeSetting = () => stored.knowledgeAiAuthorization?.enabled;
  });
  await dashboard.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'extension.invalid') return route.abort();
    const file = path.resolve(root, 'dist', '.' + url.pathname);
    if (!file.startsWith(path.join(root, 'dist') + path.sep)) return route.abort();
    try { const body = await readFile(file); return route.fulfill({ body, contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }); }
    catch { return route.abort(); }
  });
  await dashboard.goto('https://extension.invalid/dashboard/index.html#settings');
  const knowledgeToggle = dashboard.locator('label.settings-toggle').filter({ hasText: '学习笔记用于 AI 问答' }).locator('input');
  await knowledgeToggle.waitFor({ state: 'attached' }); await knowledgeToggle.check({ force: true });
  await dashboard.waitForFunction(() => window.__knowledgeSetting() === true);
  await knowledgeToggle.uncheck({ force: true }); await dashboard.waitForFunction(() => window.__knowledgeSetting() === false);
  assert.equal(await dashboard.evaluate(() => window.__dashboardCalls.some(c => /ASK_|GENERATE_/.test(c.action))), false);
  await dashboard.screenshot({ path: path.join(out, 'settings.png') });
  await dashboard.goto('https://extension.invalid/dashboard/index.html?learningAsset=' + 'a'.repeat(64) + '#learning-notes');
  await dashboard.getByText('先明确验收标准，再验证关键流程。', { exact: true }).waitFor();
  assert.ok(await dashboard.evaluate(() => window.__dashboardCalls.some(c => c.action === 'LEARNING_GET' && c.params.id === 'a'.repeat(64))));
  assert.deepEqual(errors, []);
  report.status = 'pass'; report.checks = ['inline citation and exact preview', 'unknown reference not actionable', 'updated and deleted source labels', 'three viewport layouts', 'no extra AI on citation', 'production settings toggle and no automatic AI', 'production dashboard opens exact saved entry'];
} catch (error) { report.status = 'fail'; report.error = error.stack; report.state = await observed?.locator('#bdc-current-video-assistant').textContent(); await observed?.screenshot({ path: path.join(out, 'failure.png') }); process.exitCode = 1; }
finally { await browser.close(); await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
