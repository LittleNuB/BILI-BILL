import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_FILE_BYTES,
  parseBoundedBackupJson,
  canonical,
  encodeBackup,
  decodeBackup,
  mergeAssets,
  openLab,
  restore,
  readState,
} from "../scripts/lg0/learning-lab.mjs";
import { asset, fixture } from "../scripts/lg0/fixtures.mjs";

test("LG-0 parser guard accepts every legal capacity fixture without changing its bytes", async () => {
  for (const scenario of [
    "empty",
    "typical",
    "count-limit",
    "byte-limit",
    "single-large",
    "references",
  ]) {
    const encoded = await encodeBackup(fixture(scenario));
    const decoded = await decodeBackup(new Blob([encoded]));
    assert.equal(await encodeBackup(decoded), encoded, scenario);
  }
});

test("LG-0 parser guard ignores structural characters and escaped quotes inside strings", async () => {
  const row = asset(1);
  row.personal.note = '{[,]}\\\\\"\\\"' + '\"'.repeat(10000) + "字幕😀";
  const encoded = await encodeBackup([row]);
  assert.equal(
    canonical(await decodeBackup(new Blob([encoded]))),
    canonical([row]),
  );
  const imported = await mergeAssets([asset(1)], [row]);
  const backup = await encodeBackup(imported);
  assert.equal(
    await encodeBackup(await decodeBackup(new Blob([backup]))),
    backup,
  );
});

test("LG-0 parser guard accepts the maximum citation depth and 4096 spans", async () => {
  const row = fixture("references")[0];
  row.snapshot.citations = Array.from({ length: 4096 }, (_, i) => ({
    fromMs: i,
    toMs: i + 1,
    text: "x",
  }));
  row.personal.tags = Array.from({ length: 64 }, (_, i) => "tag" + i);
  const encoded = await encodeBackup([row]);
  assert.equal(
    await encodeBackup(await decodeBackup(new Blob([encoded]))),
    encoded,
  );
});

test("LG-0 retained import originals receive the same pre-parse resource guard", async () => {
  const incoming = asset(1, { note: "conflict" });
  const rows = await mergeAssets([asset(1)], [incoming]);
  rows.find((row) => row.importedFrom).importedFrom.original =
    "[".repeat(100000) + "]".repeat(100000);
  await assert.rejects(encodeBackup(rows), /json_resource_limit/);
});

test("LG-0 parser rejects structure amplification before invoking native JSON.parse", () => {
  const cases = [
    "[".repeat(100000) + "]".repeat(100000),
    '{"x":'.repeat(7) + "0" + "}".repeat(7),
    "[" + Array(4097).fill("0").join(",") + "]",
    "{" + Array.from({ length: 12 }, (_, i) => `"k${i}":0`).join(",") + "}",
    // Wide containers within individual limits, but excessive aggregate nodes.
    "[" +
      Array(100)
        .fill('{"x":[' + Array(4096).fill("{}").join(",") + "]}")
        .join(",") +
      "]",
  ];
  const nativeParse = JSON.parse;
  let parseCalls = 0;
  JSON.parse = (...args) => {
    parseCalls++;
    return nativeParse(...args);
  };
  try {
    for (const text of cases) {
      assert.ok(Buffer.byteLength(text) < MAX_FILE_BYTES);
      assert.throws(() => parseBoundedBackupJson(text), /json_resource_limit/);
    }
    assert.equal(parseCalls, 0);
  } finally {
    JSON.parse = nativeParse;
  }
});

test("LG-0 malformed input remains rejected without any persistent state change", async () => {
  const db = await openLab("lg0-json-resource-test");
  try {
    await restore(db, 0, [asset(1)]);
    const before = await readState(db);
    for (const text of [
      '{"assets":' + "[".repeat(10000),
      '{"assets":[}',
      '{"assets":[],"format":"bili-bill-learning","version":1,"version":1}',
      '"unterminated',
    ]) {
      await assert.rejects(async () =>
        restore(db, 0, await decodeBackup(new Blob([text]))),
      );
      assert.deepEqual(await readState(db), before);
    }
  } finally {
    await db.delete();
  }
});
