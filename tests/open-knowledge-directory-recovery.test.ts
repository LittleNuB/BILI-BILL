import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { BiliAnalyticsDB } from '../src/background/storage/db.ts';
import { KnowledgeRepository } from '../src/background/storage/open-knowledge-repo.ts';
import { previewDirectoryRecovery as prepareRecovery, applyDirectoryRecovery } from '../src/background/storage/open-knowledge-recovery.ts';
import { pickRecoveryDirectory, type KnowledgeDirectoryHandle } from '../src/shared/open-knowledge/browser-files.ts';
import { KnowledgeDirectory } from '../src/shared/open-knowledge/directory.ts';
import { createRevision, videoPageId, serializeRevision, textBytes } from '../src/shared/open-knowledge/format.ts';
import { createSource, imageAttachment } from '../src/shared/open-knowledge/sources.ts';
import { MemoryKnowledgeFiles } from './helpers/knowledge-files.ts';

const page = () => ({ pageId: videoPageId('BV1234567890'), kind: 'video' as const, bvid: 'BV1234567890',
  title: 'Recovery sample', body: 'Original note', aiNotes: '', topics: [], sourceIds: [], attachmentIds: [], legacyIds: [], createdAt: 1 });
const previewDirectoryRecovery = async (repo: KnowledgeRepository, original: KnowledgeDirectory) => prepareRecovery(repo, original, await repo.state());
async function fixture() {
  const db = new BiliAnalyticsDB('directory-recovery-' + crypto.randomUUID()), repo = new KnowledgeRepository(db);
  const files = new MemoryKnowledgeFiles(), original = new KnowledgeDirectory(files);
  const first = await repo.save(page(), []); await repo.connect(original); await repo.sync(original);
  const source = await createSource({ kind: 'external', video: null, label: 'Saved source', text: 'Original material', language: null,
    version: null, capturedAt: 1, segments: [], derivedFrom: null, legacyAsset: null });
  const image = await imageAttachment(Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXfoAAAAASUVORK5CYII=', 'base64')));
  const local = await repo.save({ ...first, body: 'Offline edit', sourceIds: [source.id], attachmentIds: [image.id] }, [first.id], { sources: [source], attachments: [image] });
  const external = await createRevision({ ...first, body: 'External Codex edit' }, [first.id], 'codex', first.updatedAt + 1);
  await original.append(external);
  for (const file of await db.okFiles.where('pending').equals(1).toArray()) files.data.set(file.path, new Uint8Array());
  return { db, repo, files, original, local, external, source, image };
}

test('recovery previews known interrupted writes and preserves both branches in a new directory without touching the original', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.repo.sync(f.original), /knowledge_incomplete_write/);
    const before = structuredClone(f.files.data), state = await f.repo.state();
    await f.repo.saveDraft('kept-draft', 'Draft remains');
    const preview = await previewDirectoryRecovery(f.repo, f.original);
    assert.equal(preview.incompleteFiles, 3); assert.equal(preview.conflicts, 1);
    assert.equal(preview.images, 1); assert.equal(preview.sources, 1);
    assert.deepEqual(f.files.data, before); assert.equal((await f.repo.status()).pending, 3);
    const next = new KnowledgeDirectory(new MemoryKnowledgeFiles());
    await applyDirectoryRecovery(f.repo, preview, next);
    assert.deepEqual(f.files.data, before);
    const heads = (await f.repo.readPage(f.local.pageId)).heads.map(row => row.id).sort();
    assert.deepEqual(heads, [f.local.id, f.external.id].sort());
    assert.deepEqual((await next.readPage(f.local.pageId)).heads.map(row => row.id).sort(), heads);
    assert.deepEqual((await next.readAttachment(f.image.id)).bytes, f.image.bytes);
    assert.equal((await f.repo.readSource(f.source.id)).text, f.source.text);
    assert.equal((await f.repo.status()).pending, 0); assert.equal(await f.repo.draft('kept-draft'), 'Draft remains');
    assert.equal((await f.repo.state()).libraryId, state.libraryId);
    assert.equal((await f.repo.state()).connectionRevision, (state.connectionRevision ?? 0) + 1);
    await assert.rejects(applyDirectoryRecovery(f.repo, preview, next), /recovery_preview/);
  } finally { f.db.close(); await f.db.delete(); }
});

