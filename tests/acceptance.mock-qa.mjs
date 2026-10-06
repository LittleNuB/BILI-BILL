import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, realpath, cp } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = await realpath(process.cwd()), original = await realpath(process.argv[2]);
assert.ok(original.startsWith(root + path.sep));
const out = path.join(root, 'release-artifacts', `acceptance-mock-${Date.now()}`), extension = path.join(out, 'extension');
await mkdir(out); await cp(original, extension, { recursive: true });
const plan = { version: 1, id: 'offline-mock-v1', targets: [{ id: 'one', bvid: 'BV1Eval00001', page: 1 }], outputTokens: 16384,
  steps: [{ id: 'overview', target: 'one', feature: 'overview' }, { id: 'chat', target: 'one', feature: 'chat', question: '解释视频' },
    { id: 'followup', target: 'one', feature: 'chat', question: '继续解释', after: 'chat' },
    { id: 'subtitles', target: 'one', feature: 'subtitles', subtitleBatch: 0 }, { id: 'image', target: 'one', feature: 'image', question: '解释画面' },
    { id: 'cancel', target: 'one', feature: 'chat', question: '停止测试' }] };
const imageData = 'data:image/png;base64,' + (await readFile('tests/fixtures/prompt-eval/images/chart.png')).toString('base64');
const fixture = { version: 1, target: plan.targets[0], cid: 111, title: '合成视频', capturedAt: '2026-10-06T00:00:00Z', build: { sourceCommit: 'mock', buildHash: 'mock' },
  source: 'bilibili_subtitle', sourceType: 'bilibili_player_v2', language: 'zh-CN', evidence: 'mock',
  lines: [{ lineNo: 1, startSeconds: 0, endSeconds: 3, text: '先写入缓存，再失效。' }, { lineNo: 2, startSeconds: 3, endSeconds: 6, text: '这是合成材料。' }] };
await build({ entryPoints: ['src/dev/acceptance/worker.ts'], outfile: path.join(extension, 'acceptance-worker.js'), bundle: true, minify: true, platform: 'browser', format: 'esm', target: 'es2022',
  define: { __ACCEPTANCE_BUILD__: JSON.stringify(fixture.build), __ACCEPTANCE_PLAN__: JSON.stringify(plan) },
  plugins: [{ name: 'test-only-capture', setup(builder) { builder.onLoad({ filter: /[\\/]acceptance[\\/]capture\.ts$/ }, () => ({ loader: 'ts', contents:
    `import { digest } from ${JSON.stringify(path.join(root, 'src/dev/acceptance/contract.ts'))};
     export async function captureTarget() { const body = ${JSON.stringify(fixture)};
     const data = ${JSON.stringify(imageData)}; body.frame = { data, timeMs: 4000, capturedAt: Date.now(), sha256: await digest(data) };
     return { ...body, hash: await digest(JSON.stringify(body)) }; }` })); } }] });
