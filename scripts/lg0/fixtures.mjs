import { MAX_BYTES, logicalBytes } from "./learning-lab.mjs";

export const SEED = "lg0-synthetic-20260906-v1";
export const SCENARIOS = [
  "empty",
  "typical",
  "count-limit",
  "byte-limit",
  "single-large",
  "references",
];

export function asset(index, { note = "saved learning text" } = {}) {
  return {
    id: index.toString(16).padStart(64, "0"),
    kind: "note",
    createdAt: 1,
    updatedAt: 1,
    video: { bvid: "BV1xx411c7mD", title: "Synthetic video " + index },
    part: null,
    personal: { title: "Note " + index, note, tags: ["synthetic"] },
    snapshot: null,
    bookmarkMs: null,
    importedFrom: null,
  };
}

export function fixture(name) {
  if (!SCENARIOS.includes(name)) throw new Error("scenario");
  const count =
    name === "empty"
      ? 0
      : name === "single-large"
        ? 1
        : name === "typical"
          ? 30
          : 1000;
  const rows = Array.from({ length: count }, (_, index) =>
    asset(index + 1, {
      note: "\u5b66\u4e60\u7b14\u8bb0 Alpha beta \ud83d\ude80 " + index,
    }),
  );
  if (name === "references") {
    for (const row of rows) {
      row.kind = "excerpt";
      row.part = { cid: "123", page: 1 };
      const citations = Array.from({ length: 16 }, (_, n) => ({
        fromMs: n * 1000,
        toMs: n * 1000 + 900,
        text: "Synthetic source \u4e2d\u6587 " + n,
      }));
      row.snapshot = {
        origin: "subtitle",
        body: citations.map((c) => c.text).join("\n"),
        source: { kind: "bilibili", hash: "a".repeat(64) },
        citations,
      };
    }
  }
  if (name === "byte-limit" || name === "single-large") {
    const remaining = MAX_BYTES - logicalBytes(rows);
    // Distribute bytes across ordinary rows, or one deliberately pathological row.
    const each = Math.floor(remaining / rows.length);
    rows.forEach((row, index) => {
      row.personal.note += "x".repeat(
        each + (index === 0 ? remaining % rows.length : 0),
      );
    });
  }
  return rows;
}