for (const change of ['local edit', 'disconnect', 'remote edit'] as const) {
  test(`recovery fences ${change} after preview before writing any destination files`, async () => {
    const f = await fixture(), nextFiles = new MemoryKnowledgeFiles();
    try {
      const preview = await previewDirectoryRecovery(f.repo, f.original);
      if (change === 'local edit') await f.repo.save({ ...f.local, body: 'New local change' }, [f.local.id]);
      if (change === 'disconnect') await f.repo.disconnect();
      if (change === 'remote edit') {
        const extra = await createRevision({ ...f.external, body: 'New external change' }, [f.external.id], 'codex');
        f.files.data.set(`pages/${extra.pageId}/${extra.id}.md`, textBytes(serializeRevision(extra)));
      }
      const state = await f.repo.state(), pending = (await f.repo.status()).pending;
      await assert.rejects(applyDirectoryRecovery(f.repo, preview, new KnowledgeDirectory(nextFiles)), /recovery_stale/);
      assert.equal(nextFiles.data.size, 0);
      assert.deepEqual(await f.repo.state(), state); assert.equal((await f.repo.status()).pending, pending);
    } finally { f.db.close(); await f.db.delete(); }
  });
}

test('unknown empty files and nonempty immutable collisions cannot be silently repaired', async () => {
  const f = await fixture();
  try {
    const unknown = `sources/${'b'.repeat(64)}.json`;
    f.files.data.set(unknown, new Uint8Array());
    const unknownBefore = structuredClone(f.files.data);
    await assert.rejects(previewDirectoryRecovery(f.repo, f.original), /incomplete_write/);
    assert.deepEqual(f.files.data, unknownBefore);
    f.files.data.delete(unknown);
    const pending = (await f.db.okFiles.where('pending').equals(1).toArray())[0];
    f.files.data.set(pending.path, textBytes('External content at the same immutable path'));
    const before = structuredClone(f.files.data);
    await assert.rejects(previewDirectoryRecovery(f.repo, f.original), /integrity/);
    assert.deepEqual(f.files.data, before); assert.equal((await f.repo.status()).pending, 3);
  } finally { f.db.close(); await f.db.delete(); }
});

test('a failed copy keeps the original, browser state, draft and queue; a fresh preview can retry elsewhere', async () => {
  const f = await fixture(), failed = new MemoryKnowledgeFiles();
  try {
    await f.repo.saveDraft('kept', 'Keep this draft');
    const preview = await previewDirectoryRecovery(f.repo, f.original);
    const originalBefore = structuredClone(f.files.data), stateBefore = await f.repo.state();
    const put = failed.putImmutable.bind(failed);
    failed.putImmutable = async (path, bytes) => {
      if (path.startsWith('pages/')) throw new DOMException('Permission revoked', 'NotAllowedError');
      await put(path, bytes);
    };
    await assert.rejects(applyDirectoryRecovery(f.repo, preview, new KnowledgeDirectory(failed)), /Permission revoked/);
    assert.ok(failed.data.size > 0); assert.deepEqual(f.files.data, originalBefore);
    assert.deepEqual(await f.repo.state(), stateBefore); assert.equal((await f.repo.status()).pending, 3);
    assert.equal(await f.repo.draft('kept'), 'Keep this draft');
    await assert.rejects(applyDirectoryRecovery(f.repo, { ...preview }, new KnowledgeDirectory(new MemoryKnowledgeFiles())), /recovery_preview/);
    const fresh = await previewDirectoryRecovery(f.repo, f.original);
    await applyDirectoryRecovery(f.repo, fresh, new KnowledgeDirectory(new MemoryKnowledgeFiles()));
    assert.equal((await f.repo.status()).pending, 0);
  } finally { f.db.close(); await f.db.delete(); }
});

test('recovery refuses the original or any nonempty destination without changing its files', async () => {
  const f = await fixture();
  try {
    const before = structuredClone(f.files.data);
    await assert.rejects(applyDirectoryRecovery(f.repo, await previewDirectoryRecovery(f.repo, f.original), f.original), /recovery_destination/);
    assert.deepEqual(f.files.data, before);
    const nextFiles = new MemoryKnowledgeFiles(); nextFiles.data.set('user-file.md', textBytes('Keep me'));
    await assert.rejects(applyDirectoryRecovery(f.repo, await previewDirectoryRecovery(f.repo, f.original), new KnowledgeDirectory(nextFiles)), /recovery_destination/);
    assert.equal(nextFiles.data.size, 1); assert.equal((await f.repo.status()).pending, 3);
  } finally { f.db.close(); await f.db.delete(); }
});

