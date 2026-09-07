import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_ASSETS,
  MAX_BYTES,
  MAX_FILE_BYTES,
  canonical,
  logicalBytes,
  validateAssets,
  encodeBackup,
  decodeBackup,
  mergeAssets,
  assertCapture,
  openLab,
  readState,
  change,
  clearKnowledge,
  search,
  saveCapture,
  editPersonal,
  restore,
} from "../scripts/lg0/learning-lab.mjs";
import { asset, fixture } from "../scripts/lg0/fixtures.mjs";
import { seedLegacy, legacySnapshot } from "../scripts/lg0/legacy-fixture.mjs";
import Dexie from "dexie";

test("LG-0 export observes queued cancellation and keeps canonical output", async () => {
  const rows = [asset(1)];
  const controller = new AbortController();
  const phases = [];
  await assert.rejects(encodeBackup(rows, {
    signal: controller.signal,
    onPhase: (phase) => {
      phases.push(phase);
      setTimeout(() => controller.abort(), 0);
    },
  }), /cancelled/);
  assert.deepEqual(phases, ["before-encode"]);
  assert.deepEqual(await decodeBackup(new Blob([await encodeBackup(rows)])), rows);
});

test("LG-0 canonical bytes match the original fixed-schema encoding", () => {
  const previous = (value) => {
    if (Array.isArray(value)) return "[" + value.map(previous).join(",") + "]";
    if (value !== null && typeof value === "object")
      return (
        "{" +
        Object.keys(value)
          .sort()
          .map((key) => JSON.stringify(key) + ":" + previous(value[key]))
          .join(",") +
        "}"
      );
    return JSON.stringify(value);
  };
  for (const scenario of [
    "empty",
    "typical",
    "count-limit",
    "byte-limit",
    "single-large",
    "references",
  ]) {
    const rows = fixture(scenario);
    assert.equal(canonical(rows), previous(rows));
    assert.equal(logicalBytes(rows), Buffer.byteLength(previous(rows)));
  }
  assert.equal(logicalBytes([]), 2);
});

test("LG-0 differential writes and no-op restore preserve revision and input isolation", async () => {
  const db = await openLab("lg0-test-delta");
  try {
    const incoming = [asset(1), asset(2)];
    await restore(db, 0, incoming);
    const before = await readState(db);
    const writes = [];
    db.lgAssets.hook("creating", (_key, row) => {
      writes.push(["create", row.id]);
    });
    db.lgAssets.hook("updating", (_changes, key) => {
      writes.push(["update", key]);
    });
    db.lgAssets.hook("deleting", (key) => {
      writes.push(["delete", key]);
    });
    await restore(db, 0, incoming);
    assert.deepEqual(await readState(db), before);
    assert.deepEqual(writes, []);
    await editPersonal(
      db,
      0,
      asset(1).id,
      { ...asset(1).personal, note: "edited" },
      2,
    );
    assert.deepEqual(writes, [["update", asset(1).id]]);
    assert.deepEqual(incoming, [asset(1), asset(2)]);
    const merged = await mergeAssets([], incoming);
    merged[0].personal.note = "owned output";
    assert.deepEqual(incoming, [asset(1), asset(2)]);
  } finally {
    await db.delete();
  }
});

test("LG-0 idempotent restore does not encode full assets merely to compare them", async () => {
  const db = await openLab("lg0-test-equality-allocation");
  const rows = [asset(1, { note: "x".repeat(100_000) })];
  const stringify = JSON.stringify;
  try {
    await restore(db, 0, rows);
    const before = await readState(db);
    let encodedAssets = 0;
    JSON.stringify = function(value, ...args) {
      if (value?.id === rows[0].id && value?.personal?.note === rows[0].personal.note) encodedAssets++;
      return stringify.call(JSON, value, ...args);
    };
    await restore(db, 0, rows);
    JSON.stringify = stringify;
    assert.deepEqual(await readState(db), before);
    // Four capacity validations remain; equality checks need no JSON buffers.
    assert.equal(encodedAssets, 4);
  } finally {
    JSON.stringify = stringify;
    await db.delete();
  }
});

