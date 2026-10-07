import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

test('host update verifies both runtimes before writing and preserves registration, launcher and billing', async () => {
  const workspace = await fs.realpath(process.cwd());
  await fs.mkdir(path.join(workspace, 'release-artifacts'), { recursive: true });
  const root = await fs.mkdtemp(path.join(workspace, 'release-artifacts', 'host-update-qa-'));
  const source = path.join(root, 'new'), target = path.join(root, 'old', 'tools');
  await fs.mkdir(path.join(source, 'tools'), { recursive: true }); await fs.mkdir(target, { recursive: true });
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  const oldHost = 'export const old = true;', oldChunk = 'export const previousChunk = true;', newHost = "import './new-chunk.mjs';";
  const entries = [
    { path: 'tools/host.mjs', sha256: sha(newHost) },
    { path: 'tools/new-chunk.mjs', sha256: sha('export const updated = true;') },
  ];
  const extensionId = 'mfckoeaknohgggjkgebbpljcmjhjbbnl';
  await fs.writeFile(path.join(source, 'tools', 'host.mjs'), newHost);
  await fs.writeFile(path.join(source, 'tools', 'new-chunk.mjs'), 'export const updated = true;');
  await fs.writeFile(path.join(source, 'verification.json'), JSON.stringify({ extensionId, sourceCommit: 'c'.repeat(40), buildHash: 'b'.repeat(64), files: entries }));
  await fs.writeFile(path.join(target, 'host.mjs'), oldHost); await fs.writeFile(path.join(target, 'old-chunk.mjs'), oldChunk);
  await fs.writeFile(path.join(target, '../verification.json'), JSON.stringify({ files: [
    { path: 'tools/host.mjs', sha256: sha(oldHost) }, { path: 'tools/old-chunk.mjs', sha256: sha(oldChunk) },
  ] }));
  const manifest = JSON.stringify({ name: 'com.bili_bill.acceptance', path: path.join(target, 'native-host.cmd'), allowed_origins: [`chrome-extension://${extensionId}/`] });
  const launcher = 'original launcher and ledger path';
  const billing = '{"unknown":null,"reservation":100000}';
  await fs.writeFile(path.join(target, 'native-host.json'), manifest); await fs.writeFile(path.join(target, 'native-host.cmd'), launcher);
  await fs.mkdir(path.join(root, 'release-artifacts', 'acceptance-state'), { recursive: true });
  const ledger = path.join(root, 'release-artifacts', 'acceptance-state', 'billing.json'); await fs.writeFile(ledger, billing);
  const run = () => execFileSync(process.execPath, [path.join(workspace, 'scripts', 'update-acceptance-host.mjs'), source, target], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  await fs.writeFile(path.join(source, 'tools', 'new-chunk.mjs'), 'changed source');
  assert.throws(run); assert.equal(await fs.readFile(path.join(target, 'host.mjs'), 'utf8'), oldHost);
  await fs.writeFile(path.join(source, 'tools', 'new-chunk.mjs'), 'export const updated = true;');
  await fs.writeFile(path.join(target, 'old-chunk.mjs'), 'changed installed host');
  assert.throws(run); assert.equal(await fs.readFile(path.join(target, 'host.mjs'), 'utf8'), oldHost);
  await fs.writeFile(path.join(target, 'old-chunk.mjs'), oldChunk);
  const result = JSON.parse(run());
  assert.equal(result.filesVerified, 2); assert.equal(result.registrationChanged, false); assert.equal(result.billingChanged, false);
  assert.equal(await fs.readFile(path.join(target, 'host.mjs'), 'utf8'), newHost);
  assert.equal(await fs.readFile(path.join(result.snapshot, 'tools', 'host.mjs'), 'utf8'), oldHost);
  assert.equal(await fs.readFile(path.join(target, 'native-host.json'), 'utf8'), manifest);
  assert.equal(await fs.readFile(path.join(target, 'native-host.cmd'), 'utf8'), launcher);
  assert.equal(await fs.readFile(ledger, 'utf8'), billing);
  const installed = JSON.parse(await fs.readFile(path.join(target, '../installed-host-update.json'), 'utf8'));
  assert.equal(installed.installedFiles.length, 3);
  assert.equal(JSON.parse(run()).filesVerified, 2, 'A repeated verified update keeps its previous runtime receipt.');
});
