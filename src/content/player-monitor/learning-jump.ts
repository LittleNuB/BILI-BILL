import { learningAssert, learningInteger, newLearningId } from "../../shared/learning.ts";
import type { LearningPageState } from "./learning-capture.ts";

interface Target { bvid: string; cid: string; page: number; positionMs: number }
export class LearningJumpStore {
  private points = new Map<string, { target: Target; video: HTMLVideoElement; media: string; navigation: string; original: number; expires: number; done: boolean }>();
  prepare(target: Target, state: LearningPageState) {
    this.assertTarget(target, state);
    const token = newLearningId();
    while (this.points.size >= 16) this.points.delete(this.points.keys().next().value!);
    this.points.set(token, { target, video: state.video!, media: state.video!.currentSrc, navigation: state.navigationKey,
      original: state.video!.currentTime, expires: Date.now() + 600_000, done: false });
    return token;
  }
  execute(token: string, state: LearningPageState, returning = false) {
    const point = this.points.get(token);
    learningAssert(point && point.expires > Date.now() && point.navigation === state.navigationKey
      && state.video === point.video && state.video.currentSrc === point.media, "stale_jump");
    this.assertTarget(point.target, state);
    learningAssert(!returning || point.done, "stale_jump");
    const seconds = returning ? point.original : point.target.positionMs / 1000;
    learningAssert(seconds <= point.video.duration, "stale_jump");
    if (!returning && point.done) return true;
    point.video.currentTime = seconds;
    point.done = !returning;
    return true;
  }
  private assertTarget(target: Target, state: LearningPageState) {
    const context = state.context;
    learningInteger(target.positionMs);
    learningAssert(context?.kind === "video" && context.bvid === target.bvid && String(context.cid) === target.cid && context.currentPart.page === target.page, "stale_jump");
    const video = state.video;
    learningAssert(video?.isConnected && Number.isFinite(video.duration) && video.duration > 0 && Number.isFinite(video.currentTime)
      && video.currentTime >= 0 && target.positionMs / 1000 <= video.duration, "stale_jump");
  }
}