test("LG-0 restore compares nested content and array order without treating key order as an edit", async () => {
  const original = fixture("references")[0];
  const reverseKeys = value => Array.isArray(value) ? value.map(reverseKeys)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverseKeys(v)])) : value;
  assert.deepEqual(await mergeAssets([original], [reverseKeys(original)]), [original]);
  for (const mutate of [row => { row.personal.note += " changed"; }, row => { row.video.title += " changed"; },
    row => { row.snapshot.citations[0].text += " changed"; }, row => { row.snapshot.citations.reverse(); }]) {
    const incoming = structuredClone(original); mutate(incoming);
    const merged = await mergeAssets([original], [incoming]);
    assert.equal(merged.length, 2);
    assert.deepEqual(merged.find(row => row.id === original.id), original);
    assert.deepEqual(JSON.parse(merged.find(row => row.id !== original.id).importedFrom.original), incoming);
    assert.deepEqual(await mergeAssets(merged, [incoming]), merged);
  }
});

test("LG-0 sparse tags are rejected before merge or write", async () => {
  const sparse = asset(1);
  sparse.personal.tags = ["keep", , "last"];
  const dense = structuredClone(sparse);
  dense.personal.tags[1] = "new";
  await assert.rejects(mergeAssets([sparse], [dense]), /string/);
  await assert.rejects(mergeAssets([dense], [sparse]), /string/);
  const db = await openLab("lg0-test-sparse-reject");
  try {
    const before = await readState(db);
    await assert.rejects(change(db, 0, () => [sparse]), /string/);
    assert.deepEqual(await readState(db), before);
  } finally { await db.delete(); }
});

test("LG-0 differential comparison does not skip a dense repair of an old sparse row", async () => {
  const db = await openLab("lg0-test-sparse-repair");
  try {
    const sparse = asset(1);
    sparse.personal.tags = ["keep", , "last"];
    // Model a row admitted by the earlier validation bug, not a new ingress.
    await db.lgAssets.put(sparse);
    await change(db, 0, rows => rows.map(row => ({ ...row, personal: { ...row.personal, tags: ["keep", "new", "last"] } })));
    const after = await readState(db);
    assert.deepEqual(after.assets[0].personal.tags, ["keep", "new", "last"]);
    assert.equal(after.meta.revision, 1);
  } finally { await db.delete(); }
});

test("LG-0 cancellation at the prepared checkpoint writes nothing", async () => {
  const db = await openLab("lg0-test-prepared-cancel");
  try {
    const before = await readState(db);
    const controller = new AbortController();
    await assert.rejects(
      restore(db, 0, [asset(1)], {
        signal: controller.signal,
        beforeCommit: async () => {
          controller.abort();
        },
      }),
      /cancelled/,
    );
    assert.deepEqual(await readState(db), before);
  } finally {
    await db.delete();
  }
});

test("LG-0 exact byte and count boundaries include inline sources and metadata", () => {
  const rows = fixture("byte-limit");
  assert.equal(logicalBytes(rows), MAX_BYTES);
  validateAssets(rows);
  rows[0].personal.note += "a";
  assert.throws(() => validateAssets(rows), /capacity_bytes/);
  const count = fixture("count-limit");
  assert.equal(count.length, MAX_ASSETS);
  validateAssets(count);
  count.push(asset(1001));
  assert.throws(() => validateAssets(count), /capacity_count/);
});

