import assert from "node:assert/strict";
import test from "node:test";
import {
  LearningCaptureStore,
  type LearningPageState,
} from "../src/content/player-monitor/learning-capture.ts";
import type { CurrentVideoContext } from "../src/shared/types/current-video-context.ts";

function state(): LearningPageState {
  return {
    navigationKey: "0:video-a",
    url: "https://www.bilibili.com/video/BV1234567890/?p=2",
    context: {
      kind: "video",
      bvid: "BV1234567890",
      cid: 42,
      currentPart: { page: 2 },
      title: "视频",
    } as CurrentVideoContext,
    video: {
      isConnected: true,
      currentTime: 12.5,
      duration: 60,
    } as HTMLVideoElement,
  };
}
test("learning captures real position without subtitle or AI state", () => {
  const store = new LearningCaptureStore();
  const page = state();
  const capture = store.capture("bookmark", page)!;
  assert.equal(capture.bookmarkMs, 12_500);
  assert.deepEqual(capture.part, { cid: "42", page: 2 });
  page.video!.currentTime = 19;
  assert.equal(store.check(capture.token, page)?.bookmarkMs, 12_500);
  assert.equal(
    store.capture("note", { ...page, video: null })?.bookmarkMs,
    null,
  );
});
test("learning navigation, part change, player replacement and expired captures cannot save late", () => {
  const store = new LearningCaptureStore();
  const page = state();
  const capture = store.capture("bookmark", page)!;
  assert.equal(
    store.check(capture.token, { ...page, navigationKey: "1:video-a" }),
    null,
  );
  assert.equal(
    store.check(capture.token, {
      ...page,
      url: "https://www.bilibili.com/video/BV1234567890/?p=1",
    }),
    null,
  );
  assert.equal(
    store.check(capture.token, {
      ...page,
      video: { ...page.video } as HTMLVideoElement,
    }),
    null,
  );
  assert.equal(store.check("unknown", page), null);
  for (let i = 0; i < 16; i++) store.capture("note", page);
  assert.equal(store.check(capture.token, page), null);
});
test("learning rejects guessed or unusable bookmark positions and mismatched pages", () => {
  for (const currentTime of [NaN, Infinity, -1, 61]) {
    const page = state();
    page.video!.currentTime = currentTime;
    assert.equal(new LearningCaptureStore().capture("bookmark", page), null);
  }
  const page = state();
  (page.context as CurrentVideoContext).cid = null;
  assert.equal(new LearningCaptureStore().capture("bookmark", page), null);
  assert.equal(
    new LearningCaptureStore().capture("note", {
      ...page,
      url: "https://example.com/video/BV1234567890/?p=2",
    }),
    null,
  );
});
