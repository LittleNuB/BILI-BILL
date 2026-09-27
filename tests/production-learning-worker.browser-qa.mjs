import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { workerHeapSampler } from '../scripts/lg0/worker-heap-sampler.mjs';

const root = process.cwd();
const out = path.join(root, 'release-artifacts', `production-worker-${Date.now()}`);
await mkdir(out, { recursive: true });
const codec = await build({ stdin: { contents: `export { encodeWikiBackup } from './src/shared/video-wiki-backup.ts'; export { learningBytes } from './src/shared/learning.ts';`, resolveDir: root }, bundle: true, write: false, platform: 'node', format: 'esm' });
const { encodeWikiBackup, learningBytes } = await import(`data:text/javascript;base64,${Buffer.from(codec.outputFiles[0].text).toString('base64')}`);
const workerFile = (await readdir(path.join(root, 'dist/assets'))).filter(n => /^learning-worker-.*\.js$/.test(n));
assert.equal(workerFile.length, 1);
const production = await readFile(path.join(root, 'dist/assets', workerFile[0]));
const sha = data => createHash('sha256').update(data).digest('hex');
const report = { status: 'running', formalGateStatus: 'not_evaluated', syntheticOnly: true,
  productionBundleSha256: sha(production), workerFile: `assets/${workerFile[0]}`,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  workingTreeDirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
  harnessSha256: sha(await readFile(new URL(import.meta.url))),
  note: 'Production bundle unchanged. Controlled IDB keepalive only for termination test. Isolated loopback origin, not extension service-worker lifecycle or physical disk exhaustion.',
  performance: [], errors: [] };
const note = n => ({ id: n.toString(16).padStart(64, '0'), kind: 'note',
  video: { bvid: 'BV1234567890', title: 'Synthetic' }, part: null,
  personal: { title: 'Synthetic', note: 'Saved', tags: [] }, snapshot: null, bookmarkMs: null,
  importedFrom: null, createdAt: 1, updatedAt: 1 });
