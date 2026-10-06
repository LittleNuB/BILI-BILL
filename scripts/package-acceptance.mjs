import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile, readdir, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const root = process.cwd(), artifacts = path.join(root, 'release-artifacts');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(git('status', '--porcelain'), '', 'Commit before creating a source-bound package.');
assert.equal(process.platform, 'win32');
const planPath = await realpath(process.argv[2]);
assert.equal(path.dirname(planPath), artifacts, 'Use one explicitly selected local plan directly in release-artifacts.');
assert.ok((await lstat(planPath)).size <= 32000);
const compiled = await build({ stdin: { contents: "export { validatePlan } from './src/dev/acceptance/contract.ts';", resolveDir: root }, bundle: true, write: false, platform: 'node', format: 'esm' });
const { validatePlan } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const plan = validatePlan(JSON.parse(await readFile(planPath, 'utf8'))), planHash = sha(JSON.stringify(plan));
// Build clean ordinary dist first; the developer additions below affect only a new copy.
execFileSync(process.execPath, [process.env.npm_execpath, 'run', 'build'], { cwd: root, stdio: 'inherit' });
const sourceCommit = git('rev-parse', 'HEAD'), tree = git('rev-parse', 'HEAD^{tree}');
const binding = { sourceCommit, buildHash: sha(`${sourceCommit}\n${tree}\n${planHash}`) };
const out = path.join(artifacts, `acceptance-${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${sourceCommit.slice(0, 7)}`);
const extension = path.join(out, 'extension'), local = path.join(out, 'tools');
await mkdir(out); await cp(path.join(root, 'dist'), extension, { recursive: true }); await mkdir(path.join(extension, 'acceptance')); await mkdir(local);
await build({ entryPoints: ['src/dev/acceptance/worker.ts'], outfile: path.join(extension, 'acceptance-worker.js'), bundle: true, minify: true,
  platform: 'browser', format: 'esm', target: 'es2022', define: { __ACCEPTANCE_BUILD__: JSON.stringify(binding), __ACCEPTANCE_PLAN__: JSON.stringify(plan) } });
await build({ entryPoints: ['src/dev/acceptance/content.ts'], outfile: path.join(extension, 'acceptance-content.js'), bundle: true, minify: true, platform: 'browser', format: 'iife', target: 'es2022' });
await build({ entryPoints: ['src/dev/acceptance/page.ts'], outfile: path.join(extension, 'acceptance/page.js'), bundle: true, minify: true, platform: 'browser', format: 'esm', target: 'es2022' });
await cp('src/dev/acceptance/index.html', path.join(extension, 'acceptance/index.html'));
const original = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
assert.ok(!original.permissions.includes('nativeMessaging') && !original.externally_connectable);
const key = JSON.parse(await readFile('packages/acceptance/development-key.json', 'utf8')).key;
const extensionId = sha(Buffer.from(key, 'base64')).slice(0, 32).replace(/[0-9a-f]/g, n => String.fromCharCode(97 + parseInt(n, 16)));
const manifest = { ...original, key, permissions: [...original.permissions, 'nativeMessaging'],
  content_scripts: [...original.content_scripts, { matches: ['https://www.bilibili.com/video/*'], js: ['acceptance-content.js'], run_at: 'document_idle' }] };
await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest, null, 2));
const background = path.join(extension, 'background.js'); await writeFile(background, `import './acceptance-worker.js';\n${await readFile(background, 'utf8')}`);
const popup = path.join(extension, 'popup/index.html');
await writeFile(popup, (await readFile(popup, 'utf8')).replace(/<body[^>]*>/, match => `${match}<p><a href="../acceptance/index.html" target="_blank" rel="noopener">自动验收（开发）</a></p>`));
await build({ entryPoints: { host: 'packages/acceptance/host.mjs', cli: 'packages/acceptance/cli-entry.mjs', server: 'packages/acceptance/server-entry.mjs',
  'vendor-schema': 'packages/acceptance/vendor-schema.mjs', 'vendor-server': 'packages/acceptance/vendor-server.mjs' },
  outdir: local, outExtension: { '.js': '.mjs' }, bundle: true, splitting: true, minify: true, platform: 'node', target: 'node24', format: 'esm',
  banner: { js: "import { createRequire as __bbRequire } from 'node:module'; const require = __bbRequire(import.meta.url);" } });
