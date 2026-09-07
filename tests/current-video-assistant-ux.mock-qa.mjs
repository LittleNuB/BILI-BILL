import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'release-artifacts', 'ux014', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(out, { recursive: true });
const { chromium } = await import(pathToFileURL(process.env.UX014_PLAYWRIGHT_MODULE).href);
const { expect } = await import(pathToFileURL(path.join(path.dirname(process.env.UX014_PLAYWRIGHT_MODULE), 'test.mjs')).href);
const html = await readFile(path.join(root, 'tests/current-video-assistant-shell.mock.html'));
const bundle = await readFile(path.join(root, 'dist/content/player-monitor.js'));
const browser = await chromium.launch({ executablePath: process.env.UX014_CHROME_EXECUTABLE, headless: true });
const report = { syntheticOnly: true, bundleSha256: createHash('sha256').update(bundle).digest('hex'), cases: [] };
const errors = [];
const shortViewports = [[844, 390, 'light'], [390, 480, 'dark']];
const viewports = process.env.UX014_SHORT_VIEWPORTS_ONLY === '1'
  ? shortViewports
  : [[1440, 900, 'light'], [1280, 720, 'dark'], [390, 844, 'light'], ...shortViewports];
const base = 'https://www.bilibili.com/video/BV1ShellMock9';
async function load(page, query = '') {
  await page.goto(base + query);
  await page.getByRole('button', { name: '展开助手', exact: true }).waitFor();
}
async function expand(page) {
  await page.getByRole('button', { name: '展开助手', exact: true }).click();
  await page.getByRole('tab', { name: '摘要', exact: true }).waitFor();
}
async function theme(page, value) {
  await page.evaluate((mode) => {
    document.documentElement.dataset.theme = mode;
    document.documentElement.style.background = mode === 'dark' ? '#18191c' : '#f6f7f8';
    document.querySelector('main').style.background = mode === 'dark' ? '#18191c' : '#f6f7f8';
  }, value);
  await expect(page.locator('#bdc-current-video-assistant')).toHaveAttribute('data-theme', value);
}
async function geometry(page) {
  const card = page.locator('#bdc-current-video-assistant');
  const box = await card.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1);
  const overflow = await card.evaluate((element) => element.scrollWidth > element.clientWidth + 1);
  assert.equal(overflow, false, 'assistant horizontal overflow');
  const surface = await card.locator(':scope > div').first().evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, border: style.borderTopWidth, shadow: style.boxShadow };
  });
  assert.notEqual(surface.background, 'rgba(0, 0, 0, 0)', 'floating panel needs an opaque surface');
  assert.equal(surface.border, '1px');
  assert.notEqual(surface.shadow, 'none');
  return box;
}
async function reachable(page, locator) {
  const hiddenScroller = await locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (parent.scrollHeight <= parent.clientHeight + 1) continue;
      if (['auto', 'scroll'].includes(style.overflowY)) return null;
      const bounds = parent.getBoundingClientRect();
      if (['hidden', 'clip'].includes(style.overflowY)
        && (box.top < bounds.top || box.bottom > bounds.bottom + 1)) return parent.className;
    }
    return null;
  });
  assert.equal(hiddenScroller, null, 'control must be reachable without scrolling a hidden overflow region');
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  const card = await page.locator('#bdc-current-video-assistant').boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0, 'control must have a visible box');
  assert.ok(box.x >= card.x && box.y >= card.y && box.x + box.width <= card.x + card.width + 1
    && box.y + box.height <= card.y + card.height + 1, 'control must remain inside the assistant');
  assert.equal(await locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  }), true, 'control must not be clipped or covered');
}
async function hostCompatibility(page) {
  const card = page.locator('#bdc-current-video-assistant');
  const draft = page.getByRole('textbox', { name: '向当前视频提问', exact: true });
  const originalPosition = await page.evaluate(() => window.__assistantMockPlaybackPosition());
  await page.evaluate(() => {
    const player = document.querySelector('.player');
    const button = document.createElement('button');
    button.id = 'host-fullscreen-toggle';
    button.textContent = '全屏切换测试';
    button.addEventListener('click', () => {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void player.requestFullscreen();
    });
    player.prepend(button);
  });
  await page.locator('#host-fullscreen-toggle').click();
  await page.waitForFunction(() => document.fullscreenElement === document.querySelector('.player'));
  assert.equal(await page.evaluate(() => {
    const card = document.querySelector('#bdc-current-video-assistant');
    const box = card.getBoundingClientRect();
    return document.fullscreenElement.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  }), true, 'assistant must not paint over native player fullscreen');
  await page.screenshot({ path: path.join(out, '1440-native-fullscreen.png') });
  await page.locator('#host-fullscreen-toggle').click();
  await page.waitForFunction(() => document.fullscreenElement === null);
  await expect(page.getByRole('tab', { name: '问答', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(draft).toHaveValue('保留这段未提交的草稿');
  await reachable(page, draft);
  assert.equal(await page.evaluate(() => window.__assistantMockPlaybackPosition()), originalPosition);
  await geometry(page);
  for (const [token, expected] of [['#18191c', 'dark'], ['#ffffff', 'light']]) {
    await page.evaluate((value) => {
      delete document.documentElement.dataset.theme;
      document.documentElement.style.setProperty('--bg1', value);
    }, token);
    await expect(card).toHaveAttribute('data-theme', expected);
  }
  await page.evaluate(() => {
    document.documentElement.style.removeProperty('--bg1');
    document.querySelector('#host-fullscreen-toggle').remove();
  });
  await theme(page, 'light');
  await page.screenshot({ path: path.join(out, '1440-fullscreen-restored.png') });
  return { syntheticHost: true, nativeFullscreenOcclusion: true, draftAndTabRestored: true, noSeek: true, hostTokenTheme: true };
}
async function pendingPanelRegression(page) {
  await load(page);
  await expand(page);
  await page.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.__ux014PendingReads = [];
    chrome.runtime.sendMessage = (message) => {
      if (['GET_CURRENT_VIDEO_QA_SESSIONS', 'GET_CURRENT_VIDEO_SUBTITLE_VIEW_SOURCES'].includes(message.action)) {
        return new Promise(resolve => window.__ux014PendingReads.push(() => resolve(send(message))));
      }
      return send(message);
    };
    window.__ux014ReleaseReads = () => {
      chrome.runtime.sendMessage = send;
      window.__ux014PendingReads.splice(0).forEach(release => release());
    };
  });
  for (const name of ['问答', '字幕']) {
    await page.getByRole('tab', { name, exact: true }).click();
    assert.equal(await page.locator('#bdc-current-video-assistant > .bdc-assistant-panel').count(), 1,
      `${name}: a pending read must not append a second panel`);
    await geometry(page);
  }
  await page.evaluate(() => window.__ux014ReleaseReads());
  await expect(page.locator('#bdc-current-video-assistant > .bdc-assistant-panel')).toHaveCount(1);
  return { delayedQaAndSubtitleReads: true, singlePanelWhilePending: true };
}
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== 'https://www.bilibili.com') return route.abort();
    if (url.pathname.startsWith('/video/')) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
    if (url.pathname === '/dist/content/player-monitor.js') return route.fulfill({ contentType: 'application/javascript', body: bundle });
    return route.abort();
  });
  report.pendingPanelRegression = await pendingPanelRegression(page);
  for (const [width, height, mode] of viewports) {
    const prefix = height <= 520 ? `${width}x${height}-${mode}` : `${width}-${mode}`;
    await page.setViewportSize({ width, height });
    await load(page);
    await theme(page, mode);
    const card = page.locator('#bdc-current-video-assistant');
    assert.equal(await card.locator('.bdc-assistant-compact-summary').count(), 0);
    assert.equal(await card.getByText(/尚无摘要|生成|正在|先确认/).count(), 0);
    await page.screenshot({ path: path.join(out, `${prefix}-empty.png`) });
    const empty = await geometry(page);
    await load(page, '?subtitleCached=1&cachedSummary=1&savedSource=current');
    await theme(page, mode);
    // The fixture only exposes its cached subtitle identity after explicit
    // detection; do not invent a current-source binding to populate the card.
    await expand(page);
    assert.equal(await card.locator('.bdc-assistant-source-details').evaluate((element) => element.open), false, 'source details closed on first expansion');
    await card.locator('.bdc-assistant-source-details > summary').click();
    await reachable(page, page.getByRole('button', { name: '重新检测字幕', exact: true }));
    await page.getByRole('button', { name: '重新检测字幕', exact: true }).click();
    await card.locator('.bdc-assistant-summary-text').first().waitFor();
    assert.equal(await card.locator('.bdc-assistant-source-details').evaluate((element) => element.open), true, 'refresh must preserve explicitly opened source details');
    await page.getByRole('button', { name: '收起', exact: true }).click();
    await card.locator('.bdc-assistant-compact-summary').waitFor();
    assert.equal(await card.locator('.bdc-assistant-compact-summary').evaluate((element) => getComputedStyle(element).webkitLineClamp), '3');
    await page.screenshot({ path: path.join(out, `${prefix}-compact.png`) });
    const compact = await geometry(page);
    await expand(page);
    const source = card.locator('.bdc-assistant-source-details');
    if (await source.evaluate((element) => element.open)) await source.locator('summary').click();
    assert.equal(await source.evaluate((element) => element.open), false);
    await expect(source.locator('summary')).toContainText('B站字幕');
    const expanded = await geometry(page);
    const tabs = await page.getByRole('tablist').boundingBox();
    assert.ok(tabs.y - expanded.y < 150, 'primary tabs delayed by auxiliary content');
    await page.screenshot({ path: path.join(out, `${prefix}-expanded.png`) });
    const generationInfo = card.locator('.bdc-assistant-generation-details');
    assert.equal(await generationInfo.evaluate((element) => element.open), false);
    await generationInfo.locator('summary').click();
    await expect(generationInfo).toContainText('等待时间和费用由你配置的 AI 服务决定');
    await expect(generationInfo.locator('.bdc-assistant-subtitle-detail').first()).toBeVisible();
    await generationInfo.locator('summary').click();
    await theme(page, mode === 'light' ? 'dark' : 'light');
    await theme(page, mode);
    await page.getByRole('tab', { name: '问答', exact: true }).click();
    await page.getByRole('textbox', { name: '向当前视频提问', exact: true }).fill('保留这段未提交的草稿');
    await page.getByRole('button', { name: '收起', exact: true }).click();
    await expect(page.getByRole('button', { name: '展开助手', exact: true })).toBeFocused();
    await page.getByRole('button', { name: '展开助手', exact: true }).click();
    await expect(page.getByRole('tab', { name: '问答', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('textbox', { name: '向当前视频提问', exact: true })).toHaveValue('保留这段未提交的草稿');
    if (width === 1440) report.hostCompatibility = await hostCompatibility(page);
    await reachable(page, page.getByRole('textbox', { name: '向当前视频提问', exact: true }));
    await page.screenshot({ path: path.join(out, `${prefix}-qa.png`) });
    await expect(card.getByText('提问会发送当前分 P 的完整正文。', { exact: true })).toBeVisible();
    await source.locator('summary').click();
    await expect(page.getByRole('button', { name: '重新检测字幕', exact: true })).toBeVisible();
    await reachable(page, page.getByRole('button', { name: '重新检测字幕', exact: true }));
    await source.locator('summary').click();
    await page.getByRole('tab', { name: '字幕', exact: true }).click();
    await expect(page.getByLabel('搜索当前字幕来源')).toBeVisible();
    await reachable(page, page.getByLabel('搜索当前字幕来源'));
    await page.screenshot({ path: path.join(out, `${prefix}-subtitles.png`) });
    const playbackPosition = await page.evaluate(() => window.__assistantMockPlaybackPosition());
    const lastSubtitle = card.locator('.bdc-assistant-subtitle-row').last();
    await reachable(page, lastSubtitle);
    await lastSubtitle.click();
    assert.equal(await page.evaluate(() => window.__assistantMockPlaybackPosition()), playbackPosition, 'preview must not seek');
    const confirmJump = card.getByRole('button', { name: '确认跳转', exact: true });
    await reachable(page, confirmJump);
    if (height <= 520) await page.screenshot({ path: path.join(out, `${prefix}-jump-preview.png`) });
    await confirmJump.click();
    const returnPosition = card.getByRole('button', { name: '返回原位置', exact: true });
    await reachable(page, returnPosition);
    await returnPosition.click();
    assert.equal(await page.evaluate(() => window.__assistantMockPlaybackPosition()), playbackPosition);
    await reachable(page, card.getByRole('button', { name: '导出 TXT', exact: true }));
    await page.getByRole('tab', { name: '亮点', exact: true }).click();
    await page.screenshot({ path: path.join(out, `${prefix}-highlights.png`) });
    await page.getByRole('tab', { name: '摘要', exact: true }).click();
    await page.getByRole('button', { name: '收起', exact: true }).click();
    await page.evaluate(() => window.__assistantMockSwitchToPart(2));
    await expect(card.locator('.bdc-assistant-part')).toContainText('P2');
    await expect(card.locator('.bdc-assistant-compact-summary')).toHaveCount(0);
    const aiActions = await page.evaluate(() => window.__assistantMockMessages.filter((message) => ['GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS', 'ASK_CURRENT_VIDEO_FULL_TEXT'].includes(message.action)));
    assert.equal(aiActions.length, 0, 'layout interaction must not trigger AI');
    report.cases.push({ width, height, mode, empty, compact, expanded, tabsOffset: tabs.y - expanded.y, noImplicitAI: true, draftPreserved: true, staleSummaryHidden: true, subtitleJumpReturnReachable: true });
  }
  assert.deepEqual(errors, []);
  report.status = 'pass';
} catch (error) {
  report.status = 'fail'; report.error = error.stack; process.exitCode = 1;
} finally {
  await browser.close();
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ out, ...report }, null, 2));
}
