import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, writeFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = process.cwd(), git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
for (const key of ['UX014_PLAYWRIGHT_MODULE', 'UX014_CHROME_EXECUTABLE', 'UX014_EDGE_EXECUTABLE']) assert.ok(process.env[key], `Set ${key}.`);
const sha = value => createHash('sha256').update(value).digest('hex');
const out = path.join(root, 'release-artifacts', `store-review-${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${git('rev-parse', '--short', 'HEAD')}`);
await mkdir(out, { recursive: false });
const { chromium } = await import(pathToFileURL(process.env.UX014_PLAYWRIGHT_MODULE).href);
const codec = await build({ stdin: { contents: ['format', 'backup', 'sources'].map(name => `export * from './src/shared/open-knowledge/${name}.ts';`).join('\n'), resolveDir: root }, bundle: true, write: false, format: 'esm', platform: 'node' });
const { createRevision, videoPageId, serializeRevision, textBytes, jsonBytes, createSource, imageAttachment,
  serializeKnowledgeBackup, parseKnowledgeBackup } = await import(`data:text/javascript;base64,${Buffer.from(codec.outputFiles[0].text).toString('base64')}`);
const image = await imageAttachment(new Uint8Array(await readFile(path.join(root, 'tests/fixtures/prompt-eval/images/chart.png'))));
const source = await createSource({ kind: 'subtitles', video: { bvid: 'BV1234567890', cid: '100', page: 1, title: '演示资料：学习记录与回顾' },
  label: '合成字幕示例', language: 'zh-CN', version: 'store-demo-v1', capturedAt: 1791676800000,
  text: '保留出处，记录自己的理解。', segments: [{ fromMs: 1000, toMs: 4000, text: '保留出处，记录自己的理解。' }], derivedFrom: null, legacyAsset: null });
const row = await createRevision({ pageId: videoPageId('BV1234567890'), kind: 'video', bvid: 'BV1234567890',
  title: '演示资料：学习记录与回顾', body: '## 我的学习记录\n\n先记录自己的理解，再回到原始资料核对。\n\n这是一份合成演示资料，不是真实视频内容。',
  aiNotes: '', topics: ['学习方法'], sourceIds: [source.id], attachmentIds: [image.id], legacyIds: [], createdAt: 1791676800000 }, [], 'browser', 1791676800000);
const fixtureFiles = new Map([[`sources/${source.id}.json`, jsonBytes(source)], [`attachments/${image.id}.${image.extension}`, image.bytes], [`pages/${row.pageId}/${row.id}.md`, textBytes(serializeRevision(row))]]);
const fixture = await serializeKnowledgeBackup(fixtureFiles, null);
const report = { sourceCommit: git('rev-parse', 'HEAD'), sourceTree: git('rev-parse', 'HEAD^{tree}'), workingTreeDirty: !!git('status', '--porcelain'),
  scriptSha256: sha(await readFile(new URL(import.meta.url))), kind: 'ordinary_installed_extension_ux_and_store_review',
  syntheticData: true, productionExtension: true, networkBlocked: true, realModelCalls: 0, personalBrowserStateRead: false,
  storeSubmission: false, realSiteAcceptance: 'not_completed', nativeDirectoryPicker: 'not_completed', status: 'running', browsers: [], screenshots: [], files: {} };
