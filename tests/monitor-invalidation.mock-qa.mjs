import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const out = path.join(root, 'release-artifacts', `monitor-invalidation-${Date.now()}`);
await mkdir(out);
const html = await readFile('tests/current-video-assistant-shell.mock.html', 'utf8');
const bundle = await readFile(process.argv[2] ?? 'dist/content/player-monitor.js');
const { chromium } = await import(pathToFileURL(process.env.UX014_PLAYWRIGHT_MODULE).href);
const results = [];
try {
  for (const [name, executablePath] of [['Chrome', process.env.UX014_CHROME_EXECUTABLE], ['Edge', process.env.UX014_EDGE_EXECUTABLE]]) {
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const page = await browser.newPage(), errors = [], logs = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => logs.push(message.text()));
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.pathname.startsWith('/video/')) return route.fulfill({ contentType: 'text/html', body: html });
        if (url.pathname === '/dist/content/player-monitor.js') return route.fulfill({ contentType: 'text/javascript', body: bundle });
        return route.abort();
      });
      await page.goto('https://www.bilibili.com/video/BV1ShellMock9');
      await page.locator('#bdc-current-video-assistant').waitFor();
      await page.waitForFunction(() => window.__assistantMockPlaybackPosition !== undefined);
      // Execute the real event callback while simulating the synchronous browser
      // exception that an obsolete content context produces after an update.
      await page.evaluate(() => {
        chrome.runtime.sendMessage = () => { throw new Error('Extension context invalidated.'); };
        const video = document.querySelector('video');
        video.dispatchEvent(new Event('play'));
        video.dispatchEvent(new Event('pause'));
      });
      await page.waitForTimeout(5500); // Cross the actual five-second heartbeat.
      results.push({ name, errors, stopped: logs.includes('[BiliViz] Heartbeat stopped') });
      assert.deepEqual(errors, []);
      assert.equal(results.at(-1).stopped, true);
    } finally { await browser.close(); }
  }
} finally {
  await writeFile(path.join(out, 'report.json'), JSON.stringify({ syntheticOnly: true, realModelCalls: 0, personalBrowserStateRead: false, results }, null, 2));
}
console.log(JSON.stringify({ out, results }));
