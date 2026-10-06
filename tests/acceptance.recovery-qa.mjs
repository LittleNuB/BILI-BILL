import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = await fs.realpath(process.cwd()), extension = await fs.realpath(process.argv[2]);
assert.ok(extension.startsWith(root + path.sep));
const out = path.join(root, `release-artifacts/acceptance-recovery-${Date.now()}`);
await fs.mkdir(out);
const backup = JSON.parse(await fs.readFile(path.join(extension, 'acceptance/recovery.json'), 'utf8'));
const plan = JSON.parse(await fs.readFile(path.join(extension, '../plan.json'), 'utf8'));
const expected = 58493 + backup.reports[0].rows.reduce((sum, row) => sum + row.observation.usage.totalTokens, 0);
const { chromium } = await import(pathToFileURL(process.env.UX014_PLAYWRIGHT_MODULE).href);
const results = [];
try {
  for (const [name, executablePath] of [['Chrome', process.env.UX014_CHROME_EXECUTABLE], ['Edge', process.env.UX014_EDGE_EXECUTABLE]]) {
    const profile = await fs.mkdtemp(path.join(out, `${name}-isolated-`));
    const context = await chromium.launchPersistentContext(profile, { executablePath, headless: true, viewport: { width: 1280, height: 960 },
      ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging', '--proxy-server=http://127.0.0.1:9'] });
    try {
      await context.route(/^https?:\/\//, r => r.abort());
      const cdp = await context.browser().newBrowserCDPSession();
      const { id } = await cdp.send('Extensions.loadUnpacked', { path: extension });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`chrome-extension://${id}/acceptance/index.html`);
      await page.locator('#recover').waitFor();
      assert.match(await page.locator('#plan').innerText(), new RegExp(plan.id));
      const worker = context.serviceWorkers().find(w => w.url().includes(id));
      assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().options_ui.page), 'acceptance/index.html');
      await page.evaluate(() => document.getElementById('recover').click());
      assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('developerAcceptanceV1')).developerAcceptanceV1), undefined);
      await page.getByRole('button', { name: '恢复已核对的首轮备份', exact: true }).click();
      await page.getByText('已读取记录。尚未授权本次会话。', { exact: true }).waitFor();
      const state = JSON.parse(await page.locator('#results').innerText());
      assert.equal(state.planId, plan.id); assert.equal(state.budget.measured, expected);
      assert.equal(state.budget.newCalls, 0); assert.equal(state.budget.unknown, 0);
      assert.equal(state.materials.length, 2);
      for (const material of state.materials) assert.equal(material.hash, backup.reports[0].materials[material.target.id].hash);
      const stored = await worker.evaluate(async () => (await chrome.storage.local.get('developerAcceptanceV1')).developerAcceptanceV1);
      assert.equal(stored.ledgerId, backup.ledgerId); assert.deepEqual(stored.reports[0], backup.reports[0]);
      assert.equal(await page.locator('#recovery').isVisible(), false);
      assert.equal(await page.locator('#pairing').innerText(), '');
      await page.setViewportSize({ width: 420, height: 860 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.screenshot({ path: path.join(out, `${name}-restored.png`), fullPage: true });
      await page.reload();
      await page.getByText('已读取记录。尚未授权本次会话。', { exact: true }).waitFor();
      assert.equal(JSON.parse(await page.locator('#results').innerText()).budget.measured, expected);
      assert.equal(await page.locator('#recovery').isVisible(), false);
      assert.deepEqual(errors, []);
      results.push({ name, id, status: 'pass', measured: expected, oldReportPreserved: true, newCalls: 0 });
    } finally { await context.close(); }
  }
} finally {
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify({ networkBlocked: true, personalBrowserStateRead: false, modelCalls: 0, results }, null, 2));
}
console.log(JSON.stringify({ out, results }));
