import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyWorkerModuleGraph } from '../scripts/verify-worker-module-graph.ts';
const chunk = (imports: string[] = [], dynamicImports: string[] = []) => ({ type: 'chunk' as const, imports, dynamicImports });
test('MV3 build checks the complete reachable static graph, allowing unrelated dashboard dynamic imports', () => {
  const bundle = { 'background.js': chunk(['db.js']), 'db.js': chunk(['background.js']), 'dashboard.js': chunk([], ['chart.js']) };
  assert.equal(verifyWorkerModuleGraph(bundle as any, 'background.js'), 2);
});
test('MV3 build rejects direct and nested dynamic imports', () => {
  for (const bundle of [{ 'background.js': chunk([], ['chat.js']) }, { 'background.js': chunk(['db.js']), 'db.js': chunk([], ['memory.js']) }]) {
    assert.throws(() => verifyWorkerModuleGraph(bundle as any, 'background.js'), /cannot dynamically import/);
  }
});
test('MV3 build rejects missing or external worker dependencies', () => {
  assert.throws(() => verifyWorkerModuleGraph({} as any, 'background.js'), /Missing worker/);
  assert.throws(() => verifyWorkerModuleGraph({ 'background.js': chunk(['remote.js']) } as any, 'background.js'), /not packaged/);
});