const ledgerDirectory = path.join(artifacts, 'acceptance-state');
const launcher = path.join(local, 'native-host.cmd'), ledger = path.join(ledgerDirectory, 'billing.json');
for (const value of [process.execPath, path.join(local, 'host.mjs'), ledger]) assert.ok(!/["%\r\n!^&|<>]/.test(value), 'Unsafe Windows launcher path');
await writeFile(launcher, `@echo off\r\n"${process.execPath}" "${path.join(local, 'host.mjs')}" --extension-id ${extensionId} --ledger "${ledger}" %*\r\n`);
await writeFile(path.join(local, 'native-host.json'), JSON.stringify({ name: 'com.bili_bill.acceptance', description: 'Bili-Bill opt-in developer acceptance', path: launcher, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`] }, null, 2));
await writeFile(path.join(local, 'installation.json'), JSON.stringify({ extensionId, ledgerDirectory }, null, 2));
await cp('packages/acceptance/install.ps1', path.join(local, 'install.ps1')); await cp('packages/acceptance/README.md', path.join(out, 'README.md'));
await cp('packages/acceptance/skills', path.join(out, 'skills'), { recursive: true });
await cp('LICENSE', path.join(out, 'LICENSE'));
const lock = JSON.parse(await readFile('packages/acceptance/package-lock.json', 'utf8')), notices = [];
for (const [folder, pkg] of Object.entries(lock.packages)) {
  if (!folder || pkg.dev) continue;
  const name = folder.split('node_modules/').at(-1), directory = path.join(root, 'packages/acceptance', folder);
  notices.push(`${name}@${pkg.version}: ${pkg.license ?? 'See license'}`);
  for (const file of await readdir(directory)) if (/^(license|copying|notice)(\.|$)/i.test(file) && (await lstat(path.join(directory, file))).isFile()) {
    const destination = path.join(local, 'licenses', name.replaceAll('/', '__')); await mkdir(destination, { recursive: true }); await cp(path.join(directory, file), path.join(destination, file));
  }
}
await writeFile(path.join(local, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n'));
await writeFile(path.join(out, 'plan.json'), JSON.stringify(plan, null, 2));
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
await writeFile(path.join(out, 'Guide.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bili-Bill 开发验收包</title><style>body{max-width:920px;margin:32px auto;padding:0 20px;font:16px/1.8 system-ui}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f5f7;padding:16px}a{color:#006a8c}</style><h1>开发验收包 · 待安装与真实验收</h1><p>源码 ${sourceCommit}；扩展 ID ${extensionId}。</p><p>普通发行包没有新增权限。本包额外使用 nativeMessaging、开发帧采集脚本和精确扩展 ID 的本地主机。安装仅注册当前用户的 Chrome/Edge 本地主机位置，不改整机策略。尚未执行注册。</p><p>两个浏览器选一个收费实例；主机账本阻止新档案或旧快照重置计数。新路径加载的独立开发扩展须在设置中配置模型，不复制个人浏览器数据。</p><p>首次使用需批准安装、配对、本计划的材料采集与新增 ${plan.steps.length} 次调用。累计 token 仍为1,000,000，已含58,493；旧48次额度不变，新计划另记。每次预留100,000，未知用量暂停，剩余额度不足即停止，不保证能完成全部步骤。</p><p>请在选定分P页面手动开启原声AI字幕，每个目标只保留一个标签页。图片冻结执行采集时的当前帧及实际时间。字幕优化只测指定单批，不能当成长字幕全量通过。</p><pre>${escape(JSON.stringify(plan, null, 2))}</pre><ol><li>审查 <a href="tools/installation.json">安装范围</a> 和 <a href="README.md">使用说明</a>。install.ps1 默认只预览；取得批准后才使用 -Apply。</li><li>加载 extension 目录，在开发页确认固定计划与旧计量，取得30分钟配对码。</li><li>Codex 使用同一 CLI/MCP 核心自动冻结、生成、取回与导出，逐条审阅。页面保留停止和撤销按钮。</li></ol><p>当前无新增真实模型费用。真实页面字幕开关、分P切换、保存恢复与视觉效果仍须独立 UI 验收。</p></html>`);
const files = [];
async function walk(dir, prefix = '') {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name), relative = prefix + entry.name;
    assert.equal((await lstat(file)).isSymbolicLink(), false);
    if (entry.isDirectory()) await walk(file, relative + '/');
    else { const bytes = await readFile(file); if (/\.m?js$/.test(relative)) assert.ok(bytes.length <= 500000, relative); files.push({ path: relative, bytes: bytes.length, sha256: sha(bytes) }); }
  }
}
await walk(out);
await writeFile(path.join(out, 'verification.json'), JSON.stringify({ ...binding, sourceTree: tree, planHash, extensionId, status: 'package_built',
  evidence: { mock: 'see_tests', installedOffline: 'not_run', realModel: 'not_run', realSiteUi: 'not_run', nativeHostInstalled: false }, files }, null, 2));
console.log(JSON.stringify({ output: out, ...binding, extensionId }));
