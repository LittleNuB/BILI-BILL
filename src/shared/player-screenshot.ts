import { requireKnowledge } from './open-knowledge/format.ts';
import { validateAnchor, type NoteAnchor } from './open-knowledge/captures.ts';
export interface PlayerRectangle { x: number; y: number; width: number; height: number; viewportWidth: number; viewportHeight: number; anchor: NoteAnchor }
export function screenshotCrop(before: PlayerRectangle, after: PlayerRectangle, width: number, height: number) {
  validateAnchor(before.anchor); validateAnchor(after.anchor);
  const values = [before.x, before.y, before.width, before.height, before.viewportWidth, before.viewportHeight, width, height];
  requireKnowledge(values.every(Number.isFinite) && before.width > 0 && before.height > 0 && width > 0 && height > 0, 'capture');
  requireKnowledge(before.x >= 0 && before.y >= 0 && before.x + before.width <= before.viewportWidth + 1
    && before.y + before.height <= before.viewportHeight + 1, 'capture_visible');
  requireKnowledge(['x', 'y', 'width', 'height', 'viewportWidth', 'viewportHeight'].every(key => Math.abs((before[key as keyof PlayerRectangle] as number) - (after[key as keyof PlayerRectangle] as number)) < 1), 'capture_moved');
  requireKnowledge(before.anchor.bvid === after.anchor.bvid && before.anchor.cid === after.anchor.cid && before.anchor.page === after.anchor.page, 'stale_capture');
  requireKnowledge(before.anchor.timeMs !== null && after.anchor.timeMs !== null && after.anchor.timeMs >= before.anchor.timeMs
    && after.anchor.timeMs - before.anchor.timeMs <= 2000 && after.anchor.capturedAt >= before.anchor.capturedAt
    && after.anchor.capturedAt - before.anchor.capturedAt < 2500, 'capture_moved');
  const scaleX = width / before.viewportWidth, scaleY = height / before.viewportHeight;
  requireKnowledge(scaleX > 0 && scaleY > 0 && Math.abs(scaleX - scaleY) < 0.05, 'capture_scale');
  return { x: Math.ceil(before.x * scaleX), y: Math.ceil(before.y * scaleY),
    width: Math.floor(before.width * scaleX), height: Math.floor(before.height * scaleY) };
}