const wiki = { key: 'state', revision: 0, pages: [], topics: [], relations: [] };
const backup = rows => encodeWikiBackup(rows, wiki, new AbortController().signal);
// A successful asset put is observed without replacing its result. Repeated native reads
// keep that same transaction open until the real dedicated Worker is terminated.
const controlled = `let hold=false; const original=IDBObjectStore.prototype.put;
IDBObjectStore.prototype.put=function(...args){const request=original.apply(this,args);
if(this.name==='lgAssets'&&!hold){hold=true;const store=this;
request.addEventListener('success',()=>{const tick=()=>{try{const r=store.get('__test_keepalive__');r.onsuccess=tick;}catch{}};tick();postMessage({testWritten:true});});}
return request;}; await import('/worker.js'); postMessage({testReady:true});`;
report.controlledWrapperSha256 = sha(controlled);
const quotaObserver = `const original=IDBDatabase.prototype.transaction;
IDBDatabase.prototype.transaction=function(...args){const tx=original.apply(this,args);
tx.addEventListener('abort',()=>postMessage({testQuotaError:tx.error?.name||'unknown'}));return tx;};
await import('/worker.js'); postMessage({testReady:true});`;
report.quotaObserverSha256 = sha(quotaObserver);
report.codecSha256 = sha(codec.outputFiles[0].text);
const { chromium } = await import(pathToFileURL(process.env.UX014_PLAYWRIGHT_MODULE).href);
const browser = await chromium.launch({ executablePath: process.env.UX014_CHROME_EXECUTABLE, headless: true });
report.browser = browser.version();
let context;
try {
  context = await browser.newContext();
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url === 'http://127.0.0.1/qa') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Isolated production Worker test</title>' });
    if (url === 'http://127.0.0.1/worker.js') return route.fulfill({ contentType: 'text/javascript', body: production });
    if (url === 'http://127.0.0.1/controlled.js') return route.fulfill({ contentType: 'text/javascript', body: controlled });
    if (url === 'http://127.0.0.1/quota.js') return route.fulfill({ contentType: 'text/javascript', body: quotaObserver });
    return route.abort();
  });
  let page, cdp, sampler;
  const open = async () => {
  page = await context.newPage(); page.on('pageerror', e => report.errors.push(e.message));
  cdp = await context.newCDPSession(page);
  sampler = await workerHeapSampler(cdp);
  await page.goto('http://127.0.0.1/qa');
  await page.evaluate(() => {
    window.sequence = 0; window.longtasks = [];
    window.observer = new PerformanceObserver(list => window.longtasks.push(...list.getEntries().map(e => ({ start: e.startTime, duration: e.duration }))));
    window.observer.observe({ type: 'longtask', buffered: true });
    window.launch = async controlled => {
      window.worker?.terminate(); window.pending = new Map(); window.written = false; window.quotaErrors = [];
      const worker = window.worker = new Worker(controlled === 'quota' ? '/quota.js' : controlled ? '/controlled.js' : '/worker.js', { type: 'module' });
      let ready; const initialized = new Promise(resolve => ready = resolve);
      worker.onmessage = ({ data }) => {
        if (data.testReady) { ready(); return; }
        if (data.testQuotaError) { window.quotaErrors.push(data.testQuotaError); return; }
        if (data.testWritten) { window.written = true; return; }
        const pending = window.pending.get(data.id); if (!pending) return;
        if (data.phase) { pending.phases.push({ phase: data.phase, ms: performance.now() - pending.start }); return; }
        clearTimeout(pending.timer); window.pending.delete(data.id);
        pending.resolve({ ...data, elapsedMs: performance.now() - pending.start, phases: pending.phases });
      };
      if (controlled) await initialized;
    };
    window.rpc = (action, params = {}) => new Promise((resolve, reject) => {
      const id = String(++window.sequence);
      const timer = setTimeout(() => { window.pending.delete(id); reject(Error('Worker response timeout: ' + action)); }, 30000);
      window.pending.set(id, { resolve, timer, start: performance.now(), phases: [] });
      window.worker.postMessage({ id, action, ...params });
    });
    window.load = async text => {
      const pre = await window.rpc('preflight', { file: new Blob([text]) });
      if (pre.error) throw Error(pre.error);
      const committed = await window.rpc('restore', { token: pre.result.token });
      if (committed.error) throw Error(committed.error);
      return { preflightMs: pre.elapsedMs, commitMs: committed.elapsedMs, phases: { preflight: pre.phases, restore: committed.phases }, result: committed.result };
    };
    window.digest = async () => {
      const exported = await window.rpc('export'); if (exported.error) throw Error(exported.error);
      const meta = await new Promise((resolve, reject) => {
        const request = indexedDB.open('BiliAnalyticsDB'); request.onerror = () => reject(request.error);
        request.onsuccess = () => { const db = request.result; const tx = db.transaction('lgMeta', 'readonly');
          const row = tx.objectStore('lgMeta').get('state');
          tx.oncomplete = () => { db.close(); resolve(row.result); }; tx.onerror = () => { db.close(); reject(tx.error); }; };
      });
      const bytes = await new Blob([JSON.stringify(meta), exported.result.file]).arrayBuffer();
      return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(n => n.toString(16).padStart(2, '0')).join('');
    };
    window.clear = async () => { const pre = await window.rpc('clearPreview'); if(pre.error)throw Error(pre.error);const done=await window.rpc('clear',{token:pre.result.token});if(done.error)throw Error(done.error); };
    return window.launch(false);
  });
  };
  await open();
  await page.evaluate(text => window.load(text), await backup([note(1)]));
  const before = await page.evaluate(() => window.digest());
  await page.evaluate(() => window.launch(true));
  const incoming = await backup(Array.from({ length: 100 }, (_, i) => note(i + 1)));
  await page.evaluate(async text => {
    const pre = await window.rpc('preflight', { file: new Blob([text]) });
    if (pre.error) throw Error(pre.error);
    window.crashResult = null;
    void window.rpc('restore', { token: pre.result.token }).then(value => window.crashResult = value);
  }, incoming);
  await page.waitForFunction(() => window.written, null, { timeout: 10000 });
  const completedBeforeKill = await page.evaluate(() => {
    const completed = window.crashResult;
    window.worker.terminate();
    for (const p of window.pending.values()) clearTimeout(p.timer);
    window.pending.clear(); return completed;
  });
  assert.equal(completedBeforeKill, null, 'Restore completed before the controlled interruption');
  await page.evaluate(() => window.launch(false));
  const after = await page.evaluate(() => window.digest());
  assert.equal(after, before, 'Partial restored state after Worker termination');
  const recovery = await page.evaluate(text => window.load(text), incoming);
  assert.equal(recovery.result.total, 100);
  const recovered = await page.evaluate(() => window.digest());
  assert.notEqual(recovered, before);
  await page.evaluate(() => window.launch(false));
  assert.equal(await page.evaluate(() => window.digest()), recovered);
  report.interruption = { nativeAssetWriteObserved: true, terminatedBeforeResponse: true, before, after, rollbackExact: true, recoveryPersists: true };
  await page.evaluate(() => window.launch(true));
  const crashInput = await backup(Array.from({ length: 200 }, (_, i) => note(i + 1)));
  await page.evaluate(async text => {
    const pre = await window.rpc('preflight', { file: new Blob([text]) });
    if (pre.error) throw Error(pre.error);
    window.crashResult = null;
    void window.rpc('restore', { token: pre.result.token }).then(value => window.crashResult = value);
  }, crashInput);
  await page.waitForFunction(() => window.written, null, { timeout: 10000 });
  assert.equal(await page.evaluate(() => window.crashResult), null);
  const crashed = page.waitForEvent('crash', { timeout: 15000 });
  void cdp.send('Page.crash').catch(() => {});
  await crashed;
  await page.close();
  await open();
  const afterCrash = await page.evaluate(() => window.digest());
  assert.equal(afterCrash, recovered, 'Renderer crash changed complete saved state');
  report.rendererCrash = { eventObserved: true, nativeAssetWriteObserved: true, before: recovered, after: afterCrash, rollbackExact: true };
  await page.evaluate(() => window.launch('quota'));
  const origin = 'http://127.0.0.1';
  const usage = await cdp.send('Storage.getUsageAndQuota', { origin });
  const quotaSize = Math.ceil(usage.usage) + 1;
  const large = note(101); large.personal.note = 'x'.repeat(2 * 1048576);
  const quotaInput = await backup([large]);
  await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize });
  try {
    // Expire Chromium's cached bucket-space allowance; not operation timing.
    await new Promise(resolve => setTimeout(resolve, 31000));
    const quota = await cdp.send('Storage.getUsageAndQuota', { origin });
    assert.equal(quota.overrideActive, true);
    const rejected = await page.evaluate(async text => {
      const pre = await window.rpc('preflight', { file: new Blob([text]) });
      if (pre.error) throw Error(pre.error);
      return window.rpc('restore', { token: pre.result.token });
    }, quotaInput);
    assert.ok(rejected.error, 'Browser quota must reject the actual restore');
    const errors = await page.evaluate(() => window.quotaErrors);
    assert.ok(errors.includes('QuotaExceededError'), 'Require native quota error, not generic failure');
    const afterQuota = await page.evaluate(() => window.digest());
    assert.equal(afterQuota, recovered);
    report.quota = { method: 'Storage.overrideQuotaForOrigin', cacheExpiryWaitMs: 31000, quotaSize, ...quota, nativeErrors: errors, before: recovered, after: afterQuota, rollbackExact: true };
  } finally { await cdp.send('Storage.overrideQuotaForOrigin', { origin }); }
  await page.evaluate(() => window.launch(false));
  const quotaRecovery = await page.evaluate(text => window.load(text), quotaInput);
  assert.equal(quotaRecovery.result.total, 101);
  const quotaRecovered = await page.evaluate(() => window.digest());
  await page.close(); await open();
  assert.equal(await page.evaluate(() => window.digest()), quotaRecovered);
  report.quota.recoveryPersists = true;
  for (const scenario of ['count-limit', 'byte-limit', 'single-large']) {
    await page.evaluate(() => window.clear());
    const rows = Array.from({ length: scenario === 'single-large' ? 1 : 1000 }, (_, i) => note(i + 1));
    if (scenario !== 'count-limit') {
      const remaining = 10485760 - learningBytes(rows);
      const each = Math.floor(remaining / rows.length);
      for (const row of rows) row.personal.note += 'x'.repeat(each);
      rows[0].personal.note += 'x'.repeat(10485760 - learningBytes(rows));
      assert.equal(learningBytes(rows), 10485760);
    }
    await page.evaluate(text => window.input = new Blob([text]), await backup(rows));
    const measured = await sampler.measure(() => page.evaluate(async () => {
      window.longtasks.length = 0;
      window.observer.takeRecords();
      const started = performance.now();
      const pre = await window.rpc('preflight', { file: window.input }); if(pre.error)throw Error(pre.error);
      const restore = await window.rpc('restore', { token: pre.result.token }); if(restore.error)throw Error(restore.error);
      const ended = performance.now();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      window.longtasks.push(...window.observer.takeRecords().map(e => ({ start: e.startTime, duration: e.duration })));
      return { preflightMs: pre.elapsedMs, commitMs: restore.elapsedMs, total: restore.result.total, phases: { preflight: pre.phases, restore: restore.phases }, longtasks: window.longtasks.filter(t => t.start < ended && t.start + t.duration > started) };
    }));
    assert.equal(measured.result.total, rows.length);
    const memory = measured.memory;
    const quality = memory.maximumSampleGapMs <= 250 && memory.samples.every(s => s.sampleDurationMs <= 250);
    const growthWithinBudget = memory.sampledCombinedHeapGrowthBytes <= 256 * 1048576;
    const workerObserved = memory.samples.some(s => s.workerUsedBytes > 0);
    const mainThreadWithinBudget = measured.result.longtasks.every(t => t.duration <= 200);
    const progress = [0, ...measured.result.phases.preflight.map(p => p.ms), measured.result.preflightMs];
    const maximumPreflightProgressGapMs = Math.max(...progress.slice(1).map((value, i) => value - progress[i]));
    report.performance.push({ scenario, logicalBytes: learningBytes(rows), ...measured,
      sampleQuality: quality && workerObserved ? 'pass' : 'insufficient_evidence', growthWithinBudget,
      mainThreadWithinBudget, maximumPreflightProgressGapMs });
  }
  assert.deepEqual(report.errors, []);
  report.status = report.performance.some(r => !r.growthWithinBudget || !r.mainThreadWithinBudget || r.maximumPreflightProgressGapMs > 2000)
    ? 'fail' : report.performance.every(r => r.sampleQuality === 'pass') ? 'pass' : 'insufficient_evidence';
  if (report.status !== 'pass') process.exitCode = 1;
} catch (error) { report.status = 'fail'; report.error = error.stack; process.exitCode = 1; }
finally { await browser.close(); await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ out, status: report.status, interruption: report.interruption, performance: report.performance.map(r => ({ scenario: r.scenario, preflightMs: r.result.preflightMs, commitMs: r.result.commitMs, growthMiB: r.memory.sampledCombinedHeapGrowthBytes / 1048576, sampleQuality: r.sampleQuality })), error: report.error })); }
