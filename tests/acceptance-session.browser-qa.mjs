import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = process.cwd(), out = path.join(root, 'release-artifacts', `acceptance-session-offline-${Date.now()}`);
await mkdir(out, { recursive: true });
const extension = path.join(out, 'synthetic-extension'); await mkdir(path.join(extension, 'acceptance'), { recursive: true });
const plan = { version: 1, id: 'offline-session-v1', targets: [{ id: 'one', bvid: 'BV1Eval00001', page: 1 }],
  outputTokens: 2048, steps: [{ id: 'chat', target: 'one', feature: 'chat', question: '合成问题' }] };
const fixtureBuild = { sourceCommit: 'offline-fixture', buildHash: 'offline-fixture' };
const stub = `
import { createReport, STORAGE } from './src/dev/acceptance/contract.ts';
const originalNow = Date.now.bind(Date); globalThis.qa = { now: originalNow(), messages: [], responses: {}, host: null, providerRequests: 0 };
Date.now = () => qa.now;
globalThis.fetch = () => { qa.providerRequests++; throw Error('OFFLINE_FETCH_FORBIDDEN'); };
const event = () => { const listeners = []; return { addListener: fn => listeners.push(fn), fire: message => listeners.forEach(fn => fn(message)) }; };
chrome.runtime.connectNative = () => {
  const port = { onMessage: event(), onDisconnect: event(), disconnected: false,
    disconnect() { if (!this.disconnected) { this.disconnected = true; this.onDisconnect.fire(); } },
    postMessage(message) {
      qa.messages.push(message);
      if (message.hello === 1) { qa.hello = message; queueMicrotask(() => this.onMessage.fire({ ready: true, renewalVersion: 1 })); }
      else if (message.checkpoint === 1) queueMicrotask(() => this.onMessage.fire({ checkpointAck: message.id }));
      else { qa.responses[message.id]?.(message); delete qa.responses[message.id]; }
    }
  }; qa.host = port; return port;
};
qa.request = (action, params = {}) => new Promise(resolve => {
  const id = crypto.randomUUID(); qa.responses[id] = resolve; qa.host.onMessage.fire({ id, action, ...params });
});
qa.bootstrap = async () => {
const stored = await chrome.storage.local.get(STORAGE);
if (!stored[STORAGE]) {
  const report = await createReport(${JSON.stringify(plan)});
  report.pause = 'ACCEPTANCE_USAGE_UNKNOWN';
  report.rows.push({ id: 'chat', target: 'one', feature: 'chat', state: 'failed', attempted: true, tokenReservation: 100000,
    startedAt: new Date(qa.now).toISOString(), model: 'synthetic', materialHash: 'a'.repeat(64), build: ${JSON.stringify(fixtureBuild)},
    messages: [], inputHash: 'b'.repeat(64), text: '', parameters: {}, error: 'CHAT_NETWORK' });
  await chrome.storage.local.set({ [STORAGE]: { version: 1, ledgerId: crypto.randomUUID(), reports: [report] },
    userConfig: { ai: { baseURL: 'https://offline.invalid/v1', apiKey: 'synthetic-not-a-key', chatModel: 'synthetic' } } });
}
};
import './src/dev/acceptance/worker.ts';
`;
await build({ stdin: { contents: stub, resolveDir: root }, bundle: true, format: 'esm', platform: 'browser',
  outfile: path.join(extension, 'worker.js'), define: { __ACCEPTANCE_BUILD__: JSON.stringify(fixtureBuild),
    __ACCEPTANCE_PLAN__: JSON.stringify(plan), __ACCEPTANCE_RECOVERY__: 'null' } });
await build({ entryPoints: ['src/dev/acceptance/page.ts'], bundle: true, format: 'esm', platform: 'browser', outfile: path.join(extension, 'acceptance/page.js') });
await writeFile(path.join(extension, 'acceptance/index.html'), await readFile('src/dev/acceptance/index.html'));
await writeFile(path.join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Bili-Bill isolated offline fixture',
  version: '0.0.1', permissions: ['storage', 'nativeMessaging'], background: { service_worker: 'worker.js', type: 'module' } }));
const { chromium } = await import(pathToFileURL(process.env.UX014_PLAYWRIGHT_MODULE).href);
const report = { kind: 'installed_extension_offline_with_mock_native_host', networkBlocked: true, realModelCalls: 0,
  nativeHostInstalled: false, personalBrowserStateRead: false, realSiteUi: false, browsers: [] };
