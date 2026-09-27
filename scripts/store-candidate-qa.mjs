import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, writeFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = process.cwd();
const codec = await build({ entryPoints: [path.join(root, 'src/shared/video-wiki-backup.ts')],
  bundle: true, write: false, format: 'esm', platform: 'node' });
const { encodeWikiBackup, decodeWikiBackup } = await import(`data:text/javascript;base64,${Buffer.from(codec.outputFiles[0].text).toString('base64')}`);
const out = path.join(root, 'release-artifacts', `store-candidate-${Date.now()}`);
await mkdir(out, { recursive: true });
const profile = await mkdtemp(path.join(root, 'release-artifacts/qa-'));
const { chromium } = await import(pathToFileURL(process.env.UX014_PLAYWRIGHT_MODULE).href);
const sha = value => createHash('sha256').update(value).digest('hex');
const report = { sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  workingTreeDirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
  syntheticData: true, productionExtension: true, storeSubmission: false,
  status: 'running', checks: [], screenshots: [], errors: [] };
const stamp = Date.UTC(2026, 8, 27, 9);
const assets = [
  ['BV1234567890', '演示资料：从需求到稳定交付', '先定义验收标准', '实现之前写下可观察的结果：谁在什么场景完成什么动作。', ['产品实践']],
  ['BV1234567890', '演示资料：从需求到稳定交付', '保留关键路径', '先完成提问、保存、找回和回看，再补充次要能力。', ['产品实践']],
  ['BV0987654321', '演示资料：如何回顾学习笔记', '让笔记可以找回', '记录自己的理解，并保留视频来源。定期回顾相关视频，核对适用条件。', ['学习方法']],
].map(([bvid, title, heading, note, tags], i) => ({ id: String(i + 1).repeat(64), kind: 'note',
  video: { bvid, title }, part: { cid: String(i + 1), page: 1 },
  personal: { title: heading, note, tags }, snapshot: null, bookmarkMs: null, importedFrom: null,
  createdAt: stamp + i, updatedAt: stamp + i }));
const wiki = { key: 'state', revision: 1,
  pages: [...new Set(assets.map(a => a.video.bvid))].map(bvid => ({ bvid, createdAt: stamp, deleted: false })),
  topics: [{ id: 'demo-product', name: '产品实践', term: null, manualName: true }],
  relations: [{ topicId: 'demo-product', bvid: 'BV1234567890', mode: 'include' }] };
