import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = process.cwd(), out = path.join(root, 'release-artifacts', `knowledge-shell-${Date.now()}`);
await mkdir(out, { recursive: true });
const css = await readFile(path.join(root, 'dashboard/styles/dashboard.css'), 'utf8');
const bundle = await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import { render } from 'preact';
import { useState } from 'preact/hooks';
import { AppShell } from './dashboard/components/AppShell';
import { NAV_ITEMS } from './dashboard/navigation';
function QA() {
  const [active, navigate] = useState(9);
  return <AppShell navItems={NAV_ITEMS} activeIndex={active} synced="测试记录已同步" exporting={false}
    onNavigate={navigate} onExport={format => { document.documentElement.dataset.export = format; }}>
    <div style={{ padding: '24px' }}><h2>{NAV_ITEMS[active].label}</h2><p>合成界面验收数据</p></div>
  </AppShell>;
}
render(<QA />, document.getElementById('app'));` }, jsx: 'automatic', jsxImportSource: 'preact', bundle: true, write: false, format: 'esm', platform: 'browser' });
const server = createServer((request, response) => {
  if (request.url === '/app.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle.outputFiles[0].text); }
  else { response.setHeader('Content-Type', 'text/html'); response.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Synthetic shell QA</title><style>${css}</style><div id="app"></div><script type="module" src="/app.js"></script>`); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const { chromium } = await import(pathToFileURL(process.env.UX014_PLAYWRIGHT_MODULE).href);
const report = { syntheticOnly: true, status: 'running', cases: [], limitations: ['Shell components only; not Bilibili or data-flow acceptance.'] };
try {
  for (const [name, executablePath] of [['Chrome', process.env.UX014_CHROME_EXECUTABLE], ['Edge', process.env.UX014_EDGE_EXECUTABLE]]) {
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      for (const [width, height, scale] of [[1440, 960, 1], [900, 800, 1.5], [390, 844, 1]]) {
        const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale });
        const page = await context.newPage(), errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        await page.getByRole('heading', { name: '知识库', exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: '观看账单', exact: true }).count(), 0);
        await page.getByRole('button', { name: '更多工具', exact: true }).click();
        await page.getByRole('button', { name: '观看账单', exact: true }).click();
        await page.getByRole('heading', { name: '观看账单', exact: true }).waitFor();
        await page.getByRole('button', { name: '导出 JSON', exact: true }).click();
        assert.equal(await page.locator('html').getAttribute('data-export'), 'json');
        await page.getByRole('button', { name: '知识库', exact: true }).click();
        assert.equal(await page.getByRole('button', { name: '导出 JSON', exact: true }).count(), 0);
        await page.getByRole('button', { name: '更多工具', exact: true }).click();
        await page.getByRole('button', { name: 'B站收藏夹', exact: true }).focus();
        await page.keyboard.press('Enter');
        await page.getByRole('heading', { name: 'B站收藏夹', exact: true }).waitFor();
        const layout = await page.evaluate(() => {
          const buttons = [...document.querySelectorAll('.bb-nav-item')].map(el => {
            const r = el.getBoundingClientRect();
            const text = el.querySelector('.bb-nav-copy');
            return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height,
              clipped: !!text && text.scrollWidth > text.clientWidth + 1 };
          });
          return { overflow: document.documentElement.scrollWidth > innerWidth, buttons, icons: document.querySelectorAll('.bb-nav-item svg').length };
        });
        assert.equal(layout.overflow, false); assert.ok(layout.icons >= 5);
        for (let i = 0; i < layout.buttons.length; i++) {
          const a = layout.buttons[i]; assert.equal(a.clipped, false); assert.ok(a.height >= 34);
          for (const b of layout.buttons.slice(i + 1)) assert.ok(a.right <= b.x + 1 || b.right <= a.x + 1 || a.bottom <= b.y + 1 || b.bottom <= a.y + 1, 'navigation overlap');
        }
        await page.screenshot({ path: path.join(out, `${name}-${width}.png`), fullPage: true });
        assert.deepEqual(errors, []);
        report.cases.push({ name, version: browser.version(), width, scale, status: 'pass' });
        await context.close();
      }
    } finally { await browser.close(); }
  }
  report.status = 'pass';
} catch (error) { report.status = 'fail'; report.error = String(error); process.exitCode = 1; }
finally { await new Promise(resolve => server.close(resolve)); await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ output: out, ...report }, null, 2)); }