test("LG-0 rejects forged conflict-copy identity without dropping the original incoming content", async () => {
  const local = asset(1, { note: "local" });
  const incoming = asset(1, { note: "incoming" });
  const merged = await mergeAssets([local], [incoming]);
  const copy = merged.find((row) => row.id !== local.id);
  assert.equal(
    JSON.parse(copy.importedFrom.original).personal.note,
    "incoming",
  );
  const forged = structuredClone(copy);
  forged.video.title = "forged immutable source";
  await assert.rejects(
    mergeAssets([local, forged], [incoming]),
    /import_identity/,
  );
  await assert.rejects(
    decodeBackup(
      new Blob([
        canonical({
          assets: [forged],
          format: "bili-bill-learning",
          version: 1,
        }),
      ]),
    ),
    /import_identity/,
  );
  const forgedDigest = structuredClone(copy);
  forgedDigest.importedFrom.digest = "f".repeat(64);
  await assert.rejects(mergeAssets([], [forgedDigest]), /import_identity/);
  await assert.rejects(encodeBackup([forged]), /import_identity/);
  const db = await openLab("lg0-test-forged-write");
  try {
    await assert.rejects(
      change(db, 0, () => [forged]),
      /import_identity/,
    );
    assert.equal((await readState(db)).assets.length, 0);
  } finally {
    await db.delete();
  }
});

test("LG-0 restore retries recompute from current state, preserving concurrent save/edit/delete", async () => {
  const db = await openLab("lg0-test-restore-cas");
  try {
    await change(db, 0, () => [asset(1), asset(2)]);
    const incoming = [asset(3)];
    let writes;
    let once = false;
    await restore(db, 0, incoming, {
      onPhase(phase) {
        if (phase !== "committing" || once) return;
        once = true;
        // Enqueue this transaction before restore's CAS write; it invalidates
        // the preflight revision deterministically without timing sleeps.
        writes = db.transaction("rw", db.lgAssets, db.lgMeta, async () => {
          await db.lgAssets.put(asset(4));
          await db.lgAssets.put(asset(1, { note: "concurrent edit" }));
          await db.lgAssets.delete(asset(2).id);
          const meta = await db.lgMeta.get("state");
          await db.lgMeta.put({ ...meta, revision: meta.revision + 1 });
        });
      },
    });
    await writes;
    const rows = (await readState(db)).assets;
    assert.deepEqual(
      rows.map((row) => row.id),
      [asset(1).id, asset(3).id, asset(4).id],
    );
    assert.equal(rows[0].personal.note, "concurrent edit");
  } finally {
    await db.delete();
  }
});

test("LG-0 successful save acknowledgement is idempotent after source changes, without a new write", async () => {
  const db = await openLab("lg0-test-save-retry");
  try {
    const row = fixture("references")[0];
    const proof = {
      bvid: row.video.bvid,
      part: row.part,
      source: row.snapshot.source,
      spans: row.snapshot.citations,
    };
    await saveCapture(db, 0, row, () => proof);
    const before = await readState(db);
    await saveCapture(db, 0, row, () => {
      throw new Error("source changed");
    });
    assert.deepEqual(await readState(db), before);
    await clearKnowledge(db);
    await assert.rejects(
      saveCapture(db, 0, row, () => proof),
      /stale_epoch/,
    );
  } finally {
    await db.delete();
  }
});

test("LG-0 UTF-8 counts CJK, astral characters, escapes and source snapshots", () => {
  const rows = [asset(1, { note: '\u4e2d\u6587\ud83d\ude80\n"\\' })];
  assert.equal(logicalBytes(rows), Buffer.byteLength(canonical(rows)));
  const refs = fixture("references");
  assert.ok(logicalBytes(refs) > logicalBytes([asset(1)]));
});

