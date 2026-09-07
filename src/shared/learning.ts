export const LEARNING_MAX_ASSETS = 1_000;
export const LEARNING_MAX_BYTES = 10_485_760;

export interface LearningAsset {
  id: string;
  kind: "note" | "bookmark";
  createdAt: number;
  updatedAt: number;
  video: { bvid: string; title: string };
  part: { cid: string; page: number } | null;
  personal: { title: string; note: string; tags: string[] };
  snapshot: null;
  bookmarkMs: number | null;
  importedFrom: null;
}
export interface LearningMeta {
  key: "state";
  epoch: number;
  revision: number;
}
export interface LearningCapture {
  token: string;
  kind: LearningAsset["kind"];
  video: LearningAsset["video"];
  part: LearningAsset["part"];
  bookmarkMs: number | null;
}
export interface LearningPrepared {
  epoch: number;
  capture: LearningCapture;
}
export interface LearningListItem {
  id: string;
  kind: LearningAsset["kind"];
  title: string;
  preview: string;
  videoTitle: string;
  page: number | null;
  bookmarkMs: number | null;
  createdAt: number;
}
export interface LearningList {
  epoch: number;
  total: number;
  items: LearningListItem[];
  offset: number;
}

export function learningAssert(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
function fields(
  value: unknown,
  names: string[],
): asserts value is Record<string, unknown> {
  learningAssert(
    value && typeof value === "object" && !Array.isArray(value),
    "fields",
  );
  learningAssert(
    Object.keys(value).sort().join(",") === names.sort().join(","),
    "fields",
  );
}
function text(
  value: unknown,
  max = LEARNING_MAX_BYTES,
): asserts value is string {
  learningAssert(
    typeof value === "string" &&
      value.length <= max &&
      !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
        value,
      ),
    "string",
  );
}
export function learningId(value: unknown): asserts value is string {
  learningAssert(
    typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
    "id",
  );
}
export function learningInteger(
  value: unknown,
  min = 0,
): asserts value is number {
  learningAssert(
    Number.isSafeInteger(value) && (value as number) >= min,
    "integer",
  );
}

// Keep the frozen LG-0 wire format. Capture supports only LG-1 asset kinds.
export function validateLearningAsset(
  row: unknown,
): asserts row is LearningAsset {
  fields(row, [
    "id",
    "kind",
    "createdAt",
    "updatedAt",
    "video",
    "part",
    "personal",
    "snapshot",
    "bookmarkMs",
    "importedFrom",
  ]);
  learningId(row.id);
  learningAssert(row.kind === "note" || row.kind === "bookmark", "kind");
  learningInteger(row.createdAt);
  learningInteger(row.updatedAt, row.createdAt);
  fields(row.video, ["bvid", "title"]);
  learningAssert(
    typeof row.video.bvid === "string" &&
      /^BV[a-zA-Z0-9]{10}$/.test(row.video.bvid),
    "bvid",
  );
  text(row.video.title, 4096);
  if (row.part !== null) {
    fields(row.part, ["cid", "page"]);
    learningAssert(
      typeof row.part.cid === "string" &&
        /^[1-9][0-9]{0,19}$/.test(row.part.cid),
      "cid",
    );
    learningInteger(row.part.page, 1);
  }
  fields(row.personal, ["title", "note", "tags"]);
  text(row.personal.title, 4096);
  text(row.personal.note);
  learningAssert(
    Array.isArray(row.personal.tags) && row.personal.tags.length <= 64,
    "tags",
  );
  for (const tag of row.personal.tags) text(tag, 256);
  learningAssert(
    new Set(row.personal.tags).size === row.personal.tags.length,
    "tags",
  );
  learningAssert(
    row.snapshot === null && row.importedFrom === null,
    "capture_only",
  );
  if (row.kind === "bookmark") {
    learningAssert(row.part !== null, "bookmark_part");
    learningInteger(row.bookmarkMs);
  } else learningAssert(row.bookmarkMs === null, "bookmark");
}

export function canonicalLearning(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}
export function learningBytes(rows: readonly unknown[]): number {
  let bytes = 2 + Math.max(0, rows.length - 1);
  for (const row of rows) {
    const encoded = canonicalLearning(row);
    for (let i = 0; i < encoded.length; i++) {
      const code = encoded.charCodeAt(i);
      if (code < 0x80) bytes++;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    }
  }
  return bytes;
}
export function newLearningId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
export function learningTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
export function learningError(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (code.includes("capacity")) return "学习笔记空间已满，原有内容未改变。";
  if (code === "cancelled") return "已取消保存，草稿仍保留。";
  if (code.includes("stale") || code === "capture_only")
    return "视频或保存状态已变化，请重新确认；草稿仍保留。";
  if (code.includes("identity")) return "这次保存的内容已变化，请重新确认。";
  if (code === "busy_retry") return "另一个保存正在进行，请重试。";
  return "操作未完成，请重试；原有笔记与草稿仍保留。";
}
