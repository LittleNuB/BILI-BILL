import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const out = path.join(root, 'release-artifacts', 'ux014-real', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(out, { recursive: true });
const temporaryProfile = path.join(out, 'temporary-browser');
const { chromium } = await import(pathToFileURL(process.env.UX014_PLAYWRIGHT_MODULE).href);
const { expect } = await import(pathToFileURL(path.join(path.dirname(process.env.UX014_PLAYWRIGHT_MODULE), 'test.mjs')).href);
const bundle = await readFile(path.join(root, 'dist/content/player-monitor.js'));
const report = {
  scope: 'anonymous_real_host_ui_only',
  bundleSha256: createHash('sha256').update(bundle).digest('hex'),
  cases: [],
  blockedAiRequests: 0,
  blockedSubtitleRequests: 0,
  blockedExtensionWriteRequests: 0,
  readsPersonalBrowserState: false,
  temporaryProfileRemoved: false,
  guardScope: 'fetch in extension worker and page main world; not a network-wide audit',
  guardCountsComplete: true,
};
let context;
let page;
let stage = 'launch';
let worker;
let pageCountsCollected = true;

async function collectPageCounts() {
  if (pageCountsCollected) return;
  const counts = await page.evaluate(() => globalThis.__ux014GuardCounts).catch(() => null);
  if (!counts) report.guardCountsComplete = false;
  else {
    report.blockedAiRequests += counts.ai;
    report.blockedSubtitleRequests += counts.subtitle;
  }
  pageCountsCollected = true;
}

function installFetchGuard(blockWrites) {
  const original = globalThis.fetch.bind(globalThis);
  globalThis.__ux014GuardCounts = { ai: 0, subtitle: 0, writes: 0 };
  globalThis.fetch = (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, globalThis.location.href);
    const counts = globalThis.__ux014GuardCounts;
    if (/(^|\.)(openai|deepseek)\.com$/.test(url.hostname) || /\/(chat\/completions|responses)$/.test(url.pathname)) counts.ai++;
    else if (/subtitle/i.test(url.hostname + url.pathname)
      || (url.hostname.endsWith('.hdslb.com') && url.pathname.endsWith('.json'))) counts.subtitle++;
    else if (blockWrites && !['GET', 'HEAD', 'OPTIONS'].includes((options?.method ?? input.method ?? 'GET').toUpperCase())) counts.writes++;
    else return original(input, options);
    return Promise.reject(new TypeError('UI smoke request blocked'));
  };
}

async function geometry() {
  const card = page.locator('#bdc-current-video-assistant');
  const box = await card.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1
    && box.y + box.height <= viewport.height + 1, 'assistant must stay inside the viewport');
  assert.equal(await card.evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
  return box;
}

