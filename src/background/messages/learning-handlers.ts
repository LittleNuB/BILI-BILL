import type { RequestAction } from "../../shared/types/messages.ts";
import Dexie from "dexie";
import {
  canonicalLearning,
  learningAssert,
  learningError,
  learningId,
  learningInteger,
  validateLearningAsset,
  type LearningCapture,
  type LearningAsset,
  type LearningFilter,
  type LearningSourceRequest,
  type LearningSnapshot,
} from "../../shared/learning.ts";
import { db } from "../storage/db.ts";
import { LearningRepository } from "../storage/learning-repo.ts";

const repo = new LearningRepository(db);
export type LearningSourceResolver = (tabId: number, request: LearningSourceRequest) => Promise<{ snapshot: LearningSnapshot; bvid: string; cid: string; page: number }>;
const sources = new Map<string, { request: LearningSourceRequest; snapshot: LearningSnapshot; expires: number }>();
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
  resolveSource?: LearningSourceResolver,
) {
  try {
    switch (action) {
      case "LEARNING_LIST":
        return {
          success: true,
          data: await repo.list(params.offset as number | undefined, (params.filters ?? {}) as LearningFilter),
        };
      case "LEARNING_GET":
        return {
          success: true,
          data: (await repo.get(params.id as string)) ?? null,
        };
      case "LEARNING_DELETE":
        await repo.remove(params.epoch as number, params.id as string);
        return { success: true, data: true };
      case "LEARNING_EDIT":
        return { success: true, data: await repo.edit(params.epoch as number, params.id as string, params.expected, params.personal) };
      case "LEARNING_PREPARE": {
        learningAssert(tabId !== null, "stale_capture");
        learningAssert(
          params.kind === "note" || params.kind === "bookmark",
          "kind",
        );
        const epoch = (await repo.state()).meta.epoch;
        const capture = await fromPage(tabId, "CAPTURE_LEARNING_CONTEXT", {
          kind: params.kind,
          ...(params.positionMs !== undefined ? { positionMs: params.positionMs } : {}),
        });
        return {
          success: true,
          data: { epoch, capture },
        };
      }
      case "LEARNING_PREPARE_SOURCE": {
        learningAssert(tabId !== null && resolveSource, "stale_capture");
        const epoch = (await repo.state()).meta.epoch;
        const request = structuredClone(params.source) as LearningSourceRequest;
        learningAssert(request && typeof request.sourceIdentityKey === "string" && request.sourceIdentityKey.length <= 4096, "stale_capture");
        const capture = await fromPage(tabId, "CAPTURE_LEARNING_CONTEXT", { kind: "note" });
        const source = await resolveSource(tabId, request);
        learningAssert(capture.video.bvid === source.bvid && capture.part?.cid === source.cid && capture.part.page === source.page, "stale_capture");
        const current = await fromPage(tabId, "CHECK_LEARNING_CONTEXT", { token: capture.token });
        learningAssert(canonicalLearning(current) === canonicalLearning(capture), "stale_capture");
        const snapshot = source.snapshot;
        while (sources.size >= 16) sources.delete(sources.keys().next().value!);
        sources.set(`${tabId}:${capture.token}`, { request, snapshot, expires: Date.now() + 600_000 });
        return { success: true, data: { epoch, capture, snapshot, sourceRequest: request } };
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
              capture.kind === (asset.snapshot ? "note" : asset.kind) &&
              canonicalLearning(capture.video) ===
                canonicalLearning(asset.video) &&
              canonicalLearning(capture.part) ===
                canonicalLearning(asset.part) &&
              capture.bookmarkMs === asset.bookmarkMs,
            "stale_capture",
          );
          if (asset.snapshot) {
            const saved = sources.get(`${tabId}:${token}`);
            learningAssert(saved && saved.expires > Date.now() && resolveSource, "stale_capture");
            learningAssert(canonicalLearning(asset.snapshot) === canonicalLearning(saved.snapshot), "stale_capture");
            const source = await Dexie.ignoreTransaction(() => resolveSource(tabId, saved.request));
            learningAssert(source.bvid === asset.video.bvid && source.cid === asset.part?.cid && source.page === asset.part.page
              && canonicalLearning(source.snapshot) === canonicalLearning(saved.snapshot), "stale_capture");
            const latest = await fromPage(tabId, "CHECK_LEARNING_CONTEXT", { token });
            learningAssert(canonicalLearning(latest) === canonicalLearning(capture), "stale_capture");
          }
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