const { chromium } = await import(pathToFileURL(process.env.UX014_PLAYWRIGHT_MODULE).href);
const report = { kind: 'mock_material_model_native_bridge_in_installed_extension', networkBlocked: true, realModel: false, realSiteUi: false, browsers: [] };
try {
  for (const [name, executablePath] of [['Chrome', process.env.UX014_CHROME_EXECUTABLE], ['Edge', process.env.UX014_EDGE_EXECUTABLE]]) {
    const profile = await mkdtemp(path.join(out, `${name}-isolated-`));
    const context = await chromium.launchPersistentContext(profile, { executablePath, headless: true, viewport: { width: 1280, height: 900 },
      ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging', '--proxy-server=http://127.0.0.1:9'] });
    try {
      await context.route(/^https?:\/\//, route => route.abort()); context.setDefaultTimeout(10000);
      const cdp = await context.browser().newBrowserCDPSession(), { id } = await cdp.send('Extensions.loadUnpacked', { path: extension }); await cdp.detach();
      const worker = context.serviceWorkers().find(w => w.url().includes(id)) ?? await context.waitForEvent('serviceworker');
      await worker.evaluate(async () => {
        const qa = globalThis.qa = { calls: [], charges: [], pending: new Map(), messages: [], disconnects: [], hello: null, stall: false };
        chrome.runtime.connectNative = () => {
          const messages = [], disconnects = [];
          qa.messages = messages;
          return { onMessage: { addListener: fn => messages.push(fn) }, onDisconnect: { addListener: fn => disconnects.push(fn) },
            disconnect: () => disconnects.forEach(fn => fn()),
            postMessage: message => {
              if (message.hello) { qa.hello = message; queueMicrotask(() => messages.forEach(fn => fn({ ready: true }))); }
              else if (message.checkpoint) { qa.charges = message.charges; queueMicrotask(() => messages.forEach(fn => fn({ checkpointAck: message.id }))); }
              else { const done = qa.pending.get(message.id); qa.pending.delete(message.id); done?.(message); }
            } };
        };
        qa.command = (action, input = {}) => new Promise(resolve => {
          const id = crypto.randomUUID(); qa.pending.set(id, resolve); qa.messages.forEach(fn => fn({ ...input, id, action }));
        });
        globalThis.fetch = async (url, options) => {
          if (url !== 'https://api.example.com/v1/chat/completions') throw Error('offline');
          if (!qa.charges.some(c => c.running)) throw Error('reservation missing');
          const body = JSON.parse(options.body); qa.calls.push(body);
          if (qa.stall) return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true }));
          let text = '视频内容：合成回答，仅为程序测试。';
          if (body.response_format) text = JSON.stringify({ summarySentences: [{ text: '先写入再失效。', evidenceLineNumbers: [1] }], keyPoints: [{ text: '注意操作顺序。', evidenceLineNumbers: [1] }], highlights: [{ title: '合成示例', description: '演示测试材料的边界。', evidenceLineNumbers: [2] }] });
          else if (body.max_tokens === 6000) text = JSON.stringify({ lines: JSON.parse(body.messages.at(-1).content) });
          return new Response(JSON.stringify({ model: 'offline-provider', choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }), { headers: { 'content-type': 'application/json' } });
        };
        await chrome.storage.local.set({ userConfig: { ai: { baseURL: 'https://api.example.com/v1', apiKey: 'synthetic-test-only', chatModel: 'offline-text' } },
          learningVisionModel: { enabled: true, model: 'offline-image' }, learningChatStreaming: false });
      });
      const page = await context.newPage(); await page.goto(`chrome-extension://${id}/acceptance/index.html`);
      await page.getByText('已读取记录。尚未授权本次会话。', { exact: true }).waitFor();
      await page.locator('#consent').check(); await page.locator('#legacy').check(); await page.getByRole('button', { name: '批准本计划并连接（30分钟）' }).click();
      await page.waitForFunction(() => document.getElementById('pairing').textContent.includes('配对码'));
      const command = (action, params = {}) => worker.evaluate(async ({ action, params }) => qa.command(action, params), { action, params });
      assert.ok((await command('capture', { target: 'one' })).result.materials[0].hash);
      for (const step of plan.steps.slice(0, 5)) { const result = await command('run', { step: step.id }); assert.ok(!result.error, JSON.stringify(result)); }
      await command('run', { step: 'chat' });
      const calls = await worker.evaluate(() => qa.calls);
      assert.equal(calls.length, 5); assert.ok(calls[2].messages.some(m => m.role === 'assistant'));
      assert.equal(calls[3].max_tokens, 6000); assert.equal(calls[4].model, 'offline-image'); assert.equal(calls[4].messages.at(-1).content[1].type, 'image_url');
      const state = (await command('status')).result; assert.equal(state.budget.measured, 58568); assert.equal(state.budget.newCalls, 5);
      const second = await context.newPage(); await second.goto(page.url()); await second.waitForFunction(() => document.getElementById('budget').textContent.includes('58,568')); await second.close();
      assert.equal((await command('status')).result.budget.newCalls, 5);
      await worker.evaluate(() => { qa.stall = true; });
      const pending = command('run', { step: 'cancel' }); await page.waitForFunction(() => document.getElementById('results').textContent.includes('"state": "running"'));
      await command('stop'); const cancelled = await pending; assert.equal(cancelled.result.rows.at(-1).state, 'cancelled'); assert.equal(cancelled.result.budget.reserved, 100000);
      const stored = await worker.evaluate(async () => (await chrome.storage.local.get('developerAcceptanceV1')).developerAcceptanceV1.reports[0]);
      assert.equal(stored.rows[0].checks.format, true); assert.equal(stored.rows[3].checks.format, true); assert.equal(stored.pause, 'ACCEPTANCE_USAGE_UNKNOWN');
      assert.ok(!JSON.stringify(stored).includes('synthetic-test-only')); assert.equal(stored.evidence.realModel, false);
      await writeFile(path.join(out, `${name}-report.json`), JSON.stringify(stored, null, 2));
      await page.screenshot({ path: path.join(out, `${name}-completed.png`), fullPage: true });
      await page.reload(); await page.getByText('已读取记录。尚未授权本次会话。', { exact: true }).waitFor();
      assert.match(await page.locator('#budget').innerText(), /100,000/);
      report.browsers.push({ name, status: 'pass', mockRequests: calls.length + 1, realRequests: 0, reservedUnknown: 100000 });
    } finally { await context.close(); }
  }
} finally { await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); }
console.log(JSON.stringify({ output: out, ...report }));