try {
  context = await chromium.launchPersistentContext(temporaryProfile, {
    executablePath: process.env.UX014_BROWSER_EXECUTABLE,
    headless: true,
    viewport: { width: 1440, height: 900 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${path.join(root, 'dist')}`, `--load-extension=${path.join(root, 'dist')}`],
  });
  stage = 'extension-ready';
  worker = context.serviceWorkers().find(worker => /chrome-extension:\/\/[^/]+\/background\.js$/.test(worker.url()))
    ?? await context.waitForEvent('serviceworker', { timeout: 15000 });
  const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
  assert.equal(manifest.name, 'Bili-Bill');
  assert.ok(manifest.content_scripts.some(script => script.js.includes('content/player-monitor.js')));
  report.extensionLoaded = true;
  await worker.evaluate(installFetchGuard, true);
  report.browserVersion = await worker.evaluate(() => navigator.userAgent.match(/(?:Edg|Chrome)\/[\d.]+/g));
  report.browserVersionExact = context.browser()?.version();
  page = await context.newPage();
  await page.addInitScript(installFetchGuard, false);
  page.setDefaultTimeout(15000);

  for (const [width, height, url] of [
    [1440, 900, 'https://www.bilibili.com/video/BV1uVLX6uEYC/'],
    [1280, 720, 'https://www.bilibili.com/video/BV1NCgVzoEG9/?p=2'],
  ]) {
    await page.setViewportSize({ width, height });
    stage = 'public-page';
    pageCountsCollected = false;
    const response = await page.goto(url, { waitUntil: 'commit', timeout: 30000 });
    report.lastPageStatus = response.status();
    assert.equal(response.status(), 200, `public video page unavailable: HTTP ${response.status()}`);
    stage = 'assistant-ready';
    const card = page.locator('#bdc-current-video-assistant');
    await card.getByRole('button', { name: '展开助手', exact: true }).waitFor({ timeout: 30000 });
    await page.locator('video').first().evaluate(video => video.pause());
    const empty = await geometry();
    assert.equal(await card.locator('.bdc-assistant-compact-summary').count(), 0);
    const playerBefore = await page.locator('#bilibili-player').boundingBox();
    await page.screenshot({ path: path.join(out, `${width}-collapsed.png`) });
    stage = 'expanded';
    await card.getByRole('button', { name: '展开助手', exact: true }).click();
    await card.getByRole('tab', { name: '摘要', exact: true }).waitFor();
    const expanded = await geometry();
    const playerAfter = await page.locator('#bilibili-player').boundingBox();
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(playerAfter[key] - playerBefore[key]) <= 1, 'overlay must not move the host player');
    assert.equal(await card.locator('.bdc-assistant-source-details').evaluate(el => el.open), false);
    await page.screenshot({ path: path.join(out, `${width}-expanded.png`) });
    await card.getByRole('tab', { name: '问答', exact: true }).click();
    const draft = card.getByRole('textbox', { name: '向当前视频提问', exact: true });
    if (await draft.isEnabled()) await draft.fill('仅用于界面检查，不提交');
    const draftBefore = await draft.inputValue();
    stage = 'collapse';
    await card.getByRole('button', { name: '收起', exact: true }).click();
    await expect(card.getByRole('button', { name: '展开助手', exact: true })).toBeFocused();
    await card.getByRole('button', { name: '展开助手', exact: true }).click();
    await expect(card.getByRole('tab', { name: '问答', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(draft).toHaveValue(draftBefore);

    stage = 'fullscreen';
    const playbackBefore = await page.locator('video').first().evaluate(video => video.currentTime);
    // The probe invokes the native Fullscreen API on the actual player. It
    // does not claim to test every Bilibili toolbar or third-party skin.
    await page.locator('#bilibili-player').evaluate(player => {
      const button = document.createElement('button');
      button.id = 'ux014-fullscreen-probe';
      button.textContent = '全屏兼容检查';
      button.style.cssText = 'position:absolute;top:10px;left:10px;z-index:2147483647';
      button.onclick = () => document.fullscreenElement ? void document.exitFullscreen() : void player.requestFullscreen();
      player.append(button);
    });
    await page.locator('#ux014-fullscreen-probe').click();
    await page.waitForFunction(() => document.fullscreenElement === document.querySelector('#bilibili-player'));
    assert.equal(await card.evaluate(el => {
      const box = el.getBoundingClientRect();
      return document.fullscreenElement.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    }), true, 'native fullscreen must cover the assistant');
    await page.screenshot({ path: path.join(out, `${width}-fullscreen.png`) });
    await page.locator('#ux014-fullscreen-probe').click();
    await page.waitForFunction(() => !document.fullscreenElement);
    await page.locator('#ux014-fullscreen-probe').evaluate(el => el.remove());
    await expect(card.getByRole('tab', { name: '问答', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(draft).toHaveValue(draftBefore);
    assert.ok(Math.abs(await page.locator('video').first().evaluate(video => video.currentTime) - playbackBefore) < 0.1, 'fullscreen must not seek');
    await geometry();
    await page.screenshot({ path: path.join(out, `${width}-restored.png`) });
    await collectPageCounts();
    report.cases.push({ viewport: { width, height }, url, empty, expanded, noPlayerLayoutShift: true, nativeFullscreenOcclusion: true, tabRestored: true, draftEditable: await draft.isEnabled(), draftRestored: true, noSeek: true });
  }
  report.status = 'pass';
} catch (error) {
  report.status = 'incomplete';
  report.failureStage = stage;
  report.failureKind = error.code ?? error.name;
  report.reason = error.message.split('\n')[0].replaceAll(root, '<workspace>');
  process.exitCode = 1;
  if (page) report.assistantDiagnostics = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#bdc-current-video-assistant')];
    return cards.map(card => ({ panels: card.querySelectorAll('.bdc-assistant-panel').length,
      collapseButtons: [...card.querySelectorAll('button[aria-label="收起"]')].map(button => {
        const box = button.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return { box: box.toJSON(), hit: button.contains(hit), coveringTag: hit?.tagName,
          disabled: button.disabled };
      }) }));
  }).catch(() => null);
  if (page) await page.screenshot({ path: path.join(out, 'incomplete.png'), timeout: 5000 }).catch(() => {});
} finally {
  await collectPageCounts();
  const workerGuard = await worker?.evaluate(() => globalThis.__ux014GuardCounts).catch(() => null);
  if (!workerGuard) report.guardCountsComplete = false;
  else {
    report.blockedAiRequests += workerGuard.ai;
    report.blockedSubtitleRequests += workerGuard.subtitle;
    report.blockedExtensionWriteRequests += workerGuard.writes;
  }
  if (report.status === 'pass' && (!report.guardCountsComplete || report.blockedAiRequests > 0)) {
    report.status = 'incomplete';
    report.reason = 'Request guard evidence is incomplete or an AI request was attempted';
    process.exitCode = 1;
  }
  await context?.close();
  const actual = await realpath(temporaryProfile).catch(() => null);
  if (actual) {
    assert.equal(actual, temporaryProfile);
    assert.equal(path.dirname(actual), await realpath(out));
    assert.ok(path.relative(root, actual).startsWith(`release-artifacts${path.sep}ux014-real${path.sep}`));
    await rm(actual, { recursive: true, maxRetries: 5, retryDelay: 250 });
  }
  report.temporaryProfileRemoved = true;
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ out, ...report }, null, 2));
}
