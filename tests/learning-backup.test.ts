import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { BiliAnalyticsDB } from "../src/background/storage/db.ts";
import { LearningRepository } from "../src/background/storage/learning-repo.ts";
import { decodeLearningBackup, encodeLearningBackup, mergeLearningAssets, parseLearningBackupJson, validateLearningImportIdentity } from "../src/shared/learning-backup.ts";
import { type LearningAsset } from "../src/shared/learning.ts";
import { encodeBackup, mergeAssets } from "../scripts/lg0/learning-lab.mjs";

const row = (): LearningAsset => ({ id: "a".repeat(64), kind: "excerpt", createdAt: 1, updatedAt: 1,
  video: { bvid: "BV1234567890", title: "合成学习" }, part: { cid: "123", page: 1 },
  personal: { title: "摘录", note: "备注", tags: ["学习"] }, bookmarkMs: null, importedFrom: null,
  snapshot: { origin: "subtitle", body: "合成原句", source: { kind: "bilibili", hash: "b".repeat(64) }, citations: [{ fromMs: 1000, toMs: 2000, text: "合成原句" }] } });

test("production learning backup preserves frozen LG0 encoding, imported identity and personal edits", async () => {
  const original = row();
  assert.equal(await encodeLearningBackup([original]), await encodeBackup([original]));
  assert.deepEqual(await decodeLearningBackup(new Blob([await encodeLearningBackup([original])])), [original]);
  const incoming = { ...original, personal: { ...original.personal, note: "另一份" } };
  const merged = await mergeLearningAssets([original], [incoming]);
  assert.deepEqual(merged, await mergeAssets([original], [incoming]));
  const copy = merged.find(item => item.id !== original.id)!;
  await validateLearningImportIdentity(copy);
  copy.personal.note = "后来编辑";
  await validateLearningImportIdentity(copy);
  assert.deepEqual(await mergeLearningAssets(merged, [incoming]), merged);
  const broken = structuredClone(copy); broken.snapshot!.body = "伪造";
  await assert.rejects(validateLearningImportIdentity(broken), /import_identity/);
  await assert.rejects(encodeLearningBackup([broken]), /import_identity/);
});
test("production restore is atomic, idempotent and fenced against clearing and cancellation", async () => {
  const db = new BiliAnalyticsDB("lg-backup-" + crypto.randomUUID());
  const repo = new LearningRepository(db);
  try {
    const original = row();
    await repo.restore(0, [original]);
    const before = await repo.state();
    await repo.restore(0, [original]);
    assert.deepEqual(await repo.state(), before);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(repo.restore(0, [{ ...original, id: "c".repeat(64) }], { signal: aborted.signal }), /cancelled/);
    assert.deepEqual(await repo.state(), before);
    await assert.rejects(repo.clear(0, before.meta.revision + 1), /stale_clear/);
    await repo.clear(0, before.meta.revision);
    await assert.rejects(repo.restore(0, [original]), /stale_epoch/);
    assert.equal((await repo.state()).assets.length, 0);
    await repo.restore(1, [original]);
    assert.deepEqual(await repo.get(original.id), original);
  } finally { await db.delete(); }
});
test("production backup rejects unknown fields, duplicate keys, noncanonical and inflated JSON before restore", async () => {
  const text = await encodeLearningBackup([row()]);
  for (const invalid of [text + " ", text.replace('"version":1', '"version":1,"version":1'), text.replace('"version":1', '"version":2')]) {
    await assert.rejects(decodeLearningBackup(new Blob([invalid])));
  }
  assert.throws(() => parseLearningBackupJson('[[[]]]'), /json_resource_limit/);
  await assert.rejects(decodeLearningBackup(new Blob([new Uint8Array([255])])));
});
