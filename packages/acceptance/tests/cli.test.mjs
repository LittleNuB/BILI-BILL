import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../cli.mjs';
import { checkOutputRoot, saveReport } from '../report.mjs';

test('an invalid report directory is rejected before pairing or any paid command', async () => {
  const artifacts = fileURLToPath(new URL('../../../release-artifacts/', import.meta.url));
  await mkdir(artifacts, { recursive: true });
  const directory = await mkdtemp(path.join(artifacts, 'cli-output-test-'));
  for (const action of ['run-plan', 'report']) await assert.rejects(main([action, '--extension-id', 'invalid', '--code', 'invalid', '--output', path.join(directory, 'absent')]), /ACCEPTANCE_OUTPUT_DIRECTORY_REQUIRED/);
  assert.equal(await checkOutputRoot(directory), directory);
  const saved = await saveReport({ plan: { id: 'synthetic', steps: [] }, planHash: 'synthetic', rows: [], evidence: {}, legacy: { tokens: 58493, calls: 32, callLimit: 48 } }, directory);
  assert.equal(JSON.parse(await readFile(path.join(saved.directory, 'report.json'), 'utf8')).legacy.tokens, 58493);
});
