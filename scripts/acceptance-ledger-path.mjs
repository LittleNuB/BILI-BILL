import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';

export async function resolveAcceptanceLedger(root, selected) {
  const current = await realpath(root), file = await realpath(selected);
  assert.equal(path.basename(file), 'billing.json');
  assert.equal(path.basename(path.dirname(file)), 'acceptance-state');
  const owner = await realpath(path.resolve(path.dirname(file), '../..'));
  assert.equal(path.basename(path.dirname(path.dirname(file))), 'release-artifacts');
  const git = (cwd, ...args) => execFileSync('git', ['rev-parse', ...args],
    { cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  assert.equal(await realpath(git(current, '--show-toplevel')), current);
  assert.equal(await realpath(git(owner, '--show-toplevel')), owner);
  const common = cwd => realpath(git(cwd, '--path-format=absolute', '--git-common-dir'));
  assert.equal(await common(current), await common(owner), 'The selected ledger must belong to this Git project.');
  return file;
}
