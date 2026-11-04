import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createReport, inheritHistory } from '../src/dev/acceptance/contract.ts';

const root = await fs.realpath(process.cwd()), extension = await fs.realpath(process.argv[2]), bookFile = await fs.realpath(process.argv[3]);
for (const target of [extension, bookFile]) assert.ok(target.startsWith(root + path.sep));
const book = JSON.parse(await fs.readFile(bookFile, 'utf8')), plan = JSON.parse(await fs.readFile(path.join(extension, '../plan.json'), 'utf8'));
assert.ok(plan.retainedUnknown?.length);
const out = path.join(root, 'release-artifacts', `acceptance-retry-${Date.now()}`); await fs.mkdir(out);
const { chromium } = await import(pathToFileURL(process.env.UX014_PLAYWRIGHT_MODULE).href), results = [];
try {
  for (const [name, executablePath] of [['Chrome', process.env.UX014_CHROME_EXECUTABLE], ['Edge', process.env.UX014_EDGE_EXECUTABLE]]) {
    for (const scenario of ['complete', 'missing', 'changed-unknown', 'changed-prior']) {
      const profile = await fs.mkdtemp(path.join(out, `${name}-${scenario}-isolated-`));
      const launch = () => chromium.launchPersistentContext(profile, { executablePath, headless: true, viewport: { width: 1280, height: 1100 },
        ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging', '--proxy-server=http://127.0.0.1:9'] });
      const open = async context => {
        context.setDefaultTimeout(10000); await context.route(/^https?:\/\//, route => route.abort());
        const cdp = await context.browser().newBrowserCDPSession(); const { id } = await cdp.send('Extensions.loadUnpacked', { path: extension }); await cdp.detach();
        const page = await context.newPage();
        for (let attempt = 0; ; attempt++) {
          try { await page.goto(`chrome-extension://${id}/acceptance/index.html`); break; }
          catch (error) { if (attempt >= 40 || !String(error).includes('ERR_BLOCKED_BY_CLIENT')) throw error; await new Promise(r => setTimeout(r, 100)); }
        }
        await page.waitForFunction(() => document.querySelector('#build')?.textContent);
        const worker = context.serviceWorkers().find(w => w.url().includes(id)); return { id, page, worker };
      };
      let context = await launch();
      try {
        const { worker } = await open(context);
        if (scenario !== 'missing') {
          const seeded = structuredClone(book);
          if (scenario === 'changed-unknown') seeded.reports.at(-1).rows[0].tokenReservation += 1000;
          if (scenario === 'changed-prior') {
            const fresh = await createReport(plan); inheritHistory(fresh, seeded.reports);
            fresh.priorCharges[0].measured -= 1; seeded.reports.push(fresh);
          }
          await worker.evaluate(async history => chrome.storage.local.set({ developerAcceptanceV1: history }), seeded);
        }
      } finally { await context.close(); }
      context = await launch();
      try {
        const { id, page, worker } = await open(context);
        if (scenario === 'complete') {
          await page.getByText('已读取记录。尚未授权本次会话。', { exact: true }).waitFor();
          const state = JSON.parse(await page.locator('#results').innerText());
          assert.equal(state.budget.measured, 207949); assert.equal(state.budget.unknown, 1); assert.equal(state.budget.reserved, 100000); assert.equal(state.budget.newCalls, 0);
          assert.equal(await page.locator('#retry-consent').isVisible(), true);
          await page.locator('#consent').check(); await page.locator('#legacy').check(); assert.equal(await page.locator('#approve').isEnabled(), false);
          await page.locator('#retry').check(); assert.equal(await page.locator('#approve').isEnabled(), true);
          await page.evaluate(() => document.getElementById('approve').click());
          assert.equal(await page.locator('#pairing').innerText(), '');
          const stored = await worker.evaluate(async () => (await chrome.storage.local.get('developerAcceptanceV1')).developerAcceptanceV1);
          assert.deepEqual(stored.reports.slice(0, book.reports.length), book.reports); assert.equal(stored.ledgerId, book.ledgerId);
          await page.setViewportSize({ width: 420, height: 960 });
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
          await page.screenshot({ path: path.join(out, `${name}-retry-ready.png`), fullPage: true });
          await page.reload(); await page.getByText('已读取记录。尚未授权本次会话。', { exact: true }).waitFor();
          assert.equal(await page.locator('#retry').isChecked(), false); assert.equal(await page.locator('#approve').isEnabled(), false);
          assert.equal(JSON.parse(await page.locator('#results').innerText()).budget.reserved, 100000);
        } else {
          await page.waitForFunction(() => document.querySelector('#results')?.textContent.includes('storedPlans'));
          assert.equal(await page.locator('#approve').isEnabled(), false); assert.equal(await page.locator('#recovery').isVisible(), false);
        }
        results.push({ name, scenario, id, status: 'pass', modelCalls: 0 });
      } finally { await context.close(); }
    }
  }
} finally { await fs.writeFile(path.join(out, 'report.json'), JSON.stringify({ networkBlocked: true, personalBrowserStateRead: false, modelCalls: 0, results }, null, 2)); }
console.log(JSON.stringify({ out, results }));
