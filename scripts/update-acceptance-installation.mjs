// Update only a named development installation. Never touches browser profiles,
// grants permissions, reloads the browser, or authorizes model requests.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = await fs.realpath(process.cwd());
const source = await fs.realpath(process.argv[2]), target = await fs.realpath(process.argv[3]);
for (const directory of [source, target]) assert.ok(directory.startsWith(root + path.sep), 'Use an explicitly named workspace package.');
assert.equal(path.basename(target), 'extension');
assert.notEqual(path.join(source, 'extension'), target);
const receipt = JSON.parse(await fs.readFile(path.join(source, 'verification.json'), 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const entries = receipt.files.filter(f => f.path.startsWith('extension/'));
assert.ok(entries.length > 0);
for (const file of entries) {
  assert.ok(!file.path.includes('..') && !file.path.includes('\\'));
  const full = path.join(source, file.path);
  assert.equal((await fs.lstat(full)).isSymbolicLink(), false);
  assert.equal(sha(await fs.readFile(full)), file.sha256, file.path);
}
const current = JSON.parse(await fs.readFile(path.join(target, 'manifest.json'), 'utf8'));
const next = JSON.parse(await fs.readFile(path.join(source, 'extension/manifest.json'), 'utf8'));
assert.equal(current.key, next.key, 'Preserve extension identity.');
for (const field of ['permissions', 'host_permissions', 'optional_permissions', 'optional_host_permissions', 'externally_connectable']) {
  assert.deepEqual(current[field], next[field], `Permission change requires a separate installation review: ${field}`);
}
assert.equal(current.options_ui?.page, 'acceptance/index.html', 'Target must be the developer acceptance extension.');
let previous;
try { previous = JSON.parse(await fs.readFile(path.join(target, '../installed-update.json'), 'utf8')).installedFiles; }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  previous = JSON.parse(await fs.readFile(path.join(target, '../verification.json'), 'utf8')).files.filter(f => f.path.startsWith('extension/'));
}
assert.ok(Array.isArray(previous) && previous.length);
const old = [];
async function walk(directory, prefix = '') {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name), relative = prefix + entry.name;
    assert.equal((await fs.lstat(full)).isSymbolicLink(), false);
    if (entry.isDirectory()) await walk(full, relative + '/');
    else {
      const expected = previous.find(f => f.path === 'extension/' + relative);
      assert.ok(expected, `Unknown existing file; stop before writing: ${relative}`);
      const bytes = await fs.readFile(full); assert.equal(sha(bytes), expected.sha256, `Existing file changed: ${relative}`);
      old.push({ path: relative, sha256: sha(bytes) });
    }
  }
}
await walk(target);
assert.equal(old.length, previous.length, 'Existing installation is incomplete.');
const snapshot = path.join(root, 'release-artifacts', `acceptance-install-backup-${Date.now()}`);
await fs.mkdir(snapshot); await fs.cp(target, path.join(snapshot, 'extension'), { recursive: true });
for (const file of old) assert.equal(sha(await fs.readFile(path.join(snapshot, 'extension', file.path))), file.sha256);
// Backup is complete and verified before replacement. Remove only exact obsolete
// build files present in that verified backup; never recursively delete a path.
await fs.cp(path.join(source, 'extension'), target, { recursive: true });
for (const file of old) if (!entries.some(f => f.path === 'extension/' + file.path)) {
  const obsolete = path.resolve(target, file.path);
  assert.ok(obsolete.startsWith(target + path.sep) && obsolete.startsWith(root + path.sep));
  assert.equal(sha(await fs.readFile(obsolete)), file.sha256);
  await fs.unlink(obsolete);
}
for (const file of entries) assert.equal(sha(await fs.readFile(path.join(target, file.path.slice(10)))), file.sha256);
const deployed = { sourcePackage: source, sourceCommit: receipt.sourceCommit, buildHash: receipt.buildHash,
  extensionId: receipt.extensionId, target, snapshot, originalFiles: old, installedFiles: entries, updatedAt: new Date().toISOString(),
  browserReloaded: false, browserStorageTouched: false, modelCalls: 0 };
await fs.writeFile(path.join(snapshot, 'update.json'), JSON.stringify(deployed, null, 2));
await fs.writeFile(path.join(target, '../installed-update.json'), JSON.stringify(deployed, null, 2));
console.log(JSON.stringify({ sourceCommit: receipt.sourceCommit, target, snapshot, filesVerified: entries.length, browserReloadRequired: true }));
