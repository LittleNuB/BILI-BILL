import test from 'node:test';
import assert from 'node:assert/strict';
import { fitAssistantRect, resizeAssistantRect, type ResizeEdge } from '../src/content/player-monitor/assistant-resize.ts';

test('all eight edges resize without moving the opposite edges', () => {
  const start = { left: 300, top: 200, width: 420, height: 620 };
  for (const edge of ['n','s','e','w','ne','nw','se','sw'] as ResizeEdge[]) {
    const next = resizeAssistantRect(start, edge, 30, 25, 1440, 1000);
    assert.equal(next.left, edge.includes('w') ? 330 : 300);
    assert.equal(next.top, edge.includes('n') ? 225 : 200);
    assert.equal(next.width, 420 + (edge.includes('e') ? 30 : edge.includes('w') ? -30 : 0));
    assert.equal(next.height, 620 + (edge.includes('s') ? 25 : edge.includes('n') ? -25 : 0));
  }
});
test('resizing respects minimum size and viewport bounds in every direction', () => {
  for (const [vw,vh] of [[1440,900],[390,480],[280,240]]) {
    for (const edge of ['n','s','e','w','ne','nw','se','sw'] as ResizeEdge[]) {
      for (const delta of [-10000,10000]) {
        const next = resizeAssistantRect({left:700,top:400,width:600,height:800},edge,delta,delta,vw,vh);
        assert.ok(next.left >= 12 && next.top >= 12);
        assert.ok(next.left + next.width <= vw - 12);
        assert.ok(next.top + next.height <= vh - 12);
        assert.ok(next.width >= Math.min(320,vw-24));
        assert.ok(next.height >= Math.min(360,vh-24));
      }
    }
  }
});
test('saved large size is fitted into a smaller viewport', () => {
  assert.deepEqual(fitAssistantRect({left:900,top:300,width:800,height:700},390,480),{left:12,top:12,width:366,height:456});
});