const forbidden = /诊断历史尾页|同步诊断|收藏夹缺口诊断|导出诊断摘要|提示词评测|开发验收/;
async function hashes() {
  const result = {};
  for (const file of await readdir(path.join(root, 'dist'), { recursive: true, withFileTypes: true })) if (file.isFile()) {
    const absolute = path.join(file.parentPath, file.name); result[path.relative(path.join(root, 'dist'), absolute).replaceAll('\\', '/')] = sha(await readFile(absolute));
  }
  return result;
}
report.distSha256 = await hashes();
try {
  for (const [name, executablePath] of [['Chrome', process.env.UX014_CHROME_EXECUTABLE], ['Edge', process.env.UX014_EDGE_EXECUTABLE]]) {
    const profile = await mkdtemp(path.join(tmpdir(), `bb-store-${name}-`));
    const context = await chromium.launchPersistentContext(profile, { executablePath, headless: true,
      viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging', '--proxy-server=http://127.0.0.1:9'] });
    const browser = { name, checks: [], errors: [], dialogs: [] }; report.browsers.push(browser);
    try {
      await context.route(/^https?:\/\//, route => route.abort()); context.setDefaultTimeout(10000);
      const cdp = await context.browser().newBrowserCDPSession(); browser.version = await cdp.send('Browser.getVersion');
      const { id } = await cdp.send('Extensions.loadUnpacked', { path: path.join(root, 'dist') }); await cdp.detach();
      const page = await context.newPage(); page.on('pageerror', error => browser.errors.push(error.message));
      page.on('dialog', async dialog => { browser.dialogs.push(dialog.type()); await dialog.accept(); });
      async function capture(label) {
        await page.evaluate(() => document.fonts.ready);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name}: horizontal overflow`);
        const file = `${name}-${label}.png`; await page.screenshot({ path: path.join(out, file) });
        report.screenshots.push({ file, ...page.viewportSize(), syntheticData: true, productionUI: true });
      }
      const base = `chrome-extension://${id}/dashboard/index.html`;
      await page.goto(base + '#video-wiki'); await page.getByRole('heading', { name: '从一条笔记开始' }).waitFor();
      assert.doesNotMatch(await page.locator('body').innerText(), forbidden);
      await page.getByRole('button', { name: '使用帮助', exact: true }).click(); await page.getByRole('dialog').waitFor(); await capture('01-first-use-1280x800');
      await page.keyboard.press('Escape'); assert.equal(await page.getByRole('dialog').count(), 0);
      assert.equal(await page.getByRole('button', { name: '使用帮助', exact: true }).evaluate(node => node === document.activeElement), true);
      browser.checks.push('first-use help opens, Escape closes and restores focus');
      await page.getByRole('button', { name: '新建页面', exact: true }).click();
      await page.getByLabel('页面标题', { exact: true }).fill('我的学习记录（演示）');
      const firstBody = '## 学习目标\n\n把知识写成自己的理解，并保留可以回看的出处。\n\n## 本周计划\n\n- 学习一条视频\n- 记录一个问题\n- 在项目中实践';
      await page.getByLabel('页面正文', { exact: true }).fill(firstBody); await page.getByLabel('页面主题', { exact: true }).fill('学习方法，实践');
      await page.getByRole('button', { name: '保存', exact: true }).click(); await page.getByText('已保存到此浏览器。', { exact: true }).waitFor();
      await page.getByRole('button', { name: '关闭提示', exact: true }).click(); await capture('02-knowledge-1280x800');
      await page.reload(); await page.locator('.knowledge-card').filter({ hasText: '我的学习记录（演示）' }).click();
      await page.getByRole('button', { name: '编辑', exact: true }).click();
      await page.getByLabel('页面正文', { exact: true }).fill(firstBody + '\n\n未完成草稿：补充实践条件。');
      await page.getByRole('button', { name: '关闭编辑', exact: true }).click(); await page.getByRole('button', { name: '关闭页面', exact: true }).click();
      await page.locator('.knowledge-card').filter({ hasText: '我的学习记录（演示）' }).click(); assert.match(await page.getByLabel('页面正文', { exact: true }).inputValue(), /未完成草稿/);
      await page.getByLabel('页面正文', { exact: true }).fill(firstBody + '\n\n更新：实践时记录适用条件。');
      await page.getByRole('button', { name: '保存', exact: true }).click(); await page.getByRole('button', { name: '编辑', exact: true }).waitFor();
      browser.checks.push('Chinese page saves without optional setup; reload and closed editor retain draft');
      await page.getByRole('button', { name: '版本历史', exact: true }).click(); await page.locator('.knowledge-history-row').nth(1).click();
      assert.equal(await page.locator('.knowledge-diff section').nth(1).locator('pre').first().innerText(), firstBody); await capture('03-history-1280x800');
      await page.getByRole('button', { name: '恢复为新版本', exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'hidden' });
      assert.doesNotMatch(await page.getByRole('region', { name: '页面详情' }).innerText(), /更新：实践时/); browser.checks.push('history preview restores prior content as a new revision');
      await page.getByLabel('搜索知识库', { exact: true }).fill('没有这个页面'); await page.getByRole('heading', { name: '没有匹配的页面' }).waitFor();
      await page.getByLabel('搜索知识库', { exact: true }).fill(''); await page.locator('.knowledge-card').filter({ hasText: '我的学习记录（演示）' }).waitFor(); browser.checks.push('empty search recovers when cleared');
      await page.getByRole('button', { name: '知识库备份与恢复', exact: true }).click();
      await page.getByLabel('选择知识库备份文件', { exact: true }).setInputFiles({ name: 'synthetic-knowledge.json', mimeType: 'application/json', buffer: Buffer.from(fixture) });
      await page.getByRole('heading', { name: '恢复预览' }).waitFor(); await page.reload(); assert.equal(await page.locator('.knowledge-card').filter({ hasText: row.title }).count(), 0);
      await page.getByRole('button', { name: '知识库备份与恢复', exact: true }).click();
      await page.getByLabel('选择知识库备份文件', { exact: true }).setInputFiles({ name: 'synthetic-knowledge.json', mimeType: 'application/json', buffer: Buffer.from(fixture) });
      await page.getByRole('button', { name: '确认恢复', exact: true }).click(); await page.getByText('已恢复到本地，目录连接后继续写入。', { exact: true }).waitFor();
      await page.keyboard.press('Escape'); await page.locator('.knowledge-card').filter({ hasText: row.title }).click(); await page.locator('.knowledge-attachment img').waitFor();
      await page.waitForFunction(() => [...document.querySelectorAll('.knowledge-attachment img')].every(img => img.complete && img.naturalWidth > 0)); await capture('04-image-and-sources-1280x800');
      browser.checks.push('unconfirmed import discarded on reload; confirmed backup restores page, image and source');
      await page.getByRole('button', { name: '知识库备份与恢复', exact: true }).click();
      const downloaded = page.waitForEvent('download'); await page.getByRole('button', { name: '导出备份', exact: true }).click();
      const stream = await (await downloaded).createReadStream(), chunks = []; for await (const chunk of stream) chunks.push(chunk);
      const exported = await parseKnowledgeBackup(Buffer.concat(chunks).toString('utf8'));
      for (const [file, bytes] of fixtureFiles) assert.deepEqual(exported.entries.get(file), bytes);
      assert.equal(exported.summary.pages, 2); assert.equal(exported.summary.images, 1); assert.ok(exported.summary.versions >= 5);
      await page.keyboard.press('Escape'); browser.checks.push('UI export retains exact image/source, pages and revision history');
      await page.setViewportSize({ width: 390, height: 844 }); await capture('05-narrow-390x844');
      await page.getByRole('button', { name: '使用帮助', exact: true }).click(); await capture('06-narrow-help-390x844'); await page.keyboard.press('Escape');
      await page.setViewportSize({ width: 1280, height: 800 }); await page.goto(base + '#settings'); await page.getByRole('button', { name: '测试连接', exact: true }).waitFor();
      assert.doesNotMatch(await page.locator('body').innerText(), forbidden);
      await page.goto(`chrome-extension://${id}/popup/index.html`); await page.locator('.popup-shell').waitFor(); assert.doesNotMatch(await page.locator('body').innerText(), forbidden);
      browser.checks.push('ordinary settings and popup do not expose developer evaluation or probes'); assert.deepEqual(browser.errors, []);
    } finally { await context.close(); }
  }
  assert.deepEqual(await hashes(), report.distSha256, 'Production build changed during review');
  const promo = await chromium.launch({ executablePath: process.env.UX014_CHROME_EXECUTABLE, headless: true });
  try {
    const page = await promo.newPage({ viewport: { width: 440, height: 280 } }); const logo = (await readFile(path.join(root, 'dist/icons/icon128.png'))).toString('base64');
    await page.setContent(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;background:#fb7299;font-family:"Microsoft YaHei",sans-serif;color:#18191c;padding:30px;width:440px;height:280px}header{display:flex;align-items:center;gap:12px;font-size:32px;font-weight:700}img{width:56px;height:56px}h1{font-size:25px;line-height:1.55;margin:18px 0 12px}p{font-size:16px;margin:0;line-height:1.6}</style><header><img src="data:image/png;base64,${logo}" alt="">Bili-Bill</header><h1>边看边记<br>让学习资料持续可用</h1><p>开放本地知识库 · 保留出处</p></html>`);
    await page.screenshot({ path: path.join(out, 'promo-440x280.png') }); report.screenshots.push({ file: 'promo-440x280.png', width: 440, height: 280, kind: 'promotional_artwork' });
  } finally { await promo.close(); }
  for (const { file } of report.screenshots) report.files[file] = sha(await readFile(path.join(out, file)));
  report.status = 'pass';
} catch (error) { report.status = 'fail'; report.error = error.stack; process.exitCode = 1; }
finally { await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ out, status: report.status, browsers: report.browsers, error: report.error })); }
