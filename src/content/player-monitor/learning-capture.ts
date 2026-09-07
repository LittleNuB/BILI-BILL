import {
  newLearningId,
  type LearningAsset,
  type LearningCapture,
} from "../../shared/learning.ts";
import type { CurrentVideoContextResult } from "../../shared/types/current-video-context.ts";

export interface LearningPageState {
  context: CurrentVideoContextResult | null;
  navigationKey: string;
  video: HTMLVideoElement | null;
  url: string;
}
export class LearningCaptureStore {
  private captures = new Map<
    string,
    {
      capture: LearningCapture;
      navigationKey: string;
      video: HTMLVideoElement | null;
      expiresAt: number;
    }
  >();
  capture(
    kind: LearningAsset["kind"],
    state: LearningPageState,
  ): LearningCapture | null {
    if (kind !== "note" && kind !== "bookmark") return null;
    const context = state.context;
    if (
      !context ||
      context.kind !== "video" ||
      !matchesPage(context, state.url)
    )
      return null;
    const part =
      Number.isSafeInteger(context.cid) && context.cid! > 0
        ? { cid: String(context.cid), page: context.currentPart.page }
        : null;
    let bookmarkMs: number | null = null;
    if (kind === "bookmark") {
      const video = state.video;
      if (
        !part ||
        !video?.isConnected ||
        !Number.isFinite(video.currentTime) ||
        !Number.isFinite(video.duration) ||
        video.duration <= 0 ||
        video.currentTime < 0 ||
        video.currentTime > video.duration
      )
        return null;
      bookmarkMs = Math.floor(video.currentTime * 1000);
    }
    const capture: LearningCapture = {
      token: newLearningId(),
      kind,
      video: { bvid: context.bvid, title: context.title ?? "" },
      part,
      bookmarkMs,
    };
    while (this.captures.size >= 16)
      this.captures.delete(this.captures.keys().next().value!);
    this.captures.set(capture.token, {
      capture,
      navigationKey: state.navigationKey,
      video: state.video,
      expiresAt: Date.now() + 600_000,
    });
    return structuredClone(capture);
  }
  check(token: string, state: LearningPageState): LearningCapture | null {
    const saved = this.captures.get(token);
    const context = state.context;
    if (
      !saved ||
      saved.expiresAt < Date.now() ||
      saved.navigationKey !== state.navigationKey ||
      context?.kind !== "video" ||
      !matchesPage(context, state.url) ||
      context.bvid !== saved.capture.video.bvid ||
      (saved.capture.part !== null &&
        (String(context.cid) !== saved.capture.part.cid ||
          context.currentPart.page !== saved.capture.part.page))
    )
      return null;
    if (
      saved.capture.kind === "bookmark" &&
      (state.video !== saved.video ||
        !state.video?.isConnected ||
        !Number.isFinite(state.video.duration) ||
        saved.capture.bookmarkMs! > state.video.duration * 1000)
    )
      return null;
    return structuredClone(saved.capture);
  }
}
function matchesPage(
  context: Extract<CurrentVideoContextResult, { kind: "video" }>,
  href: string,
): boolean {
  try {
    const url = new URL(href);
    return (
      url.protocol === "https:" &&
      (url.hostname === "www.bilibili.com" ||
        url.hostname === "bilibili.com") &&
      url.pathname.split("/")[2] === context.bvid &&
      Number(url.searchParams.get("p") ?? 1) === context.currentPart.page
    );
  } catch {
    return false;
  }
}
