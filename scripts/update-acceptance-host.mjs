// Update a named, already registered host in place; registration, launcher and
// billing remain untouched. Old runtime files are backed up before any write.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = await fs.realpath(process.cwd()), source = await fs.realpath(process.argv[2]), target = await fs.realpath(process.argv[3]);
for (const directory of [source, target]) assert.ok(directory.startsWith(root + path.sep));
assert.equal(path.basename(target), 'tools'); assert.notEqual(path.join(source, 'tools'), target);
const receipt = JSON.parse(await fs.readFile(path.join(source, 'verification.json'), 'utf8'));
assert.match(receipt.extensionId, /^[a-p]{32}$/); assert.match(receipt.sourceCommit, /^[a-f0-9]{40}$/); assert.match(receipt.buildHash, /^[a-f0-9]{64}$/);
const entries = receipt.files.filter(file => /^tools\/[^/]+\.mjs$/.test(file.path));
assert.ok(entries.some(file => file.path === 'tools/host.mjs'));
assert.equal(new Set(entries.map(file => file.path)).size, entries.length);
const manifestBytes = await fs.readFile(path.join(target, 'native-host.json'));
const launcherBytes = await fs.readFile(path.join(target, 'native-host.cmd'));
const manifest = JSON.parse(manifestBytes);
assert.equal(manifest.name, 'com.bili_bill.acceptance');
assert.equal(manifest.path, path.join(target, 'native-host.cmd'));
assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${receipt.extensionId}/`]);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
for (const file of entries) {
  assert.equal((await fs.lstat(path.join(source, file.path))).isSymbolicLink(), false);
  assert.equal(sha(await fs.readFile(path.join(source, file.path))), file.sha256);
}
let previous;
try { previous = JSON.parse(await fs.readFile(path.join(target, '../installed-host-update.json'), 'utf8')).installedFiles; }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  previous = JSON.parse(await fs.readFile(path.join(target, '../verification.json'), 'utf8')).files.filter(file => /^tools\/[^/]+\.mjs$/.test(file.path));
}
const old = [];
for (const name of await fs.readdir(target)) if (name.endsWith('.mjs')) {
  const file = path.join(target, name), expected = previous.find(entry => entry.path === 'tools/' + name);
  assert.ok(expected, `Unknown host file: ${name}`); assert.equal((await fs.lstat(file)).isSymbolicLink(), false);
  const bytes = await fs.readFile(file); assert.equal(sha(bytes), expected.sha256, name);
  old.push({ path: 'tools/' + name, sha256: sha(bytes), bytes });
}
assert.equal(old.length, previous.length);
const snapshot = path.join(root, 'release-artifacts', `acceptance-host-backup-${Date.now()}`);
await fs.mkdir(path.join(snapshot, 'tools'), { recursive: true });
for (const file of old) {
  const backup = path.join(snapshot, file.path); await fs.writeFile(backup, file.bytes);
  assert.equal(sha(await fs.readFile(backup)), file.sha256);
}
for (const file of entries) {
  const destination = path.join(target, path.basename(file.path));
  await fs.copyFile(path.join(source, file.path), destination);
  assert.equal(sha(await fs.readFile(destination)), file.sha256);
}
assert.deepEqual(await fs.readFile(path.join(target, 'native-host.json')), manifestBytes);
assert.deepEqual(await fs.readFile(path.join(target, 'native-host.cmd')), launcherBytes);
const installedFiles = [...previous.filter(file => !entries.some(next => next.path === file.path)), ...entries];
const record = { sourcePackage: source, sourceCommit: receipt.sourceCommit, buildHash: receipt.buildHash, target, snapshot,
  originalFiles: old.map(({ bytes, ...file }) => file), installedFiles, updatedAt: new Date().toISOString(), registrationChanged: false, billingChanged: false };
await fs.writeFile(path.join(target, '../installed-host-update.json'), JSON.stringify(record, null, 2));
await fs.writeFile(path.join(snapshot, 'update.json'), JSON.stringify(record, null, 2));
console.log(JSON.stringify({ sourceCommit: receipt.sourceCommit, target, snapshot, filesVerified: entries.length, registrationChanged: false, billingChanged: false }));
