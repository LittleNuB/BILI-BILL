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
let prior = null;
if (process.argv[3]) {
  const text = await readFile(path.resolve(process.argv[3]), 'utf8');
  const compiled = await build({ stdin: { contents: "export { parseSeed } from './src/dev/prompt-eval/seed.ts'; export { tokenBudget } from './src/dev/prompt-eval/budget.ts';", resolveDir: root }, bundle: true, write: false, platform: 'node', format: 'esm' });
  const { parseSeed, tokenBudget } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
  const seed = await parseSeed(text);
  assert.equal(seed.datasetHash, binding.datasetHash); assert.equal(seed.baselineCommit, binding.baselineCommit);
  const budget = tokenBudget(seed.rows);
  assert.equal(seed.rows.filter(row => row.attempted).length, 32); assert.equal(budget.measured, 58493); assert.equal(budget.unknown, 0);
  await writeFile(path.join(page, 'prior-report.json'), text, { flag: 'wx' });
  prior = { sha256: sha(text), sourceCommit: seed.sourceCommit, calls: 32, measuredTokens: budget.measured };
}
await build({ entryPoints: ['src/dev/prompt-eval/worker.ts'], outfile: path.join(extension, 'prompt-eval-worker.js'), bundle: true, minify: true, platform: 'browser', format: 'esm', target: 'es2022', define: { __EVAL_BUILD__: JSON.stringify(binding), __EVAL_HAS_SEED__: JSON.stringify(!!prior) } });
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
  baseCandidate: path.basename(base), maximumCalls: 48, totalTokenBudget: 1000000, defaultOutputTokens: 8192, prior,
  zipSha256: sha(await readFile(zip)), files: inventory }, null, 2));
await writeFile(path.join(out, 'Guide.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bili-Bill 真实模型评测</title><style>body{font:16px/1.8 "Segoe UI","Microsoft YaHei",sans-serif;color:#18191c;margin:40px auto;padding:0 24px;max-width:880px}h1{font-size:28px}a{color:#007c9e}code{background:#f1f2f3;padding:3px}li{margin:12px 0}</style><h1>Bili-Bill 真实模型评测</h1><p>源码 ${commit.slice(0,7)} · 16个合成案例 · 32次初测，补测最多16次。此包已通过程序验证，尚无真实模型质量结论。</p><ol><li>在 Chrome / Edge 扩展管理页加载本包的 <code>extension</code> 目录。不要卸载原扩展或清除原数据。新路径可能产生新扩展身份，旧配置不会自动迁移。</li><li>打开扩展设置，确认文字模型、图片模型和流式偏好。若新扩展未配置，请在设置界面自行填写；不需要把密钥交给 Agent。</li><li>点击扩展工具栏图标，在弹窗顶部点击“提示词评测（开发验收）”。检查显示的模型，点击“开始32次对照”。只有点击才会发起模型调用。</li><li>保持评测页打开。可以停止；关闭会取消当前请求，重新打开后查看记录并继续未运行项。失败不会自动重发，鉴权或余额问题会停止批次。</li><li>点击“导出结果”，把 JSON 交回本任务分析。逐项查看材料、回答和评分依据；不需要你先完成全部评分。</li></ol><p>只发送自建测试资料，不读取或发送个人笔记、观看历史、收藏或密钥文件。凭据仅由扩展后台用于现有模型请求，不包含在导出结果中。未取得实际回答前，不宣称真实模型评测完成。</p><p>普通候选包不包含此开发入口；本包不用于商店发布。<a href="verification.json">构建与校验记录</a></p></html>`);
const guide = path.join(out, 'Guide.html');
const continuation = `<h2>本轮额度与继续测试</h2><p>累计最多1,000,000 token，最多48次调用。默认摘要、对话和图片单次输出8,192，必要时可选16,384；字幕仍为6,000。每次预留100,000，按接口实际用量结算。缺失用量保留预留并暂停；预留是保守估算，不是服务商计费保证。</p>${prior ? '<p><strong>此包已携带原32条固定样本记录，用量58,493，剩余941,507 token，最多再生成16次。不要重新跑初测。</strong>下方初测步骤仅适用于不带历史记录的包。</p><ol><li>加载新目录后自行配置与原批次相同的接口、文字/图片模型及流式偏好（原导出为开启流式）；不迁移或导出密钥。</li><li>打开评测页，确认已尝试32/48、已计量58,493。选择“连续追问”的失败记录，展开“补测此案例”，填写“输出上限提高到8192，检查截断”，点击“追加一次生成”。候选与旧版各补一次。</li><li>检查回答；仍达到输出上限时再选择16,384补测。不自动重试。导出完整JSON交回分析。新结果标为参数回归，不覆盖原A/B或旧回答。</li></ol><p>携带真实模型回答的续测包仅供本地使用，不自动上传GitHub。补测质量尚未验证。</p>' : '<p>新批次两组使用相同所选上限。初测中途不能改输出参数；开始前先确认预算和模型。</p>'}`;
await writeFile(guide, (await readFile(guide, 'utf8'))
  .replace('<h1>Bili-Bill 真实模型评测</h1>', '<h1>Bili-Bill 真实模型评测</h1>' + continuation)
  .replace('此包已通过程序验证，尚无真实模型质量结论。', prior ? '此包已通过程序验证并保留原32次记录；新增补测尚无真实模型质量结论。' : '此包已通过程序验证，尚无真实模型质量结论。'));
console.log(JSON.stringify({ output: out, ...binding, status: 'pass', realModelAcceptance: 'not_completed', prior }));
