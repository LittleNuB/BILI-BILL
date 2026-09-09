import assert from "node:assert/strict";
import test from "node:test";
import {
  LearningCaptureStore,
  learningRuntimeMatches,
  type LearningPageState,
} from "../src/content/player-monitor/learning-capture.ts";
import type { CurrentVideoContext } from "../src/shared/types/current-video-context.ts";
import { requestLearning } from "../src/content/player-monitor/learning-request.ts";
import { LearningJumpStore } from "../src/content/player-monitor/learning-jump.ts";

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
test('quick-note timestamp remains at mode entry while playback advances and rejects invalid offsets', () => {
  const page = state(); const store = new LearningCaptureStore();
  page.video!.currentTime = 30;
  const capture = store.capture('bookmark', page, 12500)!;
  assert.equal(capture.bookmarkMs, 12500);
  assert.equal(page.video!.currentTime, 30);
  page.video!.currentTime = 42;
  assert.equal(store.check(capture.token, page)?.bookmarkMs, 12500);
  for (const offset of [-1, 60001, NaN, 1.5]) assert.equal(store.capture('bookmark', page, offset), null);
});
test("learning confirmed jump is idempotent and return restores the original position without playback", () => {
  const page = state();
  const store = new LearningJumpStore();
  const token = store.prepare({ bvid: 'BV1234567890', cid: '42', page: 2, positionMs: 30000 }, page);
  assert.equal(page.video!.currentTime, 12.5);
  assert.throws(() => store.execute(token, page, true), /stale_jump/);
  store.execute(token, page);
  assert.equal(page.video!.currentTime, 30);
  page.video!.currentTime = 31;
  store.execute(token, page);
  assert.equal(page.video!.currentTime, 31);
  store.execute(token, page, true);
  assert.equal(page.video!.currentTime, 12.5);
});

test("learning return rejects changed player, navigation, part and out-of-range target", () => {
  for (const change of ['player', 'navigation', 'part', 'media'] as const) {
    const page = state();
    const store = new LearningJumpStore();
    const token = store.prepare({ bvid: 'BV1234567890', cid: '42', page: 2, positionMs: 30000 }, page);
    store.execute(token, page);
    if (change === 'player') page.video = { ...page.video } as HTMLVideoElement;
    if (change === 'navigation') page.navigationKey = 'new-navigation';
    if (change === 'part') (page.context as CurrentVideoContext).cid = 43;
    if (change === 'media') Object.defineProperty(page.video, 'currentSrc', { value: 'blob:new' });
    assert.throws(() => store.execute(token, page, true), /stale_jump/);
    assert.equal(page.video!.currentTime, 30);
  }
  assert.throws(() => new LearningJumpStore().prepare({ bvid: 'BV1234567890', cid: '42', page: 2, positionMs: 60001 }, state()), /stale_jump/);
});

test("learning live player identity and media source changes reject stale bookmarks", () => {
  const page = state();
  const context = page.context!;
  assert.equal(
    learningRuntimeMatches(context, {
      playerInfo: { bvid: "BV1234567890", cid: 42, p: 2 },
    }),
    true,
  );
  assert.equal(
    learningRuntimeMatches(context, {
      playerInfo: { bvid: "BV1234567890", cid: 43, p: 2 },
    }),
    false,
  );
  assert.equal(
    learningRuntimeMatches(context, {
      playerInfo: { bvid: "BV1234567890", cid: 42, p: 3 },
    }),
    false,
  );
  const store = new LearningCaptureStore();
  Object.defineProperty(page.video, "currentSrc", {
    value: "blob:original",
    configurable: true,
  });
  const capture = store.capture("bookmark", page)!;
  Object.defineProperty(page.video, "currentSrc", {
    value: "blob:replacement",
    configurable: true,
  });
  assert.equal(store.check(capture.token, page), null);
});
test("learning transport rejection exposes controlled Chinese copy and leaves caller retry data unchanged", async () => {
  const previous = globalThis.chrome;
  const params = { id: "same-action", note: "保留的草稿" };
  try {
    globalThis.chrome = {
      runtime: {
        sendMessage: async () => {
          throw Error("Extension context invalidated: secret runtime detail");
        },
      },
    } as unknown as typeof chrome;
    await assert.rejects(requestLearning("LEARNING_SAVE", params), {
      message: "连接已中断，请重试确认保存结果。",
    });
    assert.deepEqual(params, { id: "same-action", note: "保留的草稿" });
    globalThis.chrome.runtime.sendMessage = (async () => ({
      success: true,
      data: "acknowledged",
    })) as typeof chrome.runtime.sendMessage;
    assert.equal(
      await requestLearning("LEARNING_SAVE", params),
      "acknowledged",
    );
  } finally {
    globalThis.chrome = previous;
  }
});
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
