import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url)), artifacts = path.join(root, 'release-artifacts');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(process.platform, 'win32', 'This candidate packager targets Windows Chrome and Edge.');
assert.ok(process.env.npm_execpath, 'Run npm run package:knowledge.');
for (const name of ['UX014_PLAYWRIGHT_MODULE', 'UX014_CHROME_EXECUTABLE', 'UX014_EDGE_EXECUTABLE']) assert.ok(process.env[name], `Set ${name}.`);
assert.equal(git('status', '--porcelain'), '', 'Commit changes before binding the candidate to a source tree.');
const commit = git('rev-parse', 'HEAD'), sourceTree = git('rev-parse', 'HEAD^{tree}');
const out = path.join(artifacts, `open-knowledge-${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${commit.slice(0, 7)}`);
await mkdir(out); await mkdir(path.join(out, 'evidence'));
const report = { status: 'running', sourceCommit: commit, sourceTree, node: process.version, syntheticOnly: true,
  realSiteAcceptance: 'not_completed', realModelAcceptance: 'not_completed', nativePickerAcceptance: 'not_completed',
  installedCodexHostAcceptance: 'not_completed', terraReview: 'unavailable', releasePublished: false, steps: [], suites: [], packages: [] };
const save = () => writeFile(path.join(out, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
await save(); console.log(`Candidate directory: ${out}`);

async function run(label, command, args) {
  console.log(`Running ${label}`);
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', env: process.env, maxBuffer: 24 * 1024 * 1024, timeout: 600000 });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  await writeFile(path.join(out, 'evidence', `${label}.log`), output);
  report.steps.push({ name: label, status: result.status === 0 ? 'pass' : 'fail' }); await save();
  assert.equal(result.status, 0, `${label} failed: ${result.error?.message ?? output.slice(-2500)}`); return output;
}
const npm = (label, ...args) => run(label, process.execPath, [process.env.npm_execpath, ...args]);

async function inventory(directory, prefix = '') {
  assert.equal((await lstat(directory)).isSymbolicLink(), false, 'Package directories must not be links.');
  const entries = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name), name = prefix + item.name;
    assert.equal((await lstat(file)).isSymbolicLink(), false, `Linked file: ${name}`);
    assert.ok(!/(^|\/)(node_modules|\.git|profile|user-data|config\.json|\.env|key\.txt|cookies|credentials)(\/|$)/i.test(name), `Private path: ${name}`);
    assert.ok(!/\.(pem|pfx|p12|key)$/i.test(name), `Private file: ${name}`);
    if (item.isDirectory()) entries.push(...await inventory(file, name + '/'));
    else {
      assert.ok(item.isFile()); const bytes = await readFile(file);
      if (/\.(m?js|json|md|txt|html|css)$/i.test(name)) assert.ok(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bsk-[A-Za-z0-9_-]{24,}\b/.test(bytes.toString('utf8')), `Secret-like content: ${name}`);
      entries.push({ path: name, bytes: bytes.length, sha256: sha(bytes) });
    }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}
async function zip(source, file) {
  const expected = await inventory(source), destination = path.join(out, file);
  const command = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($env:BB_PACKAGE_SOURCE, $env:BB_PACKAGE_ZIP)
$archive = [IO.Compression.ZipFile]::OpenRead($env:BB_PACKAGE_ZIP)
try {
  $rows = foreach ($entry in $archive.Entries) {
    if ($entry.Name -eq '') { continue }
    $stream = $entry.Open()
    $hash = [Security.Cryptography.SHA256]::Create()
    try { [pscustomobject]@{ path = $entry.FullName.Replace([char]92, [char]47); bytes = $entry.Length; sha256 = ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() } }
    finally { $stream.Dispose(); $hash.Dispose() }
  }
  ConvertTo-Json -InputObject @($rows) -Compress
} finally { $archive.Dispose() }
`;
  const output = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
    cwd: root, encoding: 'utf8', env: { ...process.env, BB_PACKAGE_SOURCE: source, BB_PACKAGE_ZIP: destination }, maxBuffer: 8 * 1024 * 1024,
  });
  const actual = JSON.parse(output).sort((a, b) => a.path.localeCompare(b.path)); assert.deepEqual(actual, expected, 'ZIP readback mismatch');
  const bytes = await readFile(destination), hash = sha(bytes);
  await writeFile(destination + '.sha256', `${hash}  ${file}\n`);
  report.packages.push({ file, sha256: hash, bytes: bytes.length, files: expected }); await save();
}

try {
  await npm('typecheck', 'run', 'typecheck');
  await npm('unit-tests', 'test');
  await npm('browser-build', 'run', 'build');
  await npm('codex-tests', 'test', '--prefix', 'packages/codex-knowledge');
  const buildOutput = await npm('codex-build', 'run', 'build', '--prefix', 'packages/codex-knowledge');
  const pluginResult = buildOutput.trim().split(/\r?\n/).map(line => { try { return JSON.parse(line); } catch { return null; } }).findLast(value => value?.output);
  assert.equal(pluginResult?.status, 'pass');
  const plugin = path.resolve(pluginResult.output);
  assert.equal(path.dirname(path.dirname(plugin)), artifacts, 'Plugin build escaped the artifact root.');
  const pluginReport = JSON.parse(await readFile(path.join(path.dirname(plugin), 'report.json'), 'utf8'));
  assert.deepEqual(await inventory(plugin), pluginReport.files.sort((a, b) => a.path.localeCompare(b.path)));
  const suites = [
    ['foundation', 'open-knowledge'], ['shell', 'knowledge-shell'], ['subtitles', 'automatic-subtitles'],
    ['images', 'quick-images'], ['workspace', 'knowledge-workspace'], ['prompts', 'prompt-settings'], ['integration', 'knowledge-integration'],
  ];
  for (const [name, stem] of suites) {
    const before = new Set(await readdir(artifacts));
    await run(name, process.execPath, [`tests/${stem}.browser-qa.mjs`]);
    const created = (await readdir(artifacts)).filter(value => !before.has(value) && value.startsWith(stem + '-'));
    assert.equal(created.length, 1, `Expected exactly one ${name} report.`);
    const directory = path.join(artifacts, created[0]), suite = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8'));
    assert.equal(suite.status, 'pass');
    const target = path.join(out, 'evidence', name); await mkdir(target);
    for (const item of await readdir(directory, { withFileTypes: true })) if (item.isFile() && (item.name === 'report.json' || item.name.endsWith('.png'))) {
      assert.equal((await lstat(path.join(directory, item.name))).isSymbolicLink(), false);
      await cp(path.join(directory, item.name), path.join(target, item.name));
    }
    report.suites.push({ name, evidence: `evidence/${name}/report.json`, ...suite }); await save();
  }
  assert.equal(git('status', '--porcelain'), '', 'The source tree changed during packaging.');
  assert.equal(git('rev-parse', 'HEAD'), commit);
  await inventory(path.join(root, 'dist'));
  await cp(path.join(root, 'dist'), path.join(out, 'extension'), { recursive: true });
  await cp(plugin, path.join(out, 'codex-plugin', 'bili-bill-knowledge'), { recursive: true });
  await zip(path.join(out, 'extension'), 'bili-bill-browser-candidate.zip');
  await zip(path.join(out, 'codex-plugin', 'bili-bill-knowledge'), 'bili-bill-codex-plugin.zip');
  const sourceUrl = `https://github.com/LittleNuB/BILI-BILL/blob/${commit}`;
  await writeFile(path.join(out, 'README.md'), `# Bili-Bill 开放知识库验收候选\n\n源码 ${commit}。不是正式版本或商店上架包，未覆盖旧验收包。版本字段仍为 0.13.0-alpha。\n\n## 浏览器\n\n在 Chrome / Edge 扩展管理页开启开发者模式，加载本目录 extension。先备份旧数据；换目录加载可能产生新扩展身份，不要卸载唯一副本。进入视频页后先记录一条笔记、截图，再打开知识库。无 AI 配置也可保存。\n\n## 本地目录与 Codex\n\n在知识库连接目录，等待目录已同步。按 codex-plugin/bili-bill-knowledge/README.md 配置库路径与身份，再通过本地插件入口或 stdio MCP 接入。需要 Node.js 24+。本包不包含个人配置或凭据。宿主不支持确认交互时，个人写回保持关闭。\n\n## 十分钟验收\n\n1. 有字幕时自动获取；晚开启字幕后无需再次选择；切分 P 不带入旧文本。\n2. 播放中点纸笔，稍后保存，核对点击时间；截图后补文字，核对实际捕获时间。\n3. 连接目录，核对 Markdown、图片、来源。断连后记录，重连后继续写入。\n4. Codex 检索记录、预览修改，拒绝一次再确认一次；浏览器刷新后读回。\n5. 制造两端并发修改，保留双方并合并；恢复历史后原历史仍在。\n6. 导出知识备份，在空白测试环境预览恢复，核对图片和来源；不要清空真实唯一副本。\n\n## 证据边界\n\nverification.json 与 evidence 保存本源码的验证结果。截图是生产组件与合成资料，不是真实 B站、真实模型或原生目录选择器验收。浏览器/Codex 同目录测试使用受控 IO 桥，确认由合成宿主模拟；另有打包后真实 stdio 协议测试。当前 Codex 安装、系统缩放/全屏、原生截图授权、真实模型以及指定 Terra/xhigh 复核仍未完成。旧 A2 与发布门禁不随本包通过。\n\n[完整使用指南](${sourceUrl}/docs/user-guide.md) · [验收记录](${sourceUrl}/docs/qa-open-knowledge-integration.md)\n`);
  const screens = [['知识库与图文记录', 'integration/Chrome-1280.png'], ['窄窗口', 'integration/Chrome-390.png'], ['版本历史', 'integration/Chrome-history.png'], ['恢复预览', 'integration/Chrome-restore-preview.png']];
  await writeFile(path.join(out, 'Guide.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bili-Bill 验收候选</title><style>body{margin:0;color:#18191c;background:#fff;font:15px/1.75 "Segoe UI","Microsoft YaHei",sans-serif;letter-spacing:0}main{max-width:1160px;margin:auto;padding:28px 20px}h1{font-size:28px}h2{font-size:20px}p{max-width:900px;color:#61666d}section{border-top:1px solid #e3e5e7;margin-top:24px;padding-top:16px}img{display:block;max-width:100%;height:auto}a{color:#0086b3}</style><main><h1>Bili-Bill</h1><p>开放本地知识库验收候选 · ${commit.slice(0, 7)}</p><p>浏览器加载 extension；Codex 插件位于 codex-plugin。以下是生产组件与合成资料的实际截图，不是真实 B站验收，不是正式发布。</p><a href="README.md">安装与短验收</a> · <a href="verification.json">验证记录</a>${screens.map(([title, file]) => `<section><h2>${title}</h2><img src="evidence/${file}" alt="${title}，合成资料"></section>`).join('')}</main></html>`);
  await run('diff-check', 'git', ['diff', '--check']);
  report.status = 'pass'; await save(); console.log(JSON.stringify({ output: out, sourceCommit: commit, status: report.status, realSiteAcceptance: report.realSiteAcceptance }));
} catch (error) { report.status = 'fail'; report.error = String(error); await save(); throw error; }