try {
  for (const [name, executablePath] of [['Chrome', process.env.UX014_CHROME_EXECUTABLE], ['Edge', process.env.UX014_EDGE_EXECUTABLE]]) {
    // Chromium's LevelDB paths exceed Windows limits in deeply nested worktrees.
    const profile = await mkdtemp(path.join(tmpdir(), `bb-acceptance-${name}-`)), checks = [], errors = [];
    const launch = () => chromium.launchPersistentContext(profile, { executablePath, headless: true,
      viewport: { width: 1280, height: 1100 }, ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging', '--proxy-server=http://127.0.0.1:9'] });
    let context = await launch();
    const open = async () => {
      await context.route(/^https?:\/\//, route => route.abort()); context.setDefaultTimeout(10000);
      const cdp = await context.browser().newBrowserCDPSession(); const { id } = await cdp.send('Extensions.loadUnpacked', { path: extension }); await cdp.detach();
      const worker = context.serviceWorkers().find(w => w.url().includes(id)) ?? await context.waitForEvent('serviceworker');
      await worker.evaluate(() => qa.bootstrap());
      const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
      await page.goto(`chrome-extension://${id}/acceptance/index.html`);
      try { await page.waitForFunction(() => document.querySelector('#budget').textContent.includes('100,000')); }
      catch (error) { await writeFile(path.join(out, name + '-diagnostic.json'), JSON.stringify({ errors, text: await page.locator('main').innerText() })); throw error; }
      return { page, id, worker };
    };
    try {
      let { page, id, worker } = await open();
      const before = await worker.evaluate(async () => (await chrome.storage.local.get('developerAcceptanceV1')).developerAcceptanceV1);
      assert.equal(await page.locator('#approve').isDisabled(), true);
      await page.locator('#consent').check(); await page.locator('#legacy').check();
      await page.evaluate(() => document.getElementById('approve').click());
      assert.equal(await page.locator('#pairing').innerText(), ''); checks.push('untrusted scripted click cannot approve');
      await page.locator('#approve').click(); await page.getByText(/同一计划可在任务时限内自动续接/).waitFor();
      const first = await worker.evaluate(() => qa.hello);
      await page.reload(); await page.getByText(/同一计划可在任务时限内自动续接/).waitFor();
      assert.ok((await page.locator('#pairing').innerText()).includes(first.code)); checks.push('reload retains task and pairing code');
      await page.close();
      const renewed = await worker.evaluate(async () => { qa.now += 31 * 60000; return qa.request('renew', { planHash: qa.hello.planHash }); });
      assert.equal(renewed.result.autoRenew, true); assert.equal(renewed.result.taskExpiresAt, first.taskExpiresAt);
      assert.ok(Date.parse(renewed.result.expiresAt) > Date.parse(first.expiresAt));
      assert.deepEqual(await worker.evaluate(async () => (await chrome.storage.local.get('developerAcceptanceV1')).developerAcceptanceV1), before);
      assert.equal(await worker.evaluate(() => qa.providerRequests), 0); checks.push('closed page renews expired lease without altering unknown charge, pause or history');
      const foreign = await worker.evaluate(() => qa.request('renew', { planHash: 'c'.repeat(64) })); assert.equal(foreign.error, 'ACCEPTANCE_REVOKED');
      page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); await page.goto(`chrome-extension://${id}/acceptance/index.html`);
      await page.getByText(/同一计划可在任务时限内自动续接/).waitFor(); assert.equal(await page.locator('#approve').isDisabled(), true);
      await page.locator('#revoke').click(); await page.getByText('已读取记录。尚未授权本次会话。', { exact: true }).waitFor();
      assert.equal(await worker.evaluate(() => qa.host.disconnected), true); checks.push('foreign plan and explicit revoke cannot renew');
      await page.locator('#task').uncheck(); await page.locator('#consent').check(); await page.locator('#legacy').check();
      await page.locator('#approve').click(); await page.getByText(/关闭授权页或撤销会停止/).waitFor(); await page.close();
      assert.equal(await worker.evaluate(() => qa.host.disconnected), true); checks.push('short session still revokes on page close');
      page = await context.newPage(); await page.goto(`chrome-extension://${id}/acceptance/index.html`);
      await page.getByText('已读取记录。尚未授权本次会话。', { exact: true }).waitFor();
      await page.locator('#consent').check(); await page.locator('#legacy').check(); await page.locator('#approve').click();
      await page.getByText(/同一计划可在任务时限内自动续接/).waitFor();
      await worker.evaluate(async () => chrome.storage.local.set({ learningChatStreaming: false }));
      await page.getByText('已读取记录。尚未授权本次会话。', { exact: true }).waitFor(); checks.push('configuration change revokes without modifying ledger');
      await page.locator('#approve').click(); await page.getByText(/同一计划可在任务时限内自动续接/).waitFor();
      await worker.evaluate(() => qa.host.disconnect());
      await page.getByText(/本地主机未连接或已断开/).waitFor(); checks.push('native host disconnect stops authorization');
      await page.setViewportSize({ width: 420, height: 960 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.screenshot({ path: path.join(out, `${name}-task.png`), fullPage: true });
      assert.deepEqual(errors, []); await context.close();
      context = await launch(); ({ page, worker } = await open());
      await page.getByText('已读取记录。尚未授权本次会话。', { exact: true }).waitFor();
      assert.deepEqual(await worker.evaluate(async () => (await chrome.storage.local.get('developerAcceptanceV1')).developerAcceptanceV1), before);
      checks.push('browser restart retains history but cannot resurrect task permission');
      report.browsers.push({ name, status: 'pass', checks, realModelCalls: 0 });
    } finally { await context.close(); }
  }
  report.status = 'pass';
} catch (error) { report.status = 'fail'; report.error = String(error); throw error; }
finally { await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(path.join(out, 'report.json')); }
