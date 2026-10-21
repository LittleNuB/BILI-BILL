import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolveAcceptanceLedger } from '../scripts/acceptance-ledger-path.mjs';

test('native billing selection stays in the same project for ordinary and nested worktree checkouts', async () => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bb-ledger-path-')));
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args,
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const repository = async (name: string) => {
    const root = path.join(temporary, name); await fs.mkdir(root);
    git(root, 'init', '-q');
    git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture', '--allow-empty');
    return fs.realpath(root);
  };
  const ledger = async (root: string) => {
    const directory = path.join(root, 'release-artifacts', 'acceptance-state'); await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, 'billing.json'); await fs.writeFile(file, '{}'); return fs.realpath(file);
  };
  try {
    const primary = await repository('project'), own = await ledger(primary);
    assert.equal(await resolveAcceptanceLedger(primary, own), own);
    const nested = path.join(primary, 'release-artifacts', 'implementation');
    git(primary, 'worktree', 'add', '-q', '--detach', nested, 'HEAD');
    assert.equal(await resolveAcceptanceLedger(nested, own), own);
    assert.equal(await resolveAcceptanceLedger(nested, await ledger(nested)), await ledgerPath(nested));
    const other = await repository('other-project'), unrelated = await ledger(other);
    await assert.rejects(resolveAcceptanceLedger(primary, unrelated), /same Git project|this Git project/);
    await assert.rejects(resolveAcceptanceLedger(nested, unrelated), /same Git project|this Git project/);
    const nonRoot = path.join(primary, 'release-artifacts', 'stray');
    await fs.mkdir(nonRoot); await assert.rejects(resolveAcceptanceLedger(primary, await ledger(nonRoot)));
    await assert.rejects(resolveAcceptanceLedger(path.join(primary, 'release-artifacts'), own));
  } finally {
    const resolved = await fs.realpath(temporary);
    assert.equal(resolved, temporary);
    assert.ok(resolved.startsWith((await fs.realpath(os.tmpdir())) + path.sep));
    assert.ok(path.basename(resolved).startsWith('bb-ledger-path-'));
    await fs.rm(resolved, { recursive: true, force: true });
  }
});

async function ledgerPath(root: string) {
  return fs.realpath(path.join(root, 'release-artifacts', 'acceptance-state', 'billing.json'));
}