const fixture = await encodeWikiBackup(assets, wiki, new AbortController().signal);
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.UX014_BROWSER_EXECUTABLE, headless: true,
    viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging', '--proxy-server=http://127.0.0.1:9'],
  });
  await context.route(/^https?:\/\//, route => route.abort());
  const cdp = await context.browser().newBrowserCDPSession();
  report.browser = await cdp.send('Browser.getVersion');
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: path.join(root, 'dist') });
  await cdp.detach();
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => report.errors.push(error.message));
  const base = `chrome-extension://${id}`;
  await page.goto(base + '/dashboard/index.html#learning-notes');
  await page.locator('details').filter({ has: page.locator('input[type=file]') }).locator('summary').click();
  await page.locator('input[type=file]').setInputFiles({ name: 'demo-learning.json', mimeType: 'application/json', buffer: Buffer.from(fixture) });
  await page.getByRole('region', { name: '恢复预览' }).waitFor();
  // A reload destroys the preflight worker; it must not commit the staged import.
  page.on('dialog', dialog => dialog.accept());
  await page.reload();
  const beforeRestore = await page.evaluate(() => chrome.runtime.sendMessage({ action: 'LEARNING_LIST', params: {} }));
  assert.equal(beforeRestore.success, true); assert.equal(beforeRestore.data.total, 0);
  assert.equal(await page.getByRole('region', { name: '恢复预览' }).count(), 0);
  report.checks.push('reload after preflight leaves zero assets and discards confirmation');
  await page.locator('details').filter({ has: page.locator('input[type=file]') }).locator('summary').click();
  await page.locator('input[type=file]').setInputFiles({ name: 'demo-learning.json', mimeType: 'application/json', buffer: Buffer.from(fixture) });
  await page.getByRole('region', { name: '恢复预览' }).waitFor();
  await page.getByRole('button', { name: '确认恢复', exact: true }).click();
  await page.getByText('已恢复，新增 3 条', { exact: true }).waitFor();
  report.checks.push('production backup preflight and restore from synthetic fixture');
  const details = page.locator('details').filter({ has: page.locator('input[type=file]') });
  if (await details.getAttribute('open') !== null) await details.locator('summary').click();
  await page.getByText('先定义验收标准', { exact: true }).waitFor();
  async function capture(name) {
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(out, name) }); report.screenshots.push(name);
  }
  await capture('01-learning-demo-1280x800.png');
  await page.goto(base + '/dashboard/index.html#video-wiki');
  await page.getByRole('heading', { name: '视频 Wiki', exact: true }).waitFor();
  await page.locator('.wiki-page-row').filter({ hasText: '演示资料：从需求到稳定交付' }).click();
  await page.getByText('先定义验收标准', { exact: true }).waitFor();
  await capture('02-wiki-demo-1280x800.png');
  await page.reload();
  await page.locator('.wiki-page-row').filter({ hasText: '演示资料：从需求到稳定交付' }).waitFor();
  report.checks.push('restored Wiki pages persist after reload');
  await page.goto(base + '/dashboard/index.html#learning-notes');
  await page.getByText('先定义验收标准', { exact: true }).waitFor();
  await page.locator('details').filter({ has: page.locator('input[type=file]') }).locator('summary').click();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: /导出.*备份/ }).click();
  const download = await downloadEvent;
  const stream = await download.createReadStream(); const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const exported = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert.equal(exported.format, 'bili-bill-learning-wiki');
  const decoded = await decodeWikiBackup(new Blob(chunks), new AbortController().signal);
  assert.deepEqual(decoded.assets, assets);
  assert.equal(decoded.wiki.pages.length, 2);
  assert.deepEqual(decoded.wiki.topics, wiki.topics);
  assert.deepEqual(decoded.wiki.relations, wiki.relations);
  report.checks.push('real UI backup export preserves exact assets and manual Wiki organization');
  const promo = await context.newPage(); await promo.setViewportSize({ width: 440, height: 280 });
  const logo = (await readFile(path.join(root, 'dist/icons/icon128.png'))).toString('base64');
  await promo.setContent(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;background:#fff;font-family:"Microsoft YaHei",sans-serif;color:#18191c;padding:32px;border-top:6px solid #fb7299;width:440px;height:280px}header{display:flex;align-items:center;gap:14px;font-size:30px;font-weight:700}img{width:48px;height:48px}h1{font-size:24px;line-height:1.6;margin:22px 0 12px}p{color:#61666d;font-size:15px;margin:0}footer{margin-top:20px;color:#00a1d6;font-size:13px}</style><header><img src="data:image/png;base64,${logo}" alt="">Bili-Bill</header><h1>把看过的视频<br>变成找得到的学习资料</h1><p>视频提问 · 学习笔记 · 视频 Wiki</p><footer>本地整理，保留出处</footer></html>`);
  await promo.screenshot({ path: path.join(out, 'promo-440x280.png') });
  report.screenshots.push('promo-440x280.png');
  assert.deepEqual(report.errors, []);
  report.files = {};
  for (const file of report.screenshots) report.files[file] = sha(await readFile(path.join(out, file)));
  report.distSha256 = {};
  for (const file of await readdir(path.join(root, 'dist'), { recursive: true, withFileTypes: true })) {
    if (file.isFile()) {
      const absolute = path.join(file.parentPath, file.name);
      report.distSha256[path.relative(path.join(root, 'dist'), absolute).replaceAll('\\', '/')] = sha(await readFile(absolute));
    }
  }
  report.status = 'pass';
} catch (error) { report.status = 'fail'; report.error = error.stack; process.exitCode = 1; }
finally {
  await context?.close();
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out, status: report.status, checks: report.checks, error: report.error }));
}
