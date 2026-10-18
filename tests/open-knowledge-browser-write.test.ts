import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { BiliAnalyticsDB } from '../src/background/storage/db.ts';
import { KnowledgeRepository } from '../src/background/storage/open-knowledge-repo.ts';
import { BrowserKnowledgeFiles, type KnowledgeDirectoryHandle } from '../src/shared/open-knowledge/browser-files.ts';
import { KnowledgeDirectory } from '../src/shared/open-knowledge/directory.ts';
import { createRevision, serializeRevision, textBytes, videoPageId } from '../src/shared/open-knowledge/format.ts';

type WriteStage = 'createWritable' | 'write' | 'close';
interface Entry { bytes: Uint8Array; modified: number }

// Model the FSA boundary: creating a handle publishes an empty file immediately;
// writes are staged until close, and abort discards staging, not the directory entry.
class MemoryFsa {
  files = new Map<string, Entry>();
  directories = new Set(['']);
  failure?: { path: string; stage: WriteStage; error: Error };
  onFailure?: () => void | Promise<void>;
  abortError?: Error;
  afterClose?: (path: string) => void;
  beforeCreate?: (path: string) => void;
  afterSnapshot?: (path: string, snapshot: File) => void;
  calls = { writable: 0, abort: 0, remove: 0 };
  private clock = 1;

  seed(path: string, bytes: Uint8Array) {
    const parts = path.split('/'); parts.pop();
    for (let i = 1; i <= parts.length; i++) this.directories.add(parts.slice(0, i).join('/'));
    this.files.set(path, { bytes: new Uint8Array(bytes), modified: this.clock++ });
  }
  private async fail(path: string, stage: WriteStage) {
    if (this.failure?.path === path && this.failure.stage === stage) {
      await this.onFailure?.();
      throw this.failure.error;
    }
  }
  private file(path: string) {
    const fs = this;
    return {
      kind: 'file', name: path.split('/').at(-1)!,
      async getFile() {
        const entry = fs.files.get(path);
        if (!entry) throw new DOMException('Missing file', 'NotFoundError');
        const snapshot = new File([new Uint8Array(entry.bytes)], this.name, { lastModified: entry.modified });
        fs.afterSnapshot?.(path, snapshot);
        return snapshot;
      },
      async createWritable(options: { keepExistingData: boolean }) {
        fs.calls.writable++;
        await fs.fail(path, 'createWritable');
        let staged = options.keepExistingData ? new Uint8Array(fs.files.get(path)!.bytes) : new Uint8Array();
        return {
          async write(bytes: ArrayBuffer) {
            staged = new Uint8Array(bytes.slice(0));
            await fs.fail(path, 'write');
          },
          async close() {
            await fs.fail(path, 'close');
            fs.seed(path, staged);
            fs.afterClose?.(path);
          },
          async abort() {
            fs.calls.abort++;
            if (fs.abortError) throw fs.abortError;
            staged = new Uint8Array();
          },
        };
      },
    };
  }
  directory(path = ''): KnowledgeDirectoryHandle {
    const fs = this, child = (name: string) => path ? `${path}/${name}` : name;
    return {
      kind: 'directory', name: path.split('/').at(-1) ?? '',
      async queryPermission() { return 'granted'; },
      async requestPermission() { return 'granted'; },
      async getDirectoryHandle(name: string, options?: { create?: boolean }) {
        const next = child(name);
        if (options?.create) fs.directories.add(next);
        if (!fs.directories.has(next)) throw new DOMException('Missing directory', 'NotFoundError');
        return fs.directory(next);
      },
      async getFileHandle(name: string, options?: { create?: boolean }) {
        const next = child(name);
        if (options?.create) {
          fs.beforeCreate?.(next);
          if (!fs.files.has(next)) fs.seed(next, new Uint8Array());
        }
        if (!fs.files.has(next)) throw new DOMException('Missing file', 'NotFoundError');
        return fs.file(next);
      },
      async removeEntry(name: string) {
        fs.calls.remove++;
        if (!fs.files.delete(child(name))) throw new DOMException('Missing file', 'NotFoundError');
      },
      async *values() {
        const prefix = path ? `${path}/` : '';
        for (const name of fs.directories) {
          if (name && name.startsWith(prefix) && !name.slice(prefix.length).includes('/')) {
            yield fs.directory(name);
          }
        }
        for (const name of fs.files.keys()) {
          if (name.startsWith(prefix) && !name.slice(prefix.length).includes('/')) yield fs.file(name);
        }
      },
    } as unknown as KnowledgeDirectoryHandle;
  }
}

