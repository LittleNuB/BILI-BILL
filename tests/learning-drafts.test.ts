import assert from "node:assert/strict";
import test from "node:test";
import {
  LearningDraftStore,
  learningDraftKey,
} from "../src/content/player-monitor/learning-drafts.ts";
import { LearningReturnStore } from "../src/background/messages/learning-return-store.ts";
import type { LearningPrepared } from "../src/shared/learning.ts";

const prepared = (bvid = "BV1234567890", cid = "42", page = 1) =>
  ({
    epoch: 0,
    capture: {
      token: "a".repeat(64),
      kind: "note",
      video: { bvid, title: "合成视频" },
      part: { cid, page },
      bookmarkMs: null,
    },
  }) as LearningPrepared;

test("draft identity isolates video, part and kind while retaining same-video retry", () => {
  const original = learningDraftKey("note", prepared());
  assert.equal(original, learningDraftKey("note", prepared()));
  assert.notEqual(original, learningDraftKey("note", prepared("BV0987654321")));
  assert.notEqual(
    original,
    learningDraftKey("note", prepared(undefined, "43", 2)),
  );
  assert.notEqual(original, learningDraftKey("bookmark", prepared()));
  const store = new LearningDraftStore();
  store.put(original, { title: "A", note: "原视频理解" });
  assert.equal(
    store.get(learningDraftKey("note", prepared("BV0987654321"))),
    undefined,
  );
  assert.equal(store.get(original)?.note, "原视频理解");
});

test("draft bounds reject new content without silently evicting existing user text", () => {
  const store = new LearningDraftStore();
  for (let index = 0; index < 16; index++)
    store.put(String(index), { title: "", note: "保留" });
  assert.throws(
    () => store.put("overflow", { title: "", note: "new" }),
    /草稿已满/,
  );
  assert.equal(store.get("0")?.note, "保留");
  assert.throws(
    () => store.put("0", { title: "", note: "x".repeat(30 * 1048576) }),
    /草稿空间已满/,
  );
  assert.equal(store.get("0")?.note, "保留");
  store.delete("0");
  store.put("new", { title: "", note: "新的草稿" });
  assert.equal(store.get("new")?.note, "新的草稿");
});

test("return points survive worker recreation, expire and retain concurrent updates within bound", async () => {
  const data: Record<string, unknown> = {};
  const storage = {
    get: async (key: string) => ({ [key]: structuredClone(data[key]) }),
    set: async (value: Record<string, unknown>) => {
      Object.assign(data, structuredClone(value));
    },
  } as Pick<chrome.storage.StorageArea, "get" | "set">;
  const store = new LearningReturnStore(storage);
  const point = {
    tab: 3,
    token: "a".repeat(64),
    origin: 1,
    expires: Date.now() + 600000,
  };
  await store.put("first", point);
  const restarted = new LearningReturnStore(storage);
  assert.deepEqual(await restarted.get("first"), point);
  await Promise.all(
    Array.from({ length: 18 }, (_, index) =>
      restarted.put(String(index), {
        ...point,
        expires: point.expires + index + 1,
      }),
    ),
  );
  assert.equal(
    Object.keys(data["bb-learning-return-points"] as object).length,
    16,
  );
  assert.equal(await restarted.get("first"), undefined);
  await restarted.put("expired", { ...point, expires: 1 });
  assert.equal(await restarted.get("expired"), undefined);
  await restarted.put("17", null);
  assert.equal(await restarted.get("17"), undefined);
});