test("LG-0 backup round trip is canonical, bounded and format-separated", async () => {
  const rows = fixture("byte-limit");
  const text = await encodeBackup(rows);
  assert.equal(Buffer.byteLength(text), MAX_FILE_BYTES);
  assert.deepEqual(await decodeBackup(new Blob([text])), rows);
  let touched = false;
  await assert.rejects(
    decodeBackup({
      size: MAX_FILE_BYTES + 1,
      arrayBuffer() {
        touched = true;
      },
    }),
    /file_size/,
  );
  assert.equal(touched, false);
  for (const text of [
    "{}",
    "PK zip",
    '{"format":"other"}',
    (await encodeBackup([])) + " ",
    (await encodeBackup([])).replace('"version":1', '"version":2'),
  ]) {
    await assert.rejects(decodeBackup(new Blob([text])));
  }
  await assert.rejects(decodeBackup(new Blob([new Uint8Array([0xff])])));
});

test("LG-0 rejects unknown fields, duplicate identities and invalid nested evidence", () => {
  const row = asset(1);
  assert.throws(
    () => validateAssets([{ ...row, provider: "unexpected" }]),
    /fields/,
  );
  assert.throws(() => validateAssets([row, row]), /duplicate_id/);
  const excerpt = fixture("references")[0];
  excerpt.snapshot.citations[0].toMs = -1;
  assert.throws(() => validateAssets([excerpt]), /range/);
  assert.throws(() => validateAssets([{ ...row, id: "__proto__" }]), /id/);
  assert.throws(
    () =>
      validateAssets([
        { ...row, personal: { ...row.personal, tags: ["a", "a"] } },
      ]),
    /tags/,
  );
});

test("LG-0 conflict copies preserve local edits and repeated import is idempotent", async () => {
  const local = asset(1, { note: "local" });
  const incoming = asset(1, { note: "incoming" });
  const first = await mergeAssets([local], [incoming]);
  assert.equal(first.length, 2);
  assert.deepEqual(
    first.find((x) => x.id === local.id),
    local,
  );
  const copy = first.find((x) => x.id !== local.id);
  copy.personal.note = "edited imported copy";
  const second = await mergeAssets(first, [incoming]);
  assert.deepEqual(second, first);
  assert.equal((await mergeAssets([local], [local])).length, 1);
  assert.deepEqual(
    await decodeBackup(new Blob([await encodeBackup(first)])),
    first,
  );
});

test("LG-0 capture requires exact current part, source and validated answer body", () => {
  const row = fixture("references")[0];
  const evidence = {
    bvid: row.video.bvid,
    part: row.part,
    source: row.snapshot.source,
    spans: row.snapshot.citations,
  };
  assertCapture(row, evidence);
  assert.throws(
    () => assertCapture(row, { ...evidence, part: { cid: "999", page: 2 } }),
    /stale_capture/,
  );
  assert.throws(
    () => assertCapture(row, { ...evidence, spans: [] }),
    /citation/,
  );
  const answer = structuredClone(row);
  answer.kind = "answer";
  answer.snapshot.origin = "answer";
  answer.snapshot.body = "validated whole answer";
  assert.throws(() => assertCapture(answer, evidence), /answer/);
  assertCapture(answer, {
    ...evidence,
    validated: {
      origin: "answer",
      body: answer.snapshot.body,
      citations: answer.snapshot.citations,
    },
  });
  assertCapture(asset(1), null);
});

test("LG-0 serialized CAS protects concurrent writes, capacity and stale clear epochs", async () => {
  const db = await openLab("lg0-test-concurrency");
  try {
    await Promise.all([
      change(db, 0, (rows) => [...rows, asset(1)]),
      change(db, 0, (rows) => [...rows, asset(2)]),
    ]);
    assert.equal((await readState(db)).assets.length, 2);
    await clearKnowledge(db);
    await assert.rejects(
      change(db, 0, () => [asset(3)]),
      /stale_epoch/,
    );
    const epoch = (await readState(db)).meta.epoch;
    await change(db, epoch, () => fixture("count-limit").slice(0, 999));
    const results = await Promise.allSettled([
      change(db, epoch, (rows) => [...rows, asset(1000)]),
      change(db, epoch, (rows) => [...rows, asset(1001)]),
    ]);
    assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal((await readState(db)).assets.length, MAX_ASSETS);
    await change(db, epoch, (rows) => rows.filter((x) => x.id !== asset(1).id));
    await change(db, epoch, (rows) => [...rows, asset(2000)]);
    assert.equal((await readState(db)).assets.length, MAX_ASSETS);
  } finally {
    await db.delete();
  }
});

