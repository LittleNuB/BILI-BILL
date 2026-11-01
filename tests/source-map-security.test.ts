import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { SourceMapConsumer, SourceMapGenerator } = createRequire(import.meta.url)('source-map-js');
const flat = { version: 3, sources: ['input.ts'], names: [], mappings: 'AAAA', sourcesContent: ['const n = 1;'] };
const indexed = (line: unknown, column: unknown = 0, map = flat) => ({
  version: 3, sections: [{ offset: { line, column }, map }],
});

test('locked source-map consumer rejects excessive and invalid section offsets before expansion', () => {
  for (const line of [Number.MAX_SAFE_INTEGER, Infinity, NaN, -1, 0.5, '4']) {
    assert.throws(() => new SourceMapConsumer(indexed(line)), /Section offset/);
  }
  for (const column of [-1, Infinity, 0.5, '4']) {
    assert.throws(() => new SourceMapConsumer(indexed(0, column)), /Section offset/);
  }
});

test('locked source-map consumer also bounds cumulative nested offsets', () => {
  const nested = { version: 3, sections: [{ offset: { line: 7_000_000, column: 0 }, map: flat }] };
  assert.throws(() => new SourceMapConsumer(indexed(7_000_000, 0, nested)), /including offsets of nested sections/);
});

test('ordinary maps preserve source positions and small indexed offsets', () => {
  const positions: { generatedLine: number; originalLine: number; source: string }[] = [];
  new SourceMapConsumer(indexed(4)).eachMapping((entry: { generatedLine: number; originalLine: number; source: string }) => {
    positions.push({ generatedLine: entry.generatedLine, originalLine: entry.originalLine, source: entry.source });
  });
  assert.deepEqual(positions, [{ generatedLine: 5, originalLine: 1, source: 'input.ts' }]);
  const consumer = new SourceMapConsumer(flat);
  const output = SourceMapGenerator.fromSourceMap(consumer).toJSON();
  const restored = new SourceMapConsumer(output);
  assert.deepEqual(restored.originalPositionFor({ line: 1, column: 0 }), {
    source: 'input.ts', line: 1, column: 0, name: null,
  });
  assert.equal(restored.sourceContentFor('input.ts'), 'const n = 1;');
});
