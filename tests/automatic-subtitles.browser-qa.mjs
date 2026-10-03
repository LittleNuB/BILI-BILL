import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.cwd(), out = path.join(root, 'release-artifacts', `automatic-subtitles-${Date.now()}`);
await mkdir(out, { recursive: true });
const originalHtml = await readFile(path.join(root, 'tests/current-video-assistant-shell.mock.html'), 'utf8');
const bundle = await readFile(path.join(root, 'dist/content/player-monitor.js'));
const setup = `<script>
window.qa = { available: false, calls: [], states: {}, fail: true, hold: false, release: null, deferEvidence: false, releaseEvidence: null };
const rawSend = chrome.runtime.sendMessage.bind(chrome.runtime), listeners = [];
const rawListen = chrome.storage.onChanged.addListener.bind(chrome.storage.onChanged);
chrome.storage.onChanged.addListener = fn => { listeners.push(fn); rawListen(fn); };
const rawSet = chrome.storage.local.set.bind(chrome.storage.local);
chrome.storage.local.set = async values => {
  await rawSet(values);
  if ('subtitleCorrectionEnabled' in values) for (const fn of listeners) fn({ subtitleCorrectionEnabled: { newValue: values.subtitleCorrectionEnabled } }, 'local');
};
chrome.runtime.sendMessage = async message => {
  qa.calls.push(message); const p = message.params || {};
  if (message.action === 'GET_CURRENT_VIDEO_TRANSCRIPT_EVIDENCE' && !qa.available) return { success: true, data: (await rawSend({ action: 'GET_CURRENT_VIDEO_CONTEXT' })).data.transcriptEvidence };
  if (message.action === 'GET_CURRENT_VIDEO_TRANSCRIPT_EVIDENCE' && qa.deferEvidence) {
    qa.deferEvidence = false; const response = await rawSend(message);
    return new Promise(resolve => { qa.releaseEvidence = () => resolve(response); });
  }
  if (message.action === 'SUBTITLE_CORRECTION') {
    if (p.mode === 'stop') { qa.release?.(); return { success: true, data: null }; }
    const source = (await rawSend({ action: 'GET_CURRENT_VIDEO_SUBTITLE_VIEW_SOURCES' })).data.sources[0];
    const key = source.identity.sourceIdentityKey;
    let state = qa.states[key] || { key, sourceIdentityKey: key, corrected: {}, failed: [], total: source.lines.length, done: 0, status: 'idle', message: '', updatedAt: Date.now() };
    if (p.mode === 'step') {
      if (qa.hold) await new Promise(resolve => { qa.release = resolve; });
      const count = qa.fail && !p.retry ? 1 : source.lines.length;
      state = { ...state, corrected: Object.fromEntries(source.lines.slice(0, count).map(line => [line.lineId, '优化后的文字：' + line.text])), done: count,
        failed: count === 1 ? [1] : [], status: count === 1 ? 'partial' : 'complete', message: count === 1 ? '部分字幕未完成，保留原文，可重试。' : 'AI 优化版，仅作阅读辅助。' };
    }
    qa.states[key] = state; return { success: true, data: state };
  }
  return rawSend(message);
};
</script>`;
const html = originalHtml.replace('<script type="module" src="/dist/content/player-monitor.js">', setup + '<script type="module" src="/dist/content/player-monitor.js">');
const { chromium } = await import(pathToFileURL(process.env.UX014_PLAYWRIGHT_MODULE).href);
const report = { syntheticOnly: true, browsers: [], limitations: ['Real production content bundle; Bilibili and model responses are synthetic.', 'Actual Bilibili subtitle timing and real model quality remain acceptance work.'] };
try {
  for (const [name, executablePath] of [['Chrome', process.env.UX014_CHROME_EXECUTABLE], ['Edge', process.env.UX014_EDGE_EXECUTABLE]]) {
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.pathname.startsWith('/video/')) return route.fulfill({ contentType: 'text/html', body: html });
        if (url.pathname === '/dist/content/player-monitor.js') return route.fulfill({ contentType: 'text/javascript', body: bundle });
        return route.abort();
      });
      await page.goto('https://www.bilibili.com/video/BV1ShellMock9');
      await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'light'); window.__assistantMockSetPlaybackPosition(0); });
      await page.getByRole('button', { name: '展开助手', exact: true }).click();
      const card = page.locator('#bdc-current-video-assistant');
      assert.deepEqual(await card.getByRole('tab').allTextContents(), ['概览', '字幕', '对话']);
      await page.waitForFunction(() => qa.calls.some(call => call.action === 'GET_CURRENT_VIDEO_TRANSCRIPT_EVIDENCE'));
      await page.evaluate(() => {
        qa.available = true; const button = document.createElement('button'); button.className = 'bpx-player-ctrl-subtitle';
        button.textContent = '模拟开启播放器字幕'; document.body.append(button); button.click();
      });
      await page.getByRole('tab', { name: '字幕', exact: true }).click();
      await card.locator('.bdc-assistant-subtitle-row').first().waitFor();
      assert.equal(await page.evaluate(() => qa.calls.filter(call => call.action === 'SAVE_CURRENT_VIDEO_PRIMARY_TEXT_SELECTION').length), 0);
      assert.equal(await page.evaluate(() => qa.calls.filter(call => /ASK_|GENERATE_/.test(call.action) || call.action === 'SUBTITLE_CORRECTION' && call.params.mode === 'step').length), 0);
      const original = await card.locator('.bdc-assistant-subtitle-row .bdc-assistant-subtitle-line-text').first().textContent();
      await page.getByRole('checkbox', { name: 'AI 纠错', exact: true }).check();
      await page.getByRole('button', { name: '重试未完成部分', exact: true }).click();
      await card.getByText('AI 优化版，仅作阅读辅助。', { exact: true }).waitFor();
      assert.ok((await card.locator('.bdc-assistant-subtitle-row .bdc-assistant-subtitle-line-text').first().textContent()).startsWith('优化后的文字'));
      await page.getByRole('radio', { name: '原文', exact: true }).click();
      assert.equal(await card.locator('.bdc-assistant-subtitle-row .bdc-assistant-subtitle-line-text').first().textContent(), original);
      await page.getByRole('radio', { name: 'AI 优化', exact: true }).click();
      for (const [width, height] of [[1440, 1000], [390, 760]]) {
        await page.setViewportSize({ width, height });
        await page.waitForFunction(() => { const box = document.querySelector('#bdc-current-video-assistant').getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth + 1; });
        assert.equal(await card.evaluate(el => el.scrollWidth > el.clientWidth), false);
        await page.screenshot({ path: path.join(out, name + '-' + width + '.png') });
      }
      await page.evaluate(() => { qa.hold = true; window.__assistantMockReplaceSubtitleSource('new'); document.querySelector('.bpx-player-ctrl-subtitle').click(); });
      await page.getByRole('button', { name: '停止', exact: true }).waitFor();
      await page.getByRole('checkbox', { name: 'AI 纠错', exact: true }).uncheck();
      assert.equal(await page.getByRole('button', { name: '停止', exact: true }).count(), 0);
      assert.equal(await card.getByText('优化后的文字', { exact: true }).count(), 0);
      await page.evaluate(() => { qa.hold = false; qa.deferEvidence = true; document.querySelector('.bpx-player-ctrl-subtitle').click(); });
      await page.waitForFunction(() => !!qa.releaseEvidence);
      await page.evaluate(async () => { await window.__assistantMockSwitchToPart(2); qa.releaseEvidence(); });
      await page.waitForFunction(() => qa.calls.some(call => call.action === 'SUBTITLE_CORRECTION' && call.params.mode === 'read' && call.params.selectedSourceIdentityKey.includes(':3303:2:')));
      await card.getByText('P2 / 2', { exact: true }).waitFor();
      const input = page.getByRole('textbox', { name: '聊天输入', exact: true });
      await input.fill('中文组合输入');
      await input.dispatchEvent('compositionstart');
      await input.evaluate(el => { window.qa.composingElement = el; });
      await page.evaluate(() => chrome.storage.local.set({ subtitleCorrectionEnabled: true }));
      await page.waitForFunction(() => qa.calls.some(call => call.action === 'SUBTITLE_CORRECTION' && call.params.mode === 'step' && call.params.selectedSourceIdentityKey.includes(':3303:2:')));
      assert.equal(await input.evaluate(el => el === window.qa.composingElement), true);
      await input.dispatchEvent('compositionend');
      assert.equal(await input.inputValue(), '中文组合输入');
      assert.equal(errors.length, 0, errors.join('\n'));
      report.browsers.push({ name, version: browser.version(), status: 'pass', checks: ['late acquisition without second selection', 'no unrequested summary/chat/correction', 'partial correction retry', 'original/optimized switch', 'revoke during request', 'late response fenced across parts', 'IME composition survives background updates', '1440/390 layout'] });
    } finally { await browser.close(); }
  }
  report.status = 'pass';
} catch (error) { report.status = 'fail'; report.error = String(error); throw error; }
finally { await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(path.join(out, 'report.json')); }
