import test from 'node:test';
import assert from 'node:assert/strict';
import { screenshotCrop, type PlayerRectangle } from '../src/shared/player-screenshot.ts';
const before: PlayerRectangle = { x: 20, y: 100, width: 640, height: 360, viewportWidth: 1000, viewportHeight: 700,
  anchor: { bvid: 'BV1234567890', cid: '42', page: 1, title: '截图', timeMs: 1000, capturedAt: 100, method: 'page-crop' } };
test('page capture crops only player at actual viewport scale and binds fresh capture interval', () => {
  const after = { ...before, anchor: { ...before.anchor, timeMs: 1180, capturedAt: 280 } };
  assert.deepEqual(screenshotCrop(before, after, 1500, 1050), { x: 30, y: 150, width: 960, height: 540 });
  assert.throws(() => screenshotCrop(before, { ...after, x: 100 }, 1500, 1050), /capture_moved/);
  assert.throws(() => screenshotCrop(before, { ...after, anchor: { ...after.anchor, page: 2 } }, 1500, 1050), /stale_capture/);
  assert.throws(() => screenshotCrop(before, { ...after, anchor: { ...after.anchor, timeMs: 99000 } }, 1500, 1050), /capture_moved/);
  assert.throws(() => screenshotCrop({ ...before, y: -1 }, after, 1500, 1050), /capture_visible/);
  assert.throws(() => screenshotCrop(before, after, 1500, 2000), /capture_scale/);
});
