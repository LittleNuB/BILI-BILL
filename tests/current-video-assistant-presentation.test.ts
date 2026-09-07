import assert from 'node:assert/strict';
import test from 'node:test';
import { compactSummaryText } from '../src/content/player-monitor/assistant-presentation.ts';

const summary = {
  status: 'ready', current: true, priorGenerated: false,
  summarySentences: [{ text: '  A saved sentence.  ' }, { text: 'Another sentence.' }],
} as any;

test('compact assistant shows only current ready summary text, never progress or stale results', () => {
  assert.equal(compactSummaryText(summary, true), 'A saved sentence. Another sentence.');
  assert.equal(compactSummaryText(summary, false), null);
  assert.equal(compactSummaryText(null, true), null);
  for (const status of ['loading', 'generating', 'cancelled', 'error', 'no_text', 'not_requested'])
    assert.equal(compactSummaryText({ ...summary, status }, true), null);
  assert.equal(compactSummaryText({ ...summary, current: false }, true), null);
  assert.equal(compactSummaryText({ ...summary, priorGenerated: true }, true), null);
  assert.equal(compactSummaryText({ ...summary, summarySentences: [] }, true), null);
});