const note = () => ({ pageId: videoPageId('BV1234567890'), kind: 'video' as const, bvid: 'BV1234567890',
  title: 'Synthetic note', body: 'Keep the locally saved note', aiNotes: '', topics: [], sourceIds: [],
  attachmentIds: [], legacyIds: [], createdAt: 1 });
const revisionPath = `pages/video-${'1'.repeat(24)}/${'a'.repeat(64)}.md`;
const payload = new TextEncoder().encode('Synthetic immutable revision');

test('external valid commit after the last empty snapshot is never deleted', async () => {
  const fs = new MemoryFsa(), files = new BrowserKnowledgeFiles(fs.directory()), remote = new KnowledgeDirectory(files);
  const row = await createRevision(note(), [], 'codex', 2);
  const path = `pages/${row.pageId}/${row.id}.md`, bytes = textBytes(serializeRevision(row)), error = new Error('Write failed');
  let committed = false;
  fs.failure = { path, stage: 'write', error };
  fs.onFailure = () => {
    fs.afterSnapshot = (observed, snapshot) => {
      if (observed !== path) return;
      assert.equal(snapshot.size, 0);
      fs.afterSnapshot = undefined;
      // The caller receives an empty snapshot even though a valid commit is now on disk.
      fs.seed(path, bytes); committed = true;
    };
  };
  await assert.rejects(files.putImmutable(path, bytes), caught => caught === error);
  // Without cleanup reads, an independent observer drives the same stale-snapshot interleaving.
  if (!committed) assert.deepEqual(await files.read(path), new Uint8Array());
  assert.equal(committed, true);
  assert.equal(fs.calls.remove, 0);
  assert.deepEqual(await files.read(path), bytes);
  assert.equal((await remote.readPage(row.pageId)).heads[0].id, row.id);
});

for (const stage of ['createWritable', 'write', 'close'] as const) {
  test(`${stage} failure retains the original error and queue; replay requires manual orphan recovery`, async () => {
    const fs = new MemoryFsa(), files = new BrowserKnowledgeFiles(fs.directory()), remote = new KnowledgeDirectory(files);
    const db = new BiliAnalyticsDB(`open-knowledge-browser-write-restart-${stage}`);
    try {
      await db.delete(); await db.open();
      const repo = new KnowledgeRepository(db), row = await repo.save(note(), []);
      await repo.connect(remote);
      const path = `pages/${row.pageId}/${row.id}.md`, error = new DOMException('Write failed', 'NotAllowedError');
      fs.failure = { path, stage, error };
      fs.abortError = new Error('Abort also failed');
      fs.onFailure = async () => {
        assert.deepEqual(await files.read(path), new Uint8Array());
        assert.deepEqual(await files.list(`pages/${row.pageId}`), [{ name: `${row.id}.md`, kind: 'file' }]);
      };
      await assert.rejects(repo.sync(remote), caught => caught === error);
      assert.equal((await repo.status()).pending, 1);
      assert.equal((await repo.readPage(row.pageId)).heads[0].body, note().body);
      assert.deepEqual(await files.read(path), new Uint8Array());
      assert.equal(fs.calls.remove, 0);
      assert.equal(fs.calls.abort, stage === 'createWritable' ? 0 : 1);
      db.close(); await db.open();
      fs.failure = undefined; fs.abortError = undefined;
      const restarted = new KnowledgeRepository(db);
      // Restart/regrant alone cannot recover an orphan: pull still precedes replay.
      await assert.rejects(restarted.sync(remote), /knowledge_incomplete_write/);
      assert.equal((await restarted.status()).pending, 1);
      await assert.rejects(files.putImmutable(path, payload), /knowledge_integrity/);
      assert.equal(fs.calls.remove, 0);
      // Manual recovery assumes restored permission, stopped external writers and explicit approval for this exact path.
      const parent = await (await fs.directory().getDirectoryHandle('pages')).getDirectoryHandle(row.pageId);
      assert.equal((await (await parent.getFileHandle(`${row.id}.md`)).getFile()).size, 0);
      await parent.removeEntry(`${row.id}.md`);
      await restarted.sync(remote);
      assert.equal((await restarted.status()).pending, 0);
      assert.equal((await remote.readPage(row.pageId)).heads[0].body, note().body);
      assert.equal(fs.calls.remove, 1);
    } finally { db.close(); await db.delete(); }
  });
}

