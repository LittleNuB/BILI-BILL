import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { BiliAnalyticsDB } from "../src/background/storage/db.ts";
import { LearningRepository } from "../src/background/storage/learning-repo.ts";
import {
  canonicalLearning,
  learningBytes,
  validateLearningAsset,
  type LearningAsset,
} from "../src/shared/learning.ts";
import {
  canonical,
  logicalBytes,
  validateAsset,
} from "../scripts/lg0/learning-lab.mjs";
import { seedLearningV13, V13_STORES } from "./fixtures/learning-v13.ts";
import { legacySnapshot } from "../scripts/lg0/legacy-fixture.mjs";
import Dexie from "dexie";

const note = (n = 1): LearningAsset => ({
  id: n.toString(16).padStart(64, "0"),
  kind: "note",
  createdAt: 1,
  updatedAt: 1,
  video: { bvid: "BV1234567890", title: "合成视频" },
  part: null,
  personal: { title: "我的笔记", note: "已保存的内容", tags: [] },
  snapshot: null,
  bookmarkMs: null,
  importedFrom: null,
});

test("learning personal editing preserves sources, rejects stale overwrite and updates bounded search", async () => {
  const db = new BiliAnalyticsDB("lg-edit-" + crypto.randomUUID());
  const repo = new LearningRepository(db);
  try {
    const original = note();
    await repo.save(0, original, { assertCurrent: async () => {} });
    const personal = { title: "ＡＩ 产品", note: "学习闭环", tags: ["面试"] };
    const edited = await repo.edit(0, original.id, original, personal);
    assert.deepEqual(edited.video, original.video);
    assert.deepEqual(edited.snapshot, original.snapshot);
    assert.deepEqual(edited.personal, personal);
    assert.deepEqual((await repo.list(0, { query: "ai 面试", kind: "note" })).items.map(row => row.id), [original.id]);
    assert.equal((await repo.list(0, { query: "未出现" })).total, 0);
    assert.equal((await repo.list(0, { kind: "bookmark" })).total, 0);
    const beforeRetry = await repo.state();
    assert.deepEqual(await repo.edit(0, original.id, original, personal), edited);
    assert.deepEqual(await repo.state(), beforeRetry);
    await assert.rejects(repo.edit(0, original.id, original, { ...personal, title: "过期修改" }), /stale_edit/);
    await assert.rejects(repo.edit(0, original.id, edited, { ...personal, note: "x".repeat(10_485_760) }), /capacity_bytes/);
    await assert.rejects(repo.edit(1, original.id, edited, personal), /stale_epoch/);
    assert.deepEqual(await repo.get(original.id), edited);
    assert.equal((await repo.list()).bytes, learningBytes([edited]));
  } finally { await db.delete(); }
});

test("learning production v15 upgrades all 21 v13 tables without changing their schema or content", async () => {
  const name = "lg1-upgrade-" + crypto.randomUUID();
  const legacy = await seedLearningV13(name);
  const db = new BiliAnalyticsDB(name);
  try {
    await db.open();
    assert.equal(db.verno, 15);
    assert.equal(db.tables.length, 24);
    assert.deepEqual((await db.lgWiki.get('state'))?.pages, []);
    assert.equal(
      await legacySnapshot(db, Object.keys(V13_STORES)),
      legacy.before,
    );
    for (const [name, spec] of Object.entries(V13_STORES)) {
      const table = db.table(name);
      assert.equal(
        [
          table.schema.primKey.src,
          ...table.schema.indexes.map((index) => index.src),
        ].join(", "),
        spec,
      );
    }
  } finally {
    await db.delete();
  }
});

test("learning production upgrade failure leaves the v13 database and every old row intact", async () => {
  const name = "lg1-upgrade-fail-" + crypto.randomUUID();
  const legacy = await seedLearningV13(name);
  const current = new BiliAnalyticsDB(name);
  current.version(14).upgrade(() => {
    throw Error("synthetic_upgrade_abort");
  });
  await assert.rejects(current.open(), /synthetic_upgrade_abort/);
  current.close();
  const previous = new Dexie(name);
  try {
    await previous.open();
    assert.equal(previous.verno, 13);
    assert.equal(
      await legacySnapshot(previous, Object.keys(V13_STORES)),
      legacy.before,
    );
  } finally {
    await previous.delete();
  }
});

async function database(
  run: (repo: LearningRepository, db: BiliAnalyticsDB) => Promise<void>,
) {
  const db = new BiliAnalyticsDB("lg1-test-" + crypto.randomUUID());
  try {
    await db.open();
    await run(new LearningRepository(db), db);
  } finally {
    await db.delete();
  }
}

