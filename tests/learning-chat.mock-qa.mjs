import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const { chromium } = await import(pathToFileURL(process.env.UX014_PLAYWRIGHT_MODULE).href);
const html = await readFile(path.join(root, 'tests/current-video-assistant-shell.mock.html'));
const bundle = await readFile(path.join(root, 'dist/content/player-monitor.js'));
const out = path.join(root, 'release-artifacts/chatbot-289'); await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.UX014_CHROME_EXECUTABLE, headless: true });
const report = { syntheticOnly: true, checks: [] };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/video/')) return route.fulfill({ contentType: 'text/html', body: html });
    if (url.pathname === '/dist/content/player-monitor.js') return route.fulfill({ contentType: 'application/javascript', body: bundle });
    return route.abort();
  });
  await page.goto('https://www.bilibili.com/video/BV1ShellMock9');
  await page.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.__chatCalls = []; const responses = new Map(); const pending = new Map();
    chrome.runtime.sendMessage = async message => {
      if (message.action === 'GET_LEARNING_CHAT_PROGRESS') return { success: true, data: { text: pending.get(message.params.requestId)?.text ?? '' } };
      if (message.action === 'CANCEL_LEARNING_CHAT') { const run = pending.get(message.params.requestId); if (run) run.stopped = true; return { success: true, data: {} }; }
      if (message.action === 'ASK_LEARNING_CHAT') {
        window.__chatCalls.push(message);
        const run = { text: '视频内容\n先明确验收标准。', stopped: false }; pending.set(message.params.requestId, run);
        await new Promise(resolve => setTimeout(resolve, 700));
        if (!run.stopped) run.text += '\n\n拓展知识\n可以把需求拆成可验证的小步骤，再逐步实现。';
        await new Promise(resolve => setTimeout(resolve, 700));
        const result = await send({ ...message, action: 'ASK_CURRENT_VIDEO_FULL_TEXT' });
        Object.assign(result.data, { answerMode: 'learning', status: run.stopped ? 'cancelled' : 'invalid_output', answer: run.text,
          message: run.stopped ? '已停止，以下内容未完成。' : '参考当前视频，拓展内容由模型补充。', canRetry: run.stopped, citations: [] });
        responses.set(message.params.turnId, result.data); pending.delete(message.params.requestId); return result;
      }
      const result = await send(message);
      if (message.action === 'GET_CURRENT_VIDEO_QA_SESSIONS' && result.data?.activeSession) {
        for (const turn of result.data.activeSession.turns) { const update = responses.get(turn.turnId); if (update) Object.assign(turn, update); }
      }
      return result;
    };
  });
  const card = page.locator('#bdc-current-video-assistant');
  await page.getByRole('button', { name: '展开助手', exact: true }).click();
  await page.getByRole('tab', { name: '对话', exact: true }).click();
  const input = page.getByRole('textbox', { name: '聊天输入', exact: true });
  await input.fill('如何稳定交付？');
  const before = await card.boundingBox();
  const header = card.locator('.bdc-assistant-header'); const h = await header.boundingBox();
  await page.mouse.move(h.x + 60, h.y + 15); await page.mouse.down();
  await page.mouse.move(h.x - 120, h.y - 65, { steps: 8 }); await page.mouse.up();
  const moved = await card.boundingBox(); assert.ok(moved.x < before.x - 100); assert.equal(await input.inputValue(), '如何稳定交付？');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await card.locator('[data-chat-live]').filter({ hasText: '先明确验收标准' }).waitFor();
  await input.fill('生成中仍可写下一问');
  await page.getByRole('button', { name: '发送', exact: true }).waitFor();
  assert.equal(await input.inputValue(), '生成中仍可写下一问');
  assert.equal(await card.locator('.bdc-chat-message').count(), 1);
  await input.fill('第二步展开讲讲'); await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('button', { name: '发送', exact: true }).waitFor();
  assert.equal(await card.locator('.bdc-chat-message').count(), 2);
  assert.equal(new Set(await page.evaluate(() => window.__chatCalls.map(call => call.params.sessionId))).size, 1);
  assert.equal(await card.getByRole('button', { name: '保存答案', exact: true }).count(), 0);
  await page.screenshot({ path: path.join(out, 'desktop.png') });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await page.screenshot({ path: path.join(out, 'desktop-light.png') });
  await input.fill('这次停止'); await page.getByRole('button', { name: '发送', exact: true }).click();
  await card.locator('[data-chat-live]').filter({ hasText: '先明确验收标准' }).waitFor();
  await page.getByRole('button', { name: '停止生成', exact: true }).click();
  await page.getByRole('button', { name: '发送', exact: true }).waitFor();
  await page.getByText('已停止，以下内容未完成。', { exact: true }).waitFor();
  await input.fill('留在原会话的草稿');
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  assert.equal(await input.inputValue(), '');
  await page.getByLabel('会话与聊天设置', { exact: true }).click();
  await card.locator('.bdc-chat-menu .bdc-assistant-session-button').first().click();
  assert.equal(await input.inputValue(), '留在原会话的草稿');
  await page.getByRole('button', { name: '收起', exact: true }).click();
  const compact = card.locator('.bdc-assistant-compact'); const c = await compact.boundingBox();
  await page.mouse.move(c.x + 60, c.y + 16); await page.mouse.down(); await page.mouse.move(c.x - 160, c.y + 16, { steps: 8 }); await page.mouse.up();
  assert.equal(await card.getAttribute('class'), 'bdc-assistant-collapsed');
  await page.getByRole('button', { name: '展开助手', exact: true }).click();
  assert.equal(await input.inputValue(), '留在原会话的草稿');
  for (const [width, height] of [[390, 700], [320, 480], [844, 390]]) {
    await page.setViewportSize({ width, height });
    await page.waitForFunction(() => { const b = document.querySelector('#bdc-current-video-assistant').getBoundingClientRect(); return b.x >= 0 && b.y >= 0 && b.right <= innerWidth && b.bottom <= innerHeight; });
    const b = await card.boundingBox(); assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.width <= width && b.y + b.height <= height);
    assert.equal(await card.evaluate(el => el.scrollWidth > el.clientWidth), false);
    const textbox = await input.boundingBox(); const send = await page.getByRole('button', { name: '发送', exact: true }).boundingBox();
    assert.ok(textbox.y + textbox.height <= send.y + 1); assert.ok(send.y + send.height <= b.y + b.height);
    await page.screenshot({ path: path.join(out, `${width}x${height}.png`) });
  }
  assert.deepEqual(errors, []);
  report.status = 'pass'; report.checks = ['titlebar and compact drag', 'draft preservation', 'stream visible before completion', 'same-session multi-turn', 'stop retains partial', 'no verified save for mixed prose', 'session drafts', 'three narrow viewports', 'no page errors'];
} catch (error) { report.status = 'fail'; report.error = error.stack; process.exitCode = 1; }
finally { await browser.close(); await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