test('a pre-existing empty revision is an integrity error, not a writable retry target', async () => {
  const fs = new MemoryFsa(), files = new BrowserKnowledgeFiles(fs.directory());
  fs.seed(revisionPath, new Uint8Array());
  await assert.rejects(files.putImmutable(revisionPath, payload), /knowledge_integrity/);
  assert.deepEqual(await files.read(revisionPath), new Uint8Array());
  assert.equal(fs.calls.writable, 0);
  assert.equal(fs.calls.remove, 0);
});

test('content appearing between absence check and file creation is never overwritten', async () => {
  const fs = new MemoryFsa(), files = new BrowserKnowledgeFiles(fs.directory());
  const original = new TextEncoder().encode('Another writer committed this revision');
  fs.beforeCreate = path => { if (path === revisionPath) fs.seed(path, original); };
  await assert.rejects(files.putImmutable(revisionPath, payload), /knowledge_integrity/);
  assert.deepEqual(await files.read(revisionPath), original);
  assert.equal(fs.calls.writable, 0);
  assert.equal(fs.calls.remove, 0);
});

test('write failure and abort preserve another writer\'s committed bytes', async () => {
  const fs = new MemoryFsa(), files = new BrowserKnowledgeFiles(fs.directory()), error = new Error('Write failed');
  const external = new TextEncoder().encode('Another writer completed this file');
  fs.failure = { path: revisionPath, stage: 'write', error };
  fs.onFailure = () => fs.seed(revisionPath, external);
  await assert.rejects(files.putImmutable(revisionPath, payload), caught => caught === error);
  assert.deepEqual(await files.read(revisionPath), external);
  assert.equal(fs.calls.abort, 1);
  assert.equal(fs.calls.remove, 0);
});

test('a close rejection after bytes become visible cannot delete the committed file', async () => {
  const fs = new MemoryFsa(), files = new BrowserKnowledgeFiles(fs.directory()), error = new Error('Close acknowledgement failed');
  fs.afterClose = () => { throw error; };
  await assert.rejects(files.putImmutable(revisionPath, payload), caught => caught === error);
  assert.deepEqual(await files.read(revisionPath), payload);
  assert.equal(fs.calls.remove, 0);
  fs.afterClose = undefined;
  await files.putImmutable(revisionPath, payload);
  assert.equal(fs.calls.writable, 1);
});

for (const replacement of [new Uint8Array(), new TextEncoder().encode('Changed after close')]) {
  test(`post-close integrity failure preserves the now ${replacement.length ? 'nonempty' : 'empty'} file`, async () => {
    const fs = new MemoryFsa(), files = new BrowserKnowledgeFiles(fs.directory());
    fs.afterClose = path => fs.seed(path, replacement);
    await assert.rejects(files.putImmutable(revisionPath, payload), /knowledge_integrity/);
    assert.deepEqual(await files.read(revisionPath), replacement);
    assert.equal(fs.calls.abort, 0);
    assert.equal(fs.calls.remove, 0);
  });
}

for (const path of [revisionPath, `sources/${'b'.repeat(64)}.json`]) {
  test(`immutable bytes at ${path.split('/')[0]} remain idempotent and reject collisions`, async () => {
    const fs = new MemoryFsa(), files = new BrowserKnowledgeFiles(fs.directory());
    fs.seed(path, payload);
    await files.putImmutable(path, payload);
    await assert.rejects(files.putImmutable(path, new TextEncoder().encode('Different bytes')), /knowledge_integrity/);
    assert.deepEqual(await files.read(path), payload);
    assert.equal(fs.calls.writable, 0);
    assert.equal(fs.calls.remove, 0);
  });
}

test('identical content appearing just before creation is accepted without opening a writer', async () => {
  const fs = new MemoryFsa(), files = new BrowserKnowledgeFiles(fs.directory());
  fs.beforeCreate = path => fs.seed(path, payload);
  await files.putImmutable(revisionPath, payload);
  assert.deepEqual(await files.read(revisionPath), payload);
  assert.equal(fs.calls.writable, 0);
  assert.equal(fs.calls.remove, 0);
});

