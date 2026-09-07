import type { RequestAction } from "../../shared/types/messages.ts";
import {
  canonicalLearning,
  learningAssert,
  learningError,
  learningId,
  learningInteger,
  validateLearningAsset,
  type LearningCapture,
  type LearningAsset,
} from "../../shared/learning.ts";
import { db } from "../storage/db.ts";
import { LearningRepository } from "../storage/learning-repo.ts";

const repo = new LearningRepository(db);
const operations = new Map<
  string,
  {
    controller: AbortController;
    phase: string;
    promise: Promise<LearningAsset>;
    signature: string;
  }
>();
async function fromPage(
  tabId: number,
  action: string,
  params: Record<string, unknown>,
): Promise<LearningCapture> {
  const tab = await chrome.tabs.get(tabId);
  const url = new URL(tab.url ?? "about:blank");
  learningAssert(
    url.protocol === "https:" &&
      ["www.bilibili.com", "bilibili.com"].includes(url.hostname) &&
      url.pathname.startsWith("/video/"),
    "stale_capture",
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      chrome.tabs.sendMessage(tabId, { action, ...params }, { frameId: 0 }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error("stale_capture")), 3000);
      }),
    ]);
    learningAssert(
      response?.capture && typeof response.capture === "object",
      "stale_capture",
    );
    const capture = response.capture as LearningCapture;
    learningId(capture.token);
    learningAssert(
      capture.video.bvid === url.pathname.split("/")[2] &&
        (capture.part === null ||
          capture.part.page === Number(url.searchParams.get("p") ?? 1)),
      "stale_capture",
    );
    return capture;
  } finally {
    clearTimeout(timer);
  }
}

export async function handleLearningRequest(
  action: RequestAction,
  params: Record<string, unknown> = {},
  tabId: number | null = null,
) {
  try {
    switch (action) {
      case "LEARNING_LIST":
        return {
          success: true,
          data: await repo.list(params.offset as number | undefined),
        };
      case "LEARNING_GET":
        return {
          success: true,
          data: (await repo.get(params.id as string)) ?? null,
        };
      case "LEARNING_DELETE":
        await repo.remove(params.epoch as number, params.id as string);
        return { success: true, data: true };
      case "LEARNING_PREPARE": {
        learningAssert(tabId !== null, "stale_capture");
        learningAssert(
          params.kind === "note" || params.kind === "bookmark",
          "kind",
        );
        const capture = await fromPage(tabId, "CAPTURE_LEARNING_CONTEXT", {
          kind: params.kind,
        });
        return {
          success: true,
          data: { epoch: (await repo.state()).meta.epoch, capture },
        };
      }
      case "LEARNING_CANCEL": {
        learningAssert(tabId !== null, "stale_capture");
        learningId(params.id);
        const operation = operations.get(`${tabId}:${params.id}`);
        if (operation?.phase === "preparing") operation.controller.abort();
        return {
          success: true,
          data: { phase: operation?.phase ?? "settled" },
        };
      }
      case "LEARNING_SAVE": {
        learningAssert(tabId !== null, "stale_capture");
        validateLearningAsset(params.asset);
        learningId(params.token);
        learningInteger(params.epoch);
        const asset = params.asset;
        const token = params.token;
        const key = `${tabId}:${asset.id}`;
        const signature = canonicalLearning({ epoch: params.epoch, asset });
        const existing = operations.get(key);
        if (existing) {
          learningAssert(
            existing.signature === signature,
            "save_identity_conflict",
          );
          return { success: true, data: await existing.promise };
        }
        learningAssert(operations.size < 16, "busy_retry");
        const controller = new AbortController();
        const operation = {
          controller,
          phase: "preparing",
          signature,
          promise: null as unknown as Promise<LearningAsset>,
        };
        const assertCurrent = async () => {
          const capture = await fromPage(tabId, "CHECK_LEARNING_CONTEXT", {
            token,
          });
          learningAssert(
            capture.token === token &&
              capture.kind === asset.kind &&
              canonicalLearning(capture.video) ===
                canonicalLearning(asset.video) &&
              canonicalLearning(capture.part) ===
                canonicalLearning(asset.part) &&
              capture.bookmarkMs === asset.bookmarkMs,
            "stale_capture",
          );
        };
        operation.promise = repo.save(params.epoch, asset, {
          signal: controller.signal,
          assertCurrent,
          onPhase: (phase) => {
            operation.phase = phase;
          },
        });
        operations.set(key, operation);
        try {
          return { success: true, data: await operation.promise };
        } finally {
          operations.delete(key);
        }
      }
      default:
        throw Error("unknown_action");
    }
  } catch (error) {
    return { success: false, error: learningError(error) };
  }
}