test("learning notes and bookmarks preserve LG-0 canonical format and bytes", () => {
  const rows = [
    note(),
    {
      ...note(2),
      kind: "bookmark",
      part: { cid: "123", page: 2 },
      bookmarkMs: 3000,
    },
  ];
  for (const row of rows) {
    validateLearningAsset(row);
    validateAsset(row);
  }
  assert.equal(canonicalLearning(rows), canonical(rows));
  assert.equal(learningBytes(rows), logicalBytes(rows));
  // Frozen LG-0 wire-format receipt for the two public synthetic records above.
  assert.equal(learningBytes(rows), 645);
  assert.equal(
    createHash("sha256").update(canonicalLearning(rows)).digest("hex"),
    "9bb2a151fab778115bb2b88fd9ff1c977ea05a32de763ec5f653ace3525360a9",
  );
  assert.throws(() => validateLearningAsset({ ...note(), extra: true }));
  assert.throws(() =>
    validateLearningAsset({
      ...note(),
      personal: { ...note().personal, tags: ["a", , "c"] },
    }),
  );
});

test("learning save is persistent, idempotent, isolated from caller and deletes exactly one item", async () =>
  database(async (repo, db) => {
    const row = note();
    await repo.save(0, row, { assertCurrent: async () => {} });
    const revision = (await repo.state()).meta.revision;
    await repo.save(0, row, {
      assertCurrent: async () => {
        throw Error("source unavailable");
      },
    });
    assert.equal((await repo.state()).meta.revision, revision);
    await assert.rejects(
      repo.save(
        0,
        { ...row, personal: { ...row.personal, note: "changed" } },
        {},
      ),
      /identity/,
    );
    row.personal.note = "local draft changed";
    db.close();
    await db.open();
    assert.equal((await repo.get(row.id))?.personal.note, "已保存的内容");
    await repo.save(0, note(2), { assertCurrent: async () => {} });
    await repo.remove(0, row.id);
    assert.equal(await repo.get(row.id), undefined);
    assert.equal((await repo.state()).assets.length, 1);
  }));

test("learning cancellation and stale epochs do not mutate the database", async () =>
  database(async (repo) => {
    const controller = new AbortController();
    await assert.rejects(
      repo.save(0, note(), {
        signal: controller.signal,
        assertCurrent: async () => {
          controller.abort();
        },
      }),
      /cancelled/,
    );
    await assert.rejects(
      repo.save(1, note(), { assertCurrent: async () => {} }),
      /stale_epoch/,
    );
    await assert.rejects(
      repo.save(0, note(), {
        assertCurrent: async () => {
          throw Error("stale_capture");
        },
      }),
      /stale_capture/,
    );
    assert.equal((await repo.state()).assets.length, 0);
  }));

test("learning rechecks capture inside the transaction and reports true outcome after late cancellation", async () =>
  database(async (repo) => {
    let checks = 0;
    await assert.rejects(
      repo.save(0, note(), {
        assertCurrent: async () => {
          if (++checks === 2) throw Error("stale_capture");
        },
      }),
      /stale_capture/,
    );
    assert.equal((await repo.state()).assets.length, 0);
    const controller = new AbortController();
    await repo.save(0, note(), {
      signal: controller.signal,
      assertCurrent: async () => {},
      onPhase: (phase) => {
        if (phase === "committing") controller.abort();
      },
    });
    assert.equal((await repo.state()).assets.length, 1);
  }));

test("learning concurrent saves enforce count and exact byte capacity atomically", async () =>
  database(async (repo, db) => {
    const rows = Array.from({ length: 999 }, (_, i) => note(i + 1));
    await db.lgAssets.bulkAdd(rows);
    const results = await Promise.allSettled(
      [1000, 1001].map((i) =>
        repo.save(0, note(i), { assertCurrent: async () => {} }),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await repo.state()).assets.length, 1000);
    await db.lgAssets.clear();
    const row = note();
    row.personal.note = "";
    row.personal.note = "x".repeat(10_485_760 - learningBytes([row]));
    await repo.save(0, row, { assertCurrent: async () => {} });
    assert.equal(learningBytes((await repo.state()).assets), 10_485_760);
    await assert.rejects(
      repo.save(0, note(2), { assertCurrent: async () => {} }),
      /capacity/,
    );
    assert.equal((await repo.state()).assets.length, 1);
  }));