for (const change of ['clear', 'remote edit'] as const) {
  test(`${change} during copy cannot acknowledge the pending queue or rebind the directory`, async () => {
    const f = await fixture(), nextFiles = new MemoryKnowledgeFiles();
    try {
      const preview = await previewDirectoryRecovery(f.repo, f.original), state = await f.repo.state();
      const extra = await createRevision({ ...f.external, body: 'Concurrent external update' }, [f.external.id], 'codex');
      const put = nextFiles.putImmutable.bind(nextFiles); let changed = false;
      nextFiles.putImmutable = async (path, bytes) => {
        await put(path, bytes);
        if (!changed && path.startsWith('pages/')) {
          changed = true;
          if (change === 'clear') await f.repo.clear();
          else f.files.data.set(`pages/${extra.pageId}/${extra.id}.md`, textBytes(serializeRevision(extra)));
        }
      };
      await assert.rejects(applyDirectoryRecovery(f.repo, preview, new KnowledgeDirectory(nextFiles)), /recovery_stale/);
      if (change === 'clear') assert.deepEqual(await f.repo.pageIds(), []);
      else { assert.equal((await f.repo.status()).pending, 3); assert.deepEqual(await f.repo.state(), state); }
    } finally { f.db.close(); await f.db.delete(); }
  });
}

test('a same-identity reconnect during permission wait cannot bind an old source handle to the new connection', async () => {
  const f = await fixture();
  try {
    const oldState = await f.repo.state(), nextFiles = new MemoryKnowledgeFiles(), next = new KnowledgeDirectory(nextFiles);
    for (const [path, bytes] of f.files.data) if (bytes.length) nextFiles.data.set(path, bytes.slice());
    const extra = await createRevision({ ...f.external, body: 'Only in the new connection' }, [f.external.id], 'codex');
    await next.append(extra); await f.repo.connect(next);
    const state = await f.repo.state(), pending = (await f.repo.status()).pending;
    await assert.rejects(prepareRecovery(f.repo, f.original, oldState), /recovery_stale/);
    assert.equal((await next.readPage(extra.pageId)).heads[0].id, extra.id);
    assert.deepEqual(await f.repo.state(), state); assert.equal((await f.repo.status()).pending, pending);
  } finally { f.db.close(); await f.db.delete(); }
});

test('recovery picker rejects overlapping and nonempty roots before creating any directories', async () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'showDirectoryPicker');
  let creates = 0, selected = 'root/old', checked = false;
  const populated = new Set(['root/old', 'root/nonempty']);
  const handle = (path: string): KnowledgeDirectoryHandle => ({
    name: path,
    resolve: async (other: { name: string }) => other.name === path ? [] : other.name.startsWith(path + '/') ? other.name.slice(path.length + 1).split('/') : null,
    async *values() { if (populated.has(path)) yield { kind: 'file', name: 'keep.md' }; },
    async getDirectoryHandle(name: string, options: { create?: boolean }) { assert.ok(checked); if (options.create) creates++; return handle(`${path}/${name}`); },
  } as unknown as KnowledgeDirectoryHandle);
  Object.defineProperty(globalThis, 'showDirectoryPicker', { configurable: true, value: async () => handle(selected) });
  try {
    for (selected of ['root/old', 'root/old/empty-child', 'root', 'root/nonempty']) {
      await assert.rejects(pickRecoveryDirectory(handle('root/old'), async () => { checked = true; }), /recovery_destination/);
      assert.equal(creates, 0); assert.equal(checked, false);
    }
    selected = 'root/new';
    await assert.rejects(pickRecoveryDirectory(handle('root/old'), async () => { throw new Error('knowledge_recovery_stale'); }), /recovery_stale/);
    assert.equal(creates, 0);
    const recovered = await pickRecoveryDirectory(handle('root/old'), async () => { checked = true; });
    assert.equal(recovered.name, 'root/new/Bili-Bill'); assert.equal(creates, 1);
  } finally {
    if (prior) Object.defineProperty(globalThis, 'showDirectoryPicker', prior);
    else Reflect.deleteProperty(globalThis, 'showDirectoryPicker');
  }
});
