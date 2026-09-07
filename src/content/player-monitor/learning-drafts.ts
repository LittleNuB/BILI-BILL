import {
  canonicalLearning,
  LEARNING_MAX_BYTES,
  type LearningAsset,
  type LearningPrepared,
  type LearningSourceRequest,
} from "../../shared/learning.ts";

export interface LearningDraft {
  title: string;
  note: string;
  pending?: { prepared: LearningPrepared; asset: LearningAsset };
}
export function learningDraftKey(
  kind: LearningAsset["kind"],
  prepared: LearningPrepared,
  source?: LearningSourceRequest,
) {
  return canonicalLearning({
    kind,
    bvid: prepared.capture.video.bvid,
    part: prepared.capture.part,
    source: source ?? null,
  });
}
export class LearningDraftStore {
  private rows = new Map<string, LearningDraft>();
  get(key: string) {
    return this.rows.get(key);
  }
  put(key: string, draft: LearningDraft) {
    for (const [id, row] of this.rows)
      if (id !== key && !row.title && !row.note && !row.pending)
        this.rows.delete(id);
    if (!this.rows.has(key) && this.rows.size >= 16)
      throw Error("草稿已满，请先保存或丢弃其他视频的草稿。");
    let bytes = new TextEncoder().encode(canonicalLearning(draft)).length;
    for (const [id, row] of this.rows)
      if (id !== key)
        bytes += new TextEncoder().encode(canonicalLearning(row)).length;
    if (bytes > LEARNING_MAX_BYTES * 3)
      throw Error("草稿空间已满，本次输入未加入，请先处理已有草稿。");
    this.rows.set(key, draft);
  }
  delete(key: string) {
    this.rows.delete(key);
  }
}
