import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

export const baselineCommit = '8c7f3149b2063c483eca18266917b23d6b491aa1';
const root = process.cwd(), dir = path.join(root, 'tests/fixtures/prompt-eval');
const files = ['src/shared/ai-prompts.ts', 'src/shared/learning-chat.ts', 'src/shared/current-video-summary-highlights.ts'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const baselineSources = Object.fromEntries(files.map(file => [file, execFileSync('git', ['show', `${baselineCommit}:${file}`], { encoding: 'utf8' })]));
const result = await build({ entryPoints: ['src/dev/prompt-eval/prepare.ts'], bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'baseline-source', setup(builder) {
    builder.onLoad({ filter: /[\\/]src[\\/]shared[\\/](ai-prompts|learning-chat|current-video-summary-highlights)\.ts$/ }, args => {
      const file = path.relative(root, args.path).replaceAll('\\', '/');
      return { contents: baselineSources[file], loader: 'ts', resolveDir: path.dirname(args.path) };
    });
  } }] });
const baseline = (await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)).prepareAll();
const baselineBytes = JSON.stringify(baseline, null, 2) + '\n';
const tracked = ['src/dev/prompt-eval/cases.ts', 'src/dev/prompt-eval/prepare.ts', 'scripts/freeze-prompt-eval.mjs'];
if (process.argv.includes('--freeze')) {
  assert.equal(await access(path.join(dir, 'manifest.json')).then(() => true, () => false), false, 'Frozen cases exist; never silently replace them.');
  await mkdir(path.join(dir, 'images'), { recursive: true });
  assert.ok(process.env.UX014_PLAYWRIGHT_MODULE, 'Set the existing Playwright module path.');
  const { chromium } = await import(pathToFileURL(process.env.UX014_PLAYWRIGHT_MODULE).href);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.UX014_CHROME_EXECUTABLE });
  try {
    const page = await browser.newPage();
    for (const name of ['chart', 'code', 'blur', 'conflict']) {
      const data = await page.evaluate(kind => {
        const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 480;
        const c = canvas.getContext('2d'); c.fillStyle = '#ffffff'; c.fillRect(0, 0, 800, 480);
        c.fillStyle = '#18191c'; c.font = '28px monospace';
        if (kind === 'chart') {
          c.fillText('Experiment categories (not a time series)', 32, 48);
          c.fillStyle = '#00a0c0'; c.fillRect(130, 210, 160, 180); c.fillStyle = '#ee628e'; c.fillRect(450, 120, 160, 270);
          c.fillStyle = '#18191c'; c.fillText('A = 12', 140, 435); c.fillText('B = 18', 460, 435);
        } else if (kind === 'code') {
          ['const result = [1, 2, 3]', '  .map(n => n * 2)', '  .filter(n => n > 3);', '', 'console.log(result.length);'].forEach((line, i) => c.fillText(line, 40, 70 + i * 65));
        } else if (kind === 'blur') {
          c.font = '48px monospace'; c.fillText('TOTAL:', 60, 210);
          c.fillStyle = '#94999e'; c.fillRect(290, 155, 300, 70);
          c.font = '24px monospace'; c.fillStyle = '#18191c'; c.fillText('[number obscured]', 290, 285);
        } else {
          c.fillStyle = '#cc3344'; c.font = '54px monospace'; c.fillText('ERROR', 80, 150);
          c.fillStyle = '#18191c'; c.font = '38px monospace'; c.fillText('HTTP 503', 80, 250); c.fillText('Retry later', 80, 330);
        }
        return canvas.toDataURL('image/png').split(',')[1];
      }, name);
      await writeFile(path.join(dir, 'images', `${name}.png`), Buffer.from(data, 'base64'), { flag: 'wx' });
    }
  } finally { await browser.close(); }
  await writeFile(path.join(dir, 'baseline.json'), baselineBytes, { flag: 'wx' });
  const entries = [...tracked, ...['chart', 'code', 'blur', 'conflict'].map(name => `tests/fixtures/prompt-eval/images/${name}.png`), 'tests/fixtures/prompt-eval/baseline.json'];
  const hashes = {};
  for (const file of entries) hashes[file] = sha(await readFile(file));
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ version: 'prompt-eval-v1', baselineCommit, syntheticOnly: true,
    baselineSources: Object.fromEntries(files.map(file => [file, sha(baselineSources[file])])), hashes }, null, 2) + '\n', { flag: 'wx' });
} else {
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.baselineCommit, baselineCommit);
  assert.equal(await readFile(path.join(dir, 'baseline.json'), 'utf8'), baselineBytes, 'Baseline differs from original production builders.');
  for (const [file, digest] of Object.entries(manifest.hashes)) assert.equal(sha(await readFile(file)), digest, `Frozen file changed: ${file}`);
}
console.log('Frozen prompt cases and baseline: verified');
