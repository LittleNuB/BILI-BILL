import Dexie from "dexie";
import type { BiliAnalyticsDB } from "./db.ts";
import {
  LEARNING_MAX_ASSETS,
  LEARNING_MAX_BYTES,
  canonicalLearning,
  learningAssert,
  learningBytes,
  learningId,
  learningInteger,
  validateLearningAsset,
  type LearningAsset,
  type LearningMeta,
  type LearningList,
} from "../../shared/learning.ts";

interface SaveOptions {
  signal?: AbortSignal;
  assertCurrent?: () => Promise<void>;
  onPhase?: (phase: "preparing" | "committing" | "committed") => void;
}
const initial = (): LearningMeta => ({ key: "state", epoch: 0, revision: 0 });
const notCancelled = (signal?: AbortSignal) =>
  learningAssert(!signal?.aborted, "cancelled");

export class LearningRepository {
  private database: BiliAnalyticsDB;
  constructor(database: BiliAnalyticsDB) {
    this.database = database;
  }

  async state() {
    const db = this.database;
    return db.transaction("r", db.lgAssets, db.lgMeta, async () => ({
      assets: await db.lgAssets.toArray(),
      meta: (await db.lgMeta.get("state")) ?? initial(),
    }));
  }
  async get(id: string) {
    learningId(id);
    return this.database.lgAssets.get(id);
  }
  async list(offset = 0): Promise<LearningList> {
    learningInteger(offset);
    const { assets, meta } = await this.state();
    assets.sort(
      (a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id),
    );
    return {
      epoch: meta.epoch,
      total: assets.length,
      offset,
      items: assets.slice(offset, offset + 30).map((row) => ({
        id: row.id,
        kind: row.kind,
        title: row.personal.title,
        preview: row.personal.note.slice(0, 180),
        videoTitle: row.video.title,
        page: row.part?.page ?? null,
        bookmarkMs: row.bookmarkMs,
        createdAt: row.createdAt,
      })),
    };
  }
  async save(
    epoch: number,
    input: unknown,
    options: SaveOptions,
  ): Promise<LearningAsset> {
    learningInteger(epoch);
    validateLearningAsset(input);
    const asset = structuredClone(input);
    const db = this.database;
    for (let attempt = 0; attempt < 4; attempt++) {
      options.onPhase?.("preparing");
      notCancelled(options.signal);
      const before = await this.state();
      learningAssert(before.meta.epoch === epoch, "stale_epoch");
      const prior = before.assets.find((row) => row.id === asset.id);
      if (prior) {
        learningAssert(
          canonicalLearning(prior) === canonicalLearning(asset),
          "save_identity_conflict",
        );
        return prior;
      }
      learningAssert(
        before.assets.length < LEARNING_MAX_ASSETS,
        "capacity_count",
      );
      learningAssert(
        learningBytes([...before.assets, asset]) <= LEARNING_MAX_BYTES,
        "capacity_bytes",
      );
      learningAssert(options.assertCurrent, "stale_capture");
      await options.assertCurrent();
      notCancelled(options.signal);
      const applied = await db.transaction(
        "rw",
        db.lgAssets,
        db.lgMeta,
        async () => {
          const current = (await db.lgMeta.get("state")) ?? initial();
          learningAssert(current.epoch === epoch, "stale_epoch");
          if (current.revision !== before.meta.revision) return false;
          // A fresh content-page check stays inside the write boundary; it is not an AI/subtitle request.
          await Dexie.waitFor(options.assertCurrent!());
          notCancelled(options.signal);
          learningInteger(current.revision + 1);
          options.onPhase?.("committing");
          await db.lgAssets.add(asset);
          await db.lgMeta.put({ ...current, revision: current.revision + 1 });
          return true;
        },
      );
      if (applied) {
        options.onPhase?.("committed");
        const persisted = await this.get(asset.id);
        learningAssert(
          persisted &&
            canonicalLearning(persisted) === canonicalLearning(asset),
          "readback",
        );
        return persisted;
      }
    }
    throw new Error("busy_retry");
  }
  async remove(epoch: number, id: string): Promise<void> {
    learningInteger(epoch);
    learningId(id);
    const db = this.database;
    await db.transaction("rw", db.lgAssets, db.lgMeta, async () => {
      const meta = (await db.lgMeta.get("state")) ?? initial();
      learningAssert(meta.epoch === epoch, "stale_epoch");
      if (!(await db.lgAssets.get(id))) return;
      learningInteger(meta.revision + 1);
      await db.lgAssets.delete(id);
      await db.lgMeta.put({ ...meta, revision: meta.revision + 1 });
    });
    learningAssert(!(await this.get(id)), "delete_readback");
  }
}
