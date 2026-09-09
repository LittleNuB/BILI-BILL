import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const { chromium } = await import(pathToFileURL(process.env.UX014_PLAYWRIGHT_MODULE).href);
const html = await readFile(path.join(root, 'tests/current-video-assistant-shell.mock.html'));
const bundle = await readFile(path.join(root, 'dist/content/player-monitor.js'));
const out = path.join(root, 'release-artifacts/ui-297'); await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.UX014_CHROME_EXECUTABLE, headless: true });
const report = { syntheticOnly: true, checks: [] };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/video/')) return route.fulfill({ contentType: 'text/html', body: html });
    if (url.pathname === '/dist/content/player-monitor.js') return route.fulfill({ contentType: 'application/javascript', body: bundle });
    return route.abort();
  });
  await page.goto('https://www.bilibili.com/video/BV1ShellMock9?subtitleCached=1');
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'light');
    window.__quickCalls = []; window.__quickSaved = []; window.__quickFailure = false;
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async message => {
      const p = message.params ?? {}; window.__quickCalls.push(message);
      if (message.action === 'LEARNING_PREPARE' || message.action === 'LEARNING_PREPARE_SOURCE') {
        const capture = { token: 'a'.repeat(64), kind: p.kind ?? 'note', video: { bvid: 'BV1ShellMock9', title: '合成视频' }, part: { cid: '2202', page: 1 }, bookmarkMs: p.positionMs ?? null };
        return { success: true, data: { epoch: 0, capture, ...(p.source ? { snapshot: { origin: 'subtitle', body: '合成来源原文', source: { kind: 'bilibili', hash: 'b'.repeat(64) }, citations: [{ fromMs: 0, toMs: 5000, text: '合成来源原文' }] } } : {}) } };
      }
      if (message.action === 'LEARNING_SAVE') {
        if (window.__quickFailure) { window.__quickFailure = false; throw Error('simulated transport loss'); }
        window.__quickSaved.push(p.asset); return { success: true, data: p.asset };
      }
      if (message.action === 'ASK_LEARNING_CHAT') return send({ ...message, action: 'ASK_CURRENT_VIDEO_FULL_TEXT' });
      return send(message);
    };
    window.__assistantMockSeedSummaryCacheForCurrentSource();
  });
  const card = page.locator('#bdc-current-video-assistant');
  await page.getByRole('button', { name: '展开助手', exact: true }).click();
  assert.deepEqual(await card.getByRole('tab').allTextContents(), ['概览', '字幕', '对话']);
  assert.equal(await card.getByRole('tab', { name: '概览', exact: true }).getAttribute('aria-selected'), 'true');
  await page.getByLabel('主要文本来源', { exact: true }).click();
  await page.getByRole('button', { name: '重新检测字幕', exact: true }).click();
  await page.getByRole('button', { name: '用于视频助手', exact: true }).click();
  await page.getByRole('button', { name: '已用于助手', exact: true }).waitFor();
  await page.getByLabel('主要文本来源', { exact: true }).click();
  await page.evaluate(() => window.__assistantMockSeedSummaryCacheForCurrentSource());
  await page.getByRole('button', { name: '收起', exact: true }).click();
  await page.getByRole('button', { name: '展开助手', exact: true }).click();
  const chat = page.getByRole('textbox', { name: '聊天输入', exact: true });
  await card.getByText('长内容可能分段整理，增加模型请求与等待时间。', { exact: true }).waitFor();
  await chat.fill('问题草稿');
  await page.evaluate(() => window.__assistantMockSetPlaybackPosition(204));
  await page.getByRole('button', { name: '切换到笔记', exact: true }).click();
  const note = page.getByRole('textbox', { name: '笔记输入', exact: true });
  assert.equal(await card.getByText('长内容可能分段整理，增加模型请求与等待时间。', { exact: true }).count(), 0);
  await note.fill('个人笔记草稿');
  await page.getByRole('button', { name: '切换到提问', exact: true }).click(); assert.equal(await chat.inputValue(), '问题草稿');
  await page.getByRole('button', { name: '切换到笔记', exact: true }).click(); assert.equal(await note.inputValue(), '个人笔记草稿');
  await note.fill('');
  await page.evaluate(() => window.__assistantMockSetPlaybackPosition(234));
  await page.screenshot({ path: path.join(out, 'note-desktop.png') });
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await card.getByText('已保存', { exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.__quickSaved[0])).bookmarkMs, 204000);
  assert.equal(await page.evaluate(() => window.__assistantMockPlaybackPosition()), 234);
  assert.equal(await card.getByRole('tab', { name: '概览', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await chat.inputValue(), '问题草稿');
  await page.getByRole('button', { name: '切换到笔记', exact: true }).click(); await note.fill('失败不丢');
  await page.evaluate(() => window.__quickFailure = true);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: '重试确认', exact: true }).click();
  await chat.waitFor();
  const attempts = await page.evaluate(() => window.__quickCalls.filter(x => x.action === 'LEARNING_SAVE').map(x => x.params.asset));
  assert.deepEqual(attempts[1], attempts[2]);
  assert.equal(await page.evaluate(() => window.__quickCalls.filter(x => /ASK_|GENERATE_/.test(x.action)).length), 0);
  await page.getByRole('tab', { name: '字幕', exact: true }).click();
  const line = card.locator('.bdc-assistant-subtitle-line-text').first(); await line.waitFor();
  const selected = await line.evaluate(el => {
    const r = document.createRange(); r.setStart(el.firstChild, 0); r.setEnd(el.firstChild, Math.min(8, el.textContent.length));
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(r);
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return r.toString();
  });
  assert.equal(await card.locator('.bdc-composer-quote').textContent(), selected);
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.getByRole('tab', { name: '概览', exact: true }).click();
  await chat.fill('这个是什么意思？');
  await page.screenshot({ path: path.join(out, 'question-desktop.png') });
  await chat.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  assert.equal(await page.evaluate(() => window.__quickCalls.filter(x => x.action === 'ASK_LEARNING_CHAT').length), 0);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.waitForFunction(() => window.__quickCalls.some(x => x.action === 'ASK_LEARNING_CHAT'));
  assert.equal(await card.getByRole('tab', { name: '对话', exact: true }).getAttribute('aria-selected'), 'true');
  const question = await page.evaluate(() => window.__quickCalls.find(x => x.action === 'ASK_LEARNING_CHAT').params.question);
  assert.ok(question.includes(selected));
  await page.getByRole('button', { name: '发送', exact: true }).waitFor();
  await page.getByRole('button', { name: '收起', exact: true }).click();
  await page.getByRole('button', { name: '展开助手', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[role=tab][aria-selected=true]')?.textContent === '对话');
  for (const [width, height] of [[390, 700], [320, 480], [844, 390]]) {
    await page.setViewportSize({ width, height });
    await page.waitForFunction(() => { const b = document.querySelector('#bdc-current-video-assistant').getBoundingClientRect(); return b.x >= 0 && b.y >= 0 && b.right <= innerWidth && b.bottom <= innerHeight; });
    for (const mode of ['chat', 'note']) {
      if (mode === 'note') await page.getByRole('button', { name: '切换到笔记', exact: true }).click();
      const box = await card.boundingBox(); const action = await page.getByRole('button', { name: mode === 'note' ? '保存' : '发送', exact: true }).boundingBox();
      assert.ok(action.y >= box.y && action.y + action.height <= box.y + box.height + 1);
      assert.equal(await card.evaluate(el => el.scrollWidth > el.clientWidth), false);
      await page.screenshot({ path: path.join(out, `${mode}-${width}x${height}.png`) });
      if (mode === 'note') await page.getByRole('button', { name: '切换到提问', exact: true }).click();
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '切换到笔记', exact: true }).click();
  await note.fill('P1 未提交笔记');
  await page.evaluate(() => window.__assistantMockNavigateToPartWithoutCollect(2));
  await page.waitForFunction(() => document.querySelector('.bdc-assistant-part')?.textContent.includes('P2'));
  await page.getByRole('button', { name: '切换到笔记', exact: true }).click(); assert.equal(await note.inputValue(), '');
  await note.fill('P2 未提交笔记');
  await page.evaluate(() => window.__assistantMockNavigateToPartWithoutCollect(1));
  await page.waitForFunction(() => document.querySelector('.bdc-assistant-part')?.textContent.includes('P1'));
  await page.getByRole('button', { name: '切换到笔记', exact: true }).click(); assert.equal(await note.inputValue(), 'P1 未提交笔记');
  assert.deepEqual(errors, []); report.status = 'pass';
  report.checks = ['three ordered tabs', 'first overview / reopen chat', 'independent drafts', 'empty timestamp note frozen at entry', 'no playback seek', 'same-page save', 'uncertain save identical retry', 'no automatic AI', 'exact selection attachment', 'send only then chat', 'IME guard', 'two modes in three narrow viewports', 'SPA part draft isolation and return'];
} catch (error) { report.status = 'fail'; report.error = error.stack; process.exitCode = 1; }
finally { await browser.close(); await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
