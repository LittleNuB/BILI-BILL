import assert from 'node:assert/strict';
import test from 'node:test';
import { NAV_ITEMS, DEFAULT_DASHBOARD_TAB, dashboardIndexForHash } from '../dashboard/navigation.ts';

test('knowledge is the default; favorites and retained tools have separate navigation groups', () => {
  assert.equal(NAV_ITEMS[DEFAULT_DASHBOARD_TAB].id, 'video-wiki');
  assert.equal(NAV_ITEMS[dashboardIndexForHash('')].group, 'knowledge');
  assert.equal(NAV_ITEMS[dashboardIndexForHash('#smart-favorites')].group, 'sources');
  for (const id of ['overview', 'dynamic-bill', 'preference', 'creator', 'behavior', 'experiments']) {
    assert.equal(NAV_ITEMS[dashboardIndexForHash('#' + id)].group, 'tools');
  }
  assert.equal(NAV_ITEMS[dashboardIndexForHash('#settings')].group, 'settings');
  assert.equal(dashboardIndexForHash('#unknown'), DEFAULT_DASHBOARD_TAB);
  assert.equal(new Set(NAV_ITEMS.map(row => row.id)).size, NAV_ITEMS.length);
});
