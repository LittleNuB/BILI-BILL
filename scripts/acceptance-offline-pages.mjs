import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const key of ['UX014_PLAYWRIGHT_MODULE', 'UX014_CHROME_EXECUTABLE', 'UX014_EDGE_EXECUTABLE']) {
  assert.ok(process.env[key], `Set ${key} to the existing test runtime. No downloads or browser installation are performed.`);
  await access(process.env[key]);
}
await access(path.join(root, 'dist/content/player-monitor.js'));
const out = path.join(root, 'release-artifacts', `acceptance-offline-pages-${Date.now()}`); await mkdir(out, { recursive: true });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const production = await readFile(path.join(root, 'dist/content/player-monitor.js'));
const report = { version: 1, kind: 'offline_page_regression', createdAt: new Date().toISOString(),
  productionContentSha256: sha(production), realModelCalls: 0, personalBrowserStateRead: false,
  realSiteUi: 'not_run', modelQuality: 'not_evaluated', suites: [] };
const suites = [
  ['session', 'tests/acceptance-session.browser-qa.mjs'],
  ['subtitles-and-parts', 'tests/automatic-subtitles.browser-qa.mjs'],
  ['notes-images-and-conversations', 'tests/quick-images.browser-qa.mjs'],
  ['extension-context-invalidation', 'tests/monitor-invalidation.mock-qa.mjs'],
];
try {
  for (const [name, script] of suites) {
    console.log(`Offline page regression: ${name}`);
    const started = Date.now();
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script], { cwd: root, env: process.env, windowsHide: true });
      let stdout = '', stderr = '', expired = false;
      const timer = setTimeout(() => { expired = true; child.kill(); }, 180000);
      child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr, expired }); });
    });
    await writeFile(path.join(out, name + '.log'), result.stdout + result.stderr);
    const lines = result.stdout.trim().split(/\r?\n/);
    let reportFile = lines.findLast(line => line.endsWith('report.json'));
    if (name === 'extension-context-invalidation') {
      const summary = JSON.parse(lines.at(-1)); reportFile = path.join(summary.out, 'report.json');
    }
    assert.ok(reportFile && path.resolve(reportFile).startsWith(path.join(root, 'release-artifacts') + path.sep), 'Missing local evidence report');
    const bytes = await readFile(reportFile), detail = JSON.parse(bytes);
    const browsers = detail.browsers ?? detail.results ?? [];
    const pass = result.code === 0 && !result.expired && detail.status !== 'fail'
      && browsers?.length === 2 && browsers.every(b => b.status === 'pass' || b.stopped === true);
    report.suites.push({ name, status: pass ? 'pass' : 'fail', elapsedMs: Date.now() - started,
      reportFile, reportSha256: sha(bytes), browsers: browsers.map(b => ({ name: b.name, checks: b.checks })),
      evidence: name === 'session' ? 'installed extension with synthetic native host' : 'production bundle with synthetic site/runtime/provider' });
    assert.ok(pass, `${name} failed; see ${path.join(out, name + '.log')}`);
  }
  report.status = 'pass';
} catch (error) { report.status = 'fail'; report.error = String(error); throw error; }
finally {
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  await writeFile(path.join(out, 'Report.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Bili-Bill 零费用页面回归</title>
    <style>body{font:16px/1.7 system-ui;max-width:960px;margin:32px auto;padding:0 20px}li{margin:8px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>
    <h1>零费用页面回归：${esc(report.status)}</h1><p>真实模型调用 0；未读取个人浏览器数据。页面、原生主机或供应商使用合成测试替身。这份报告不代表真实 B 站 UI 或模型质量验收通过。</p>
    <ul>${report.suites.map(s => `<li>${esc(s.name)}：${esc(s.status)}（${s.elapsedMs} ms） · <a href="${esc(path.relative(out, s.reportFile).split(path.sep).join('/'))}">测试证据</a></li>`).join('')}</ul>
    <pre>${esc(JSON.stringify(report, null, 2))}</pre></html>`);
  console.log(path.join(out, 'Report.html'));
}