test("LG-0 cancellation and injected abort/quota errors have zero partial writes", async () => {
  const db = await openLab("lg0-test-faults");
  try {
    await change(db, 0, () => [asset(1)]);
    const before = await readState(db);
    for (const fault of ["abort", "quota"]) {
      await assert.rejects(change(db, 0, () => [asset(2)], { fault }));
      assert.deepEqual(await readState(db), before);
    }
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      change(db, 0, () => [asset(2)], { signal: controller.signal }),
      /cancelled/,
    );
    await assert.rejects(
      decodeBackup(new Blob([await encodeBackup([asset(2)])]), {
        signal: controller.signal,
      }),
      /cancelled/,
    );
    assert.deepEqual(await readState(db), before);
    db.close();
    await db.open();
    assert.deepEqual(await readState(db), before);
  } finally {
    await db.delete();
  }
});

test("LG-0 search uses saved fields, AND terms, filters and current committed state", async () => {
  const db = await openLab("lg0-test-search");
  try {
    await change(db, 0, () => [
      asset(1, { note: "\u4e2d\u6587 Alpha" }),
      asset(2),
    ]);
    assert.equal((await search(db, "\u4e2d\u6587 alpha")).length, 1);
    assert.equal((await search(db, "not-present")).length, 0);
    assert.equal((await search(db, "alpha", { kind: "bookmark" })).length, 0);
    await change(db, 0, (rows) => rows.filter((x) => x.id !== asset(1).id));
    assert.equal((await search(db, "alpha")).length, 0);
  } finally {
    await db.delete();
  }
});

test("LG-0 actual v13 schema fixture survives additive upgrade and failed upgrade", async () => {
  const name = "lg0-test-upgrade";
  const legacy = await seedLegacy(name);
  await assert.rejects(
    openLab(name, legacy.stores, { failUpgrade: true }),
    /injected_upgrade_failure/,
  );
  const old = new Dexie(name);
  await old.open();
  assert.equal(old.verno, 13);
  assert.equal(
    await legacySnapshot(old, Object.keys(legacy.stores)),
    legacy.before,
  );
  old.close();
  const db = await openLab(name, legacy.stores);
  try {
    assert.equal(db.verno, 14);
    await change(db, 0, () => [asset(1)]);
    assert.equal(
      await legacySnapshot(db, Object.keys(legacy.stores)),
      legacy.before,
    );
  } finally {
    await db.delete();
  }
});

test("LG-0 user edits cannot replace immutable snapshot and duplicate saves reuse identity", async () => {
  const db = await openLab("lg0-test-capture");
  try {
    const row = fixture("references")[0];
    const proof = {
      bvid: row.video.bvid,
      part: row.part,
      source: row.snapshot.source,
      spans: row.snapshot.citations,
    };
    await saveCapture(db, 0, row, () => proof);
    await saveCapture(db, 0, row, () => proof);
    assert.equal((await readState(db)).assets.length, 1);
    await editPersonal(db, 0, row.id, { ...row.personal, note: "edited" }, 2);
    assert.deepEqual((await readState(db)).assets[0].snapshot, row.snapshot);
    const bad = { ...row.personal, snapshot: null };
    await assert.rejects(editPersonal(db, 0, row.id, bad, 3), /fields/);
    const fresh = { ...row, id: "b".repeat(64) };
    await assert.rejects(
      saveCapture(db, 0, fresh, () => proof, {
        onPhase() {
          proof.part = { cid: "444", page: 4 };
        },
      }),
      /stale_capture/,
    );
    assert.equal((await readState(db)).assets.length, 1);
  } finally {
    await db.delete();
  }
});
