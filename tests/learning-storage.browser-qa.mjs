import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const out = path.join(root, `release-artifacts/storage-281-${Date.now()}`);
await mkdir(out, { recursive: true });
const bundled = await build({ stdin: { contents: `
  import { BiliAnalyticsDB } from './src/background/storage/db.ts';
  import { LearningRepository } from './src/background/storage/learning-repo.ts';
  import { seedLearningV13, V13_STORES } from './tests/fixtures/learning-v13.ts';
  import { legacySnapshot } from './scripts/lg0/legacy-fixture.mjs';
  import { learningBytes, LEARNING_MAX_BYTES } from './src/shared/learning.ts';
  window.qa = { BiliAnalyticsDB, LearningRepository, seedLearningV13, V13_STORES, legacySnapshot, learningBytes, LEARNING_MAX_BYTES };
`, resolveDir: root, loader: 'ts' }, bundle: true, write: false, format: 'iife', platform: 'browser' });
const { chromium } = await import(pathToFileURL(process.env.UX014_PLAYWRIGHT_MODULE).href);
const browser = await chromium.launch({ executablePath: process.env.UX014_CHROME_EXECUTABLE, headless: true });
const report = { syntheticOnly: true, realBrowserIndexedDB: true, productionRepository: true,
  productionWorkerPerformance: 'not_measured', realQuotaExhaustion: 'not_tested',
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  workingTreeDirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
  testSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),
  bundledRepositorySha256: createHash('sha256').update(bundled.outputFiles[0].text).digest('hex'),
  browser: browser.version(), status: 'running', checks: [] };
try {
  const context = await browser.newContext();
  await context.route('**/*', route => {
    if (route.request().url() === 'http://127.0.0.1/qa') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Isolated storage QA</title><script src="/qa.js"></script>' });
    if (route.request().url() === 'http://127.0.0.1/qa.js') return route.fulfill({ contentType: 'text/javascript', body: bundled.outputFiles[0].text });
    return route.abort();
  });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1/qa');
  const result = await page.evaluate(async () => {
    const { BiliAnalyticsDB, LearningRepository, seedLearningV13, V13_STORES, legacySnapshot, learningBytes, LEARNING_MAX_BYTES } = window.qa;
    const check = (value, message) => { if (!value) throw Error(message); };
    const reject = async (job, pattern) => { let caught; try { await job(); } catch (error) { caught = error; }
      check(caught && pattern.test(String(caught)), 'Expected rejection: ' + pattern); };
    const note = n => ({ id: n.toString(16).padStart(64, '0'), kind: 'note', createdAt: 1, updatedAt: 1,
      video: { bvid: 'BV1234567890', title: 'Synthetic' }, part: null,
      personal: { title: 'Synthetic', note: 'Saved', tags: [] }, snapshot: null, bookmarkMs: null, importedFrom: null });
    const checks = [];
    const name = 'lg1-browser-' + crypto.randomUUID();
    const legacy = await seedLearningV13(name);
    const db = new BiliAnalyticsDB(name); const repo = new LearningRepository(db);
    await db.open();
    check(await legacySnapshot(db, Object.keys(V13_STORES)) === legacy.before, 'Legacy data changed');
    check(db.verno === 16 && db.tables.length === 25, 'Schema mismatch');
    checks.push('v13 to v16 preserves all 21 synthetic legacy tables');
    await repo.restore(0, [note(1)]);
    const before = await repo.state();
    const originalPut = db.lgMeta.put;
    db.lgMeta.put = () => Promise.reject(new DOMException('Synthetic quota failure', 'QuotaExceededError'));
    try { await reject(() => repo.restore(0, [note(2), note(3)]), /QuotaExceededError/); }
    finally { db.lgMeta.put = originalPut; }
    check(JSON.stringify(await repo.state()) === JSON.stringify(before), 'Partial restore after injected failure');
    checks.push('injected metadata write failure rolls back asset writes and revision');
    const results = await Promise.allSettled([
      repo.edit(0, note(1).id, note(1), { ...note(1).personal, note: 'First edit' }),
      repo.edit(0, note(1).id, note(1), { ...note(1).personal, note: 'Second edit' }),
    ]);
    check(results.filter(item => item.status === 'fulfilled').length === 1, 'Concurrent edits silently overwrote');
    checks.push('two stale-base editors cannot overwrite each other');
    const stale = await repo.state();
    await repo.clear(0, stale.meta.revision);
    await reject(() => repo.restore(0, [note(2)]), /stale_epoch/);
    check((await repo.state()).assets.length === 0, 'Stale restore resurrected content');
    checks.push('clear fences delayed restore');
    await repo.restore(1, Array.from({ length: 999 }, (_, i) => note(i + 1)));
    const capacity = await Promise.allSettled([1000, 1001].map(n => repo.save(1, note(n), { assertCurrent: async () => {} })));
    check(capacity.filter(item => item.status === 'fulfilled').length === 1, 'Concurrent count admission');
    check((await repo.state()).assets.length === 1000, 'Count exceeded 1000');
    checks.push('concurrent final-slot admission respects 1000-asset cap');
    let state = await repo.state(); await repo.clear(1, state.meta.revision);
    const exact = note(1); exact.personal.note = '';
    exact.personal.note = 'x'.repeat(LEARNING_MAX_BYTES - learningBytes([exact]));
    check(learningBytes([exact]) === LEARNING_MAX_BYTES, 'Byte fixture mismatch');
    await repo.restore(2, [exact]);
    await reject(() => repo.edit(2, exact.id, exact, { ...exact.personal, note: exact.personal.note + 'x' }), /capacity_bytes/);
    check((await repo.state()).assets[0].personal.note.length === exact.personal.note.length, 'Over-capacity edit changed content');
    checks.push('exact 10 MiB accepted; one-byte excess rejected without mutation');
    const expected = await repo.state();
    const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))))).map(n => n.toString(16).padStart(2, '0')).join('');
    const expectedDigest = await digest(expected);
    db.close();
    return { name, expectedDigest, legacyBefore: legacy.before, checks };
  });
  await page.reload();
  const reopened = await page.evaluate(async ({ name, expectedDigest, legacyBefore }) => {
    const { BiliAnalyticsDB, LearningRepository, legacySnapshot, V13_STORES } = window.qa;
    const db = new BiliAnalyticsDB(name);
    try {
      const state = await new LearningRepository(db).state();
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(state))))).map(n => n.toString(16).padStart(2, '0')).join('');
      return digest === expectedDigest && await legacySnapshot(db, Object.keys(V13_STORES)) === legacyBefore;
    } finally { await db.delete(); }
  }, result);
  assert.equal(reopened, true);
  report.checks = [...result.checks, 'page reload preserves exact near-capacity state and legacy tables'];
  report.status = 'pass';
} catch (error) { report.status = 'fail'; report.error = error.stack; process.exitCode = 1; }
finally { await browser.close(); await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ out, ...report })); }
