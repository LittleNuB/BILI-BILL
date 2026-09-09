export const LEARNING_MAX_ASSETS = 1_000;
export const LEARNING_MAX_BYTES = 10_485_760;

export interface LearningAsset {
  id: string;
  kind: "note" | "bookmark" | "excerpt" | "answer";
  createdAt: number;
  updatedAt: number;
  video: { bvid: string; title: string };
  part: { cid: string; page: number } | null;
  personal: { title: string; note: string; tags: string[] };
  snapshot: LearningSnapshot | null;
  bookmarkMs: number | null;
  importedFrom: { id: string; digest: string; original: string } | null;
}
export interface LearningSnapshot {
  origin: "subtitle" | "summary" | "highlights" | "answer";
  body: string;
  source: { kind: "bilibili" | "local"; hash: string };
  citations: { fromMs: number; toMs: number; text: string }[];
}
export interface LearningMeta {
  key: "state";
  epoch: number;
  revision: number;
}
export interface LearningCapture {
  token: string;
  kind: "note" | "bookmark";
  video: LearningAsset["video"];
  part: LearningAsset["part"];
  bookmarkMs: number | null;
}
export interface LearningPrepared {
  epoch: number;
  capture: LearningCapture;
  snapshot?: LearningSnapshot;
  sourceRequest?: LearningSourceRequest;
}
export interface LearningSourceRequest {
  origin: LearningSnapshot["origin"];
  sourceIdentityKey: string;
  segmentIds?: string[];
  subtitleLine?: { id: string; binding: string };
  subtitleSelection?: { lines: { id: string; binding: string }[]; start: number; end: number };
  cacheKey?: string;
  generatedAt?: number;
  sessionId?: string;
  turnId?: string;
  requestId?: string;
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
  allTotal: number;
  bytes: number;
  videos: { bvid: string; title: string }[];
  items: LearningListItem[];
  offset: number;
}
export interface LearningFilter {
  query?: string;
  kind?: LearningAsset["kind"] | "";
  bvid?: string;
}

export function learningMatches(row: LearningAsset, filters: LearningFilter): boolean {
  text(filters.query ?? "", 256);
  learningAssert(!filters.kind || ["note", "bookmark", "excerpt", "answer"].includes(filters.kind), "kind");
  text(filters.bvid ?? "", 12);
  const normalize = (value: string) => value.normalize("NFKC").toLowerCase();
  const words = normalize(filters.query ?? "").split(/\s+/u).filter(Boolean);
  const content = normalize([row.personal.title, row.personal.note, ...row.personal.tags, row.video.title, row.snapshot?.body ?? "", ...row.snapshot?.citations.map(span => span.text) ?? []].join("\n"));
  return (!filters.kind || row.kind === filters.kind) && (!filters.bvid || row.video.bvid === filters.bvid)
    && words.every(word => content.includes(word));
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

// Frozen LG-0 wire format. Fresh capture and historical import are separate boundaries.
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
  learningAssert(["note", "bookmark", "excerpt", "answer"].includes(row.kind as string), "kind");
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
  if (row.importedFrom !== null) {
    fields(row.importedFrom, ["id", "digest", "original"]);
    learningId(row.importedFrom.id);
    learningId(row.importedFrom.digest);
    text(row.importedFrom.original);
  }
  if (row.kind === "bookmark") {
    learningAssert(row.part !== null, "bookmark_part");
    learningInteger(row.bookmarkMs);
  } else learningAssert(row.bookmarkMs === null, "bookmark");
  if (row.kind === "note" || row.kind === "bookmark") {
    learningAssert(row.snapshot === null, "snapshot");
    return;
  }
  learningAssert(row.part !== null, "source_part");
  fields(row.snapshot, ["origin", "body", "source", "citations"]);
  const snapshot = row.snapshot;
  learningAssert((row.kind === "answer" && snapshot.origin === "answer") ||
    (row.kind === "excerpt" && ["subtitle", "summary", "highlights"].includes(snapshot.origin as string)), "origin");
  text(snapshot.body);
  learningAssert(snapshot.body.length > 0, "body");
  fields(snapshot.source, ["kind", "hash"]);
  learningAssert(["bilibili", "local"].includes(snapshot.source.kind as string), "source");
  learningId(snapshot.source.hash);
  learningAssert(Array.isArray(snapshot.citations) && snapshot.citations.length > 0 && snapshot.citations.length <= 4096, "citations");
  for (const span of snapshot.citations) {
    fields(span, ["fromMs", "toMs", "text"]);
    learningInteger(span.fromMs);
    learningInteger(span.toMs, span.fromMs + 1);
    text(span.text);
    learningAssert(span.text.length > 0, "citation_text");
  }
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
  if (code === 'wiki_capacity') return '视频 Wiki 组织空间已满，本次未保存；原有内容和草稿仍保留。';
  if (code.includes("capacity")) return "学习笔记空间已满，原有内容未改变。";
  if (code === "cancelled") return "已取消保存，草稿仍保留。";
  if (code.includes("stale") || code === "capture_only")
    return "视频或保存状态已变化，请重新确认；草稿仍保留。";
  if (code.includes("identity")) return "这次保存的内容已变化，请重新确认。";
  if (code === "busy_retry") return "另一个保存正在进行，请重试。";
  return "操作未完成，请重试；原有笔记与草稿仍保留。";
}
