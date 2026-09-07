import {
  canonicalLearning,
  learningAssert,
  learningId,
  newLearningId,
  type LearningAsset,
} from "../../shared/learning.ts";
import { db } from "../storage/db.ts";
import { LearningReturnStore } from "./learning-return-store.ts";

let returns: LearningReturnStore | undefined;
function returnStore() {
  return (returns ??= new LearningReturnStore(chrome.storage.session));
}
export async function navigateLearning(
  params: Record<string, unknown>,
  canSeek: (tabId: number, row: LearningAsset) => Promise<boolean>,
) {
  learningId(params.id);
  const row = await db.lgAssets.get(params.id);
  learningAssert(
    row && canonicalLearning(row) === canonicalLearning(params.expected),
    "stale_navigation",
  );
  const origin =
    (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id ??
    null;
  const url = `https://www.bilibili.com/video/${row.video.bvid}/${row.part ? `?p=${row.part.page}` : ""}`;
  // Opening a separate tab preserves playback on existing pages. No timestamp in the URL.
  const tab = await chrome.tabs.create({ url, active: true });
  learningAssert(tab.id !== undefined, "stale_navigation");
  const returnId = newLearningId();
  const entry = {
    tab: tab.id,
    token: null as string | null,
    origin,
    expires: Date.now() + 600_000,
  };
  await returnStore().put(returnId, entry);
  const positionMs =
    row.bookmarkMs ?? row.snapshot?.citations[0]?.fromMs ?? null;
  if (positionMs === null || !row.part)
    return { returnId, message: "已打开来源视频" };
  const target = {
    bvid: row.video.bvid,
    cid: row.part.cid,
    page: row.part.page,
    positionMs,
  };
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      const current = await chrome.tabs.get(tab.id);
      const parsed = new URL(
        current.pendingUrl ?? current.url ?? "about:blank",
      );
      if (
        parsed.hostname !== "www.bilibili.com" ||
        parsed.pathname.split("/")[2] !== row.video.bvid ||
        Number(parsed.searchParams.get("p") ?? 1) !== row.part.page
      )
        break;
      const response = await chrome.tabs.sendMessage(
        tab.id,
        { action: "PREPARE_LEARNING_JUMP", target },
        { frameId: 0 },
      );
      if (response?.capture?.token) {
        const stillSaved = await db.lgAssets.get(row.id);
        if (
          !stillSaved ||
          canonicalLearning(stillSaved) !== canonicalLearning(row)
        )
          break;
        if (row.snapshot && !(await canSeek(tab.id, row)))
          return {
            returnId,
            message: "已打开来源；当前原句版本未确认，未改变播放位置。",
          };
        entry.token = response.capture.token;
        // Persist before seeking so worker suspension cannot orphan a completed jump.
        await returnStore().put(returnId, entry);
        const jumped = await chrome.tabs.sendMessage(
          tab.id,
          { action: "EXECUTE_LEARNING_JUMP", token: entry.token },
          { frameId: 0 },
        );
        if (jumped?.capture?.ok)
          return { returnId, message: "已定位到保存的位置" };
        break;
      }
    } catch {
      /* A new tab may not have loaded the content script yet. */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { returnId, message: "已打开来源；播放器暂未就绪，未改变播放位置。" };
}
export async function returnLearning(id: unknown) {
  learningId(id);
  const entry = await returnStore().get(id);
  learningAssert(entry && entry.expires > Date.now(), "stale_navigation");
  let positionRestored = !entry.token;
  if (entry.token) {
    try {
      const result = await chrome.tabs.sendMessage(
        entry.tab,
        { action: "RETURN_LEARNING_JUMP", token: entry.token },
        { frameId: 0 },
      );
      positionRestored = result?.capture?.ok === true;
    } catch {
      positionRestored = false;
    }
  }
  if (entry.origin !== null)
    await chrome.tabs.update(entry.origin, { active: true });
  await returnStore().put(id, null);
  return {
    message: positionRestored
      ? "已返回"
      : "已返回笔记；视频状态已变化，未调整播放位置。",
  };
}
