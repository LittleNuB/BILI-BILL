import { db } from "../../../src/background/storage/db.ts";
import { LearningRepository } from "../../../src/background/storage/learning-repo.ts";
import {
  learningNotCancelled,
  learningYield,
  mergeLearningAssets,
} from "../../../src/shared/learning-backup.ts";
import { decodeWikiBackup, encodeWikiBackup } from '../../../src/shared/video-wiki-backup.ts';
import { VideoWikiRepository, type WikiVersion } from '../../../src/background/storage/video-wiki-repo.ts';
import type { WikiState } from '../../../src/shared/video-wiki.ts';
import {
  learningAssert,
  learningBytes,
  newLearningId,
  type LearningAsset,
  type LearningMeta,
} from "../../../src/shared/learning.ts";

const repo = new LearningRepository(db);
const wikiRepo = new VideoWikiRepository(db);
let active: { id: string; controller: AbortController; phase: string } | null =
  null;
let prepared: {
  token: string;
  epoch: number;
  assets: LearningAsset[];
  wiki: WikiState | null;
  version: WikiVersion;
  expires: number;
} | null = null;
let clearPrepared: {
  token: string;
  meta: LearningMeta;
  wikiRevision: number;
  expires: number;
} | null = null;

self.onmessage = async ({ data }) => {
  const { id, action } = data;
  if (action === "cancel") {
    if (
      active &&
      active.id === id &&
      active.phase !== "committing" &&
      active.phase !== "committed"
    )
      active.controller.abort();
    return;
  }
  if (active) {
    self.postMessage({ id, error: "另一项操作正在进行。" });
    return;
  }
  const operation = {
    id,
    controller: new AbortController(),
    phase: "preparing",
  };
  active = operation;
  const signal = operation.controller.signal;
  const phase = (value: string) => {
    operation.phase = value;
    self.postMessage({ id, phase: value });
  };
  try {
    phase("preparing");
    let result: unknown;
    if (action === "export") {
      const { assets, wiki } = await wikiRepo.state();
      phase("encoding");
      const text = await encodeWikiBackup(assets, wiki, signal);
      result = { file: new Blob([text], { type: "application/json" }) };
    } else if (action === "preflight") {
      prepared = null;
      learningAssert(data.file instanceof Blob, "format");
      phase("decoding");
      const { assets, wiki } = await decodeWikiBackup(data.file, signal);
      const before = await wikiRepo.state();
      phase("merging");
      const rows = await mergeLearningAssets(before.assets, assets, signal);
      await learningYield();
      learningNotCancelled(signal);
      const token = newLearningId();
      prepared = {
        token,
        epoch: before.meta.epoch,
        assets,
        wiki,
        version: { epoch: before.meta.epoch, assetRevision: before.meta.revision, wikiRevision: before.wiki.revision },
        expires: Date.now() + 600_000,
      };
      result = {
        token,
        incoming: assets.length,
        added: rows.length - before.assets.length,
        total: rows.length,
        bytes: learningBytes(rows),
        organization: wiki ? { pages: wiki.pages.filter(page => !page.deleted).length, deleted: wiki.pages.filter(page => page.deleted).length, topics: wiki.topics.length } : null,
      };
    } else if (action === "restore") {
      const value = prepared;
      learningAssert(
        value && value.token === data.token && value.expires > Date.now(),
        "stale_preview",
      );
      result = value.wiki ? await wikiRepo.restore(value.version, value.assets, value.wiki, signal, () => phase('committing')) : await repo.restore(value.epoch, value.assets, {
        signal,
        onPhase: phase,
      });
      phase('committed');
      prepared = null;
    } else if (action === "clearPreview") {
      const { assets, meta, wiki } = await wikiRepo.state();
      clearPrepared = {
        token: newLearningId(),
        meta,
        wikiRevision: wiki.revision,
        expires: Date.now() + 600_000,
      };
      result = { token: clearPrepared.token, count: assets.length };
    } else if (action === "clear") {
      const value = clearPrepared;
      learningAssert(
        value && value.token === data.token && value.expires > Date.now(),
        "stale_preview",
      );
      await learningYield();
      learningNotCancelled(signal);
      phase("committing");
      await repo.clear(value.meta.epoch, value.meta.revision, value.wikiRevision);
      phase("committed");
      clearPrepared = null;
      prepared = null;
      result = true;
    } else throw Error("unknown_action");
    self.postMessage({ id, result });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const message =
      code === "cancelled"
        ? "已取消，原有内容未改变。"
        : code === 'wiki_capacity' ? '视频 Wiki 组织状态超过上限，原有内容未改变。'
        : code.includes("capacity")
          ? "恢复后将超过 1000 条或 10 MiB，原有内容未改变。"
          : code.includes("stale")
            ? "数据或预览已变化，请重新预览后确认。"
            : code === "busy_retry"
              ? "其他窗口正在修改，请重新预览后重试。"
              : action === "preflight"
                ? "无法读取此备份，请选择由 Bili-Bill 导出的完整学习备份。"
                : "操作未完成，请刷新后确认。原有内容不会被覆盖。";
    self.postMessage({ id, error: message });
  } finally {
    if (active === operation) active = null;
  }
};
