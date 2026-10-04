import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const root = process.cwd(), artifacts = path.join(root, 'release-artifacts');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(git('status', '--porcelain'), '', 'Commit before creating a source-bound package.');
const commit = git('rev-parse', 'HEAD'), tree = git('rev-parse', 'HEAD^{tree}');
const base = path.resolve(process.argv[2] ?? '');
assert.equal(path.dirname(base), artifacts, 'Pass a verified candidate directly inside release-artifacts.');
const receipt = JSON.parse(await readFile(path.join(base, 'verification.json'), 'utf8'));
assert.equal(receipt.status, 'pass'); assert.equal(receipt.sourceCommit, commit);
const files = receipt.packages.find(p => p.file === 'bili-bill-browser-candidate.zip').files;
for (const file of files) assert.equal(sha(await readFile(path.join(base, 'extension', file.path))), file.sha256);
execFileSync(process.execPath, ['scripts/freeze-prompt-eval.mjs'], { stdio: 'inherit' });
const out = path.join(artifacts, `prompt-evaluation-${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${commit.slice(0, 7)}`);
const extension = path.join(out, 'extension'), page = path.join(extension, 'prompt-eval');
await mkdir(out); await cp(path.join(base, 'extension'), extension, { recursive: true }); await mkdir(page);
const frozen = await readFile('tests/fixtures/prompt-eval/manifest.json');
const binding = { sourceCommit: commit, baselineCommit: JSON.parse(frozen).baselineCommit, datasetHash: sha(frozen), buildHash: sha(`${commit}\n${tree}\n${sha(frozen)}`) };
await build({ entryPoints: ['src/dev/prompt-eval/worker.ts'], outfile: path.join(extension, 'prompt-eval-worker.js'), bundle: true, minify: true, platform: 'browser', format: 'esm', target: 'es2022', define: { __EVAL_BUILD__: JSON.stringify(binding) } });
await build({ entryPoints: ['src/dev/prompt-eval/page.tsx'], outfile: path.join(page, 'page.js'), bundle: true, minify: true, platform: 'browser', format: 'esm', target: 'es2022', jsx: 'automatic', jsxImportSource: 'preact' });
await cp('src/dev/prompt-eval/index.html', path.join(page, 'index.html'));
await cp('tests/fixtures/prompt-eval/images', path.join(page, 'images'), { recursive: true });
await cp('tests/fixtures/prompt-eval', path.join(out, 'frozen-cases'), { recursive: true });
const background = path.join(extension, 'background.js');
await writeFile(background, `import './prompt-eval-worker.js';\n${await readFile(background, 'utf8')}`);
const popup = path.join(extension, 'popup/index.html');
const html = await readFile(popup, 'utf8'); assert.match(html, /<body[^>]*>/);
await writeFile(popup, html.replace(/<body[^>]*>/, match => `${match}<p><a href="../prompt-eval/index.html" target="_blank" rel="noopener">提示词评测（开发验收）</a></p>`));
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
// Existing permissions and version remain byte-equivalent; the harness is only in this developer package.
assert.deepEqual(manifest, JSON.parse(await readFile(path.join(base, 'extension/manifest.json'), 'utf8')));
const inventory = [];
async function walk(dir, prefix = '') {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name), relative = prefix + entry.name;
    assert.equal((await lstat(file)).isSymbolicLink(), false);
    if (entry.isDirectory()) await walk(file, relative + '/');
    else { const bytes = await readFile(file); if (relative.endsWith('.js')) assert.ok(bytes.length <= 500000, relative); inventory.push({ path: relative, bytes: bytes.length, sha256: sha(bytes) }); }
  }
}
await walk(extension);
const zip = path.join(out, 'bili-bill-prompt-evaluation.zip');
execFileSync('tar.exe', ['-a', '-c', '-f', zip, '-C', extension, '.']);
const zipEntries = JSON.parse(execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$z=[IO.Compression.ZipFile]::OpenRead($env:BB_EVAL_ZIP)
try { $rows=foreach($e in $z.Entries) { if($e.Name -eq '') {continue}; $s=$e.Open(); $h=[Security.Cryptography.SHA256]::Create(); try { [pscustomobject]@{path=($e.FullName.Replace([char]92,[char]47) -replace '^\\./',''); bytes=$e.Length; sha256=([BitConverter]::ToString($h.ComputeHash($s))).Replace('-','').ToLowerInvariant()} } finally {$s.Dispose();$h.Dispose()} }; ConvertTo-Json -InputObject @($rows) -Compress } finally {$z.Dispose()}
`], { encoding: 'utf8', env: { ...process.env, BB_EVAL_ZIP: zip }, maxBuffer: 8 * 1024 * 1024 }));
assert.deepEqual(zipEntries.sort((a, b) => a.path.localeCompare(b.path)), inventory.sort((a, b) => a.path.localeCompare(b.path)));
await writeFile(path.join(out, 'verification.json'), JSON.stringify({ ...binding, status: 'pass', realModelAcceptance: 'not_completed',
  baseCandidate: path.basename(base), maximumCalls: 48, zipSha256: sha(await readFile(zip)), files: inventory }, null, 2));
await writeFile(path.join(out, 'Guide.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bili-Bill 真实模型评测</title><style>body{font:16px/1.8 "Segoe UI","Microsoft YaHei",sans-serif;color:#18191c;margin:40px auto;padding:0 24px;max-width:880px}h1{font-size:28px}a{color:#007c9e}code{background:#f1f2f3;padding:3px}li{margin:12px 0}</style><h1>Bili-Bill 真实模型评测</h1><p>源码 ${commit.slice(0,7)} · 16个合成案例 · 32次初测，补测最多16次。此包已通过程序验证，尚无真实模型质量结论。</p><ol><li>在 Chrome / Edge 扩展管理页加载本包的 <code>extension</code> 目录。不要卸载原扩展或清除原数据。新路径可能产生新扩展身份，旧配置不会自动迁移。</li><li>打开扩展设置，确认文字模型、图片模型和流式偏好。若新扩展未配置，请在设置界面自行填写；不需要把密钥交给 Agent。</li><li>点击扩展工具栏图标，在弹窗顶部点击“提示词评测（开发验收）”。检查显示的模型，点击“开始32次对照”。只有点击才会发起模型调用。</li><li>保持评测页打开。可以停止；关闭会取消当前请求，重新打开后查看记录并继续未运行项。失败不会自动重发，鉴权或余额问题会停止批次。</li><li>点击“导出结果”，把 JSON 交回本任务分析。逐项查看材料、回答和评分依据；不需要你先完成全部评分。</li></ol><p>只发送自建测试资料，不读取或发送个人笔记、观看历史、收藏或密钥文件。凭据仅由扩展后台用于现有模型请求，不包含在导出结果中。未取得实际回答前，不宣称真实模型评测完成。</p><p>普通候选包不包含此开发入口；本包不用于商店发布。<a href="verification.json">构建与校验记录</a></p></html>`);
console.log(JSON.stringify({ output: out, ...binding, status: 'pass', realModelAcceptance: 'not_completed' }));
