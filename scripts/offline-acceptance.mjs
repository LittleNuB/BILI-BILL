import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
for (const key of ['UX014_PLAYWRIGHT_MODULE', 'UX014_CHROME_EXECUTABLE', 'UX014_BROWSER_EXECUTABLE']) {
  assert.ok(process.env[key], `Set ${key} before running offline acceptance.`);
}
const suites = [
  ['chat', 'tests/learning-chat.mock-qa.mjs'],
  ['knowledge', 'tests/knowledge-chat.mock-qa.mjs'],
  ['wiki', 'tests/video-wiki.mock-qa.mjs'],
  ['memory', 'tests/explicit-memory.mock-qa.mjs'],
  ['extension', 'tests/explicit-memory.extension-qa.mjs'],
  ['popup', 'tests/popup-native-ui.mock-qa.mjs'],
];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function distHashes() {
  const result = {};
  for (const entry of await readdir(path.join(root, 'dist'), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const absolute = path.join(entry.parentPath, entry.name);
    result[path.relative(path.join(root, 'dist'), absolute).replaceAll('\\', '/')] = sha(await readFile(absolute));
  }
  assert.ok(result['background.js'], 'Build the production extension first.');
  return result;
}
const sourceCommit = git('rev-parse', 'HEAD');
assert.equal(git('status', '--porcelain'), '', 'Commit tracked changes before binding acceptance evidence.');
const relative = `release-artifacts/offline-${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${sourceCommit.slice(0, 7)}`;
const out = path.join(root, relative);
await mkdir(out, { recursive: false });
const report = {
  sourceCommit, sourceTree: git('rev-parse', 'HEAD^{tree}'), node: process.version,
  syntheticOnly: true, realSiteAcceptance: 'not_run', realModelAcceptance: 'not_run',
  distSha256: await distHashes(), suites: [], status: 'running',
};
const save = () => writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
await save();
console.log(`Offline evidence: ${out}`);
try {
  for (const [name, script] of suites) {
    const directory = `${relative}/${name}`;
    const started = Date.now();
    console.log(`Running ${name}...`);
    const run = spawnSync(process.execPath, [script], {
      cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, OFFLINE_QA_OUTPUT: directory, POPUP_QA_OUTPUT: directory,
        CHAT_QA_DIRECTORY: directory.slice('release-artifacts/'.length) },
    });
    await writeFile(path.join(out, `${name}.log`), `${run.stdout || ''}\n${run.stderr || ''}`);
    let receipt;
    try { receipt = JSON.parse(await readFile(path.join(root, directory, 'report.json'), 'utf8')); }
    catch { /* Missing receipts are a failed suite, never a skipped pass. */ }
    const receiptPassed = name === 'popup'
      ? receipt?.results?.length === 9 && receipt.results.every(result => result.pass === true)
      : receipt?.status === 'pass';
    const passed = !run.error && run.status === 0 && receiptPassed;
    report.suites.push({ name, script, scriptSha256: sha(await readFile(path.join(root, script))),
      status: passed ? 'pass' : 'fail', exitCode: run.status, durationMs: Date.now() - started,
      receipt: `${name}/report.json`, error: run.error?.message ?? receipt?.error ?? null });
    await save();
    console.log(`${name}: ${passed ? 'pass' : 'fail'}`);
  }
  assert.deepEqual(await distHashes(), report.distSha256, 'Production bundle changed during acceptance.');
  assert.equal(git('rev-parse', 'HEAD'), sourceCommit, 'Source commit changed during acceptance.');
  assert.equal(git('status', '--porcelain'), '', 'Tracked sources changed during acceptance.');
  report.status = report.suites.every(suite => suite.status === 'pass') ? 'pass' : 'fail';
} catch (error) {
  report.status = 'fail'; report.error = error.stack;
} finally {
  await save();
  console.log(JSON.stringify({ status: report.status, report: path.join(out, 'report.json') }));
  if (report.status !== 'pass') process.exitCode = 1;
}
