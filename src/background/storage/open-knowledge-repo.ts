import type { BiliAnalyticsDB } from './db.ts';
import { createRevision, jsonBytes, requireKnowledge, serializeRevision, textBytes, parseRevision,
  type KnowledgePage, type KnowledgeRevision } from '../../shared/open-knowledge/format.ts';
import { KnowledgeDirectory, decodeFile, safeKnowledgeDirectory, safeKnowledgePath, type KnowledgeFiles } from '../../shared/open-knowledge/directory.ts';
import { imageAttachment, parseSource, type KnowledgeSource, type KnowledgeAttachment } from '../../shared/open-knowledge/sources.ts';
import { initialKnowledgeMeta, type KnowledgeLocalMeta } from '../../shared/open-knowledge/local-state.ts';
import type { KnowledgeDirectoryHandle } from '../../shared/open-knowledge/browser-files.ts';
import { legacyMigration } from '../../shared/open-knowledge/migration.ts';
import { emptyWiki } from '../../shared/video-wiki.ts';
import { digest } from '../../shared/open-knowledge/format.ts';

const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, i) => value === b[i]);
const fileEntries = (paths: string[], directory: string) => {
  const prefix = directory ? directory + '/' : '', found = new Map<string, 'file' | 'directory'>();
  for (const path of paths) if (path.startsWith(prefix)) {
    const parts = path.slice(prefix.length).split('/'); found.set(parts[0], parts.length > 1 ? 'directory' : 'file');
  }
  return [...found].map(([name, kind]) => ({ name, kind }));
};
export class KnowledgeRepository {
  readonly database: BiliAnalyticsDB;
  constructor(database: BiliAnalyticsDB) { this.database = database; }
  async state(): Promise<KnowledgeLocalMeta> { return await this.database.okMeta.get('state') ?? initialKnowledgeMeta(); }
  async status() {
    const state = await this.state();
    return { libraryId: state.libraryId, pending: await this.database.okFiles.where('pending').equals(1).count(), epoch: state.epoch, hasHandle: !!state.handle };
  }
  private files(staged = new Map<string, Uint8Array>()): KnowledgeFiles {
    const db = this.database;
    return {
      read: async path => { safeKnowledgePath(path); return staged.get(path)?.slice() ?? (await db.okFiles.get(path))?.bytes.slice() ?? null; },
      putImmutable: async (path, bytes) => {
        safeKnowledgePath(path); const prior = staged.get(path) ?? (await db.okFiles.get(path))?.bytes;
        if (prior) requireKnowledge(equal(prior, bytes), 'integrity');
        else staged.set(path, bytes.slice());
      },
      list: async path => { safeKnowledgeDirectory(path); return fileEntries([...await db.okFiles.toCollection().primaryKeys(), ...staged.keys()], path); },
    };
  }
  readPage(id: string) { return new KnowledgeDirectory(this.files()).readPage(id); }
  pageIds() { return new KnowledgeDirectory(this.files()).pageIds(); }
  readSource(id: string) { return new KnowledgeDirectory(this.files()).readSource(id); }
  readAttachment(id: string) { return new KnowledgeDirectory(this.files()).readAttachment(id); }
  private async commitFiles(staged: Map<string, Uint8Array>, before: KnowledgeLocalMeta, pending: 0 | 1, strictSequence = true) {
    const db = this.database;
    requireKnowledge([...staged.values()].reduce((sum, bytes) => sum + bytes.length, 0) <= 64 * 1024 * 1024, 'capacity');
    await db.transaction('rw', db.okFiles, db.okMeta, async () => {
      const current = await this.state();
      requireKnowledge(current.epoch === before.epoch, 'stale_operation');
      requireKnowledge(!strictSequence || current.sequence === before.sequence, 'conflict');
      for (const [path, bytes] of staged) {
        const previous = await db.okFiles.get(path);
        if (previous) {
          requireKnowledge(equal(previous.bytes, bytes), 'integrity');
          if (pending === 0 && previous.pending === 1) await db.okFiles.update(path, { pending: 0 });
        } else {
          current.sequence++;
          await db.okFiles.add({ path, bytes, pending, sequence: current.sequence });
        }
      }
      await db.okMeta.put(current);
    });
  }
  async save(page: KnowledgePage, parents: string[], resources: { sources?: KnowledgeSource[]; attachments?: KnowledgeAttachment[] } = {},
    options: { actor?: KnowledgeRevision['actor']; updatedAt?: number } = {}): Promise<KnowledgeRevision> {
    const before = await this.state(), staged = new Map<string, Uint8Array>(), directory = new KnowledgeDirectory(this.files(staged));
    for (const source of resources.sources ?? []) await directory.putSource(source);
    for (const image of resources.attachments ?? []) await directory.putAttachment(image);
    const row = await createRevision(page, parents, options.actor ?? 'browser', options.updatedAt);
    await directory.append(row);
    await this.commitFiles(staged, before, 1); return row;
  }
  async connect(remote: KnowledgeDirectory, handle: KnowledgeDirectoryHandle | null = null) {
    const before = await this.state();
    const library = await remote.connect({ create: !before.libraryId, ...(before.libraryId ? { expectedId: before.libraryId } : {}) });
    const db = this.database;
    await db.transaction('rw', db.okMeta, async () => {
      const current = await this.state(); requireKnowledge(current.epoch === before.epoch, 'stale_operation');
      requireKnowledge(!current.libraryId || current.libraryId === library.id, 'library_mismatch');
      await db.okMeta.put({ ...current, libraryId: library.id, handle: handle ?? current.handle });
    });
    return library;
  }
  async disconnect() {
    const db = this.database;
    await db.transaction('rw', db.okMeta, async () => {
      const current = await this.state(); await db.okMeta.put({ ...current, epoch: current.epoch + 1, handle: null });
    });
  }
  async sync(remote: KnowledgeDirectory): Promise<void> {
    const before = await this.state(); requireKnowledge(before.libraryId, 'not_connected');
    await remote.connect({ expectedId: before.libraryId });
    const check = async () => { requireKnowledge((await this.state()).epoch === before.epoch, 'stale_operation'); };
    // Pull before replay: an offline edit and a Codex edit become two visible heads.
    for (const id of await remote.pageIds()) {
      const page = await remote.readPage(id), staged = new Map<string, Uint8Array>();
      const pullSource = async (sourceId: string) => {
        const path = `sources/${sourceId}.json`; if (staged.has(path)) return;
        const source = await remote.readSource(sourceId); staged.set(path, jsonBytes(source));
        if (source.derivedFrom) await pullSource(source.derivedFrom);
      };
      for (const row of page.revisions) {
        for (const source of row.sourceIds) await pullSource(source);
        for (const id of row.attachmentIds) {
          const image = await remote.readAttachment(id); await check();
          staged.set(`attachments/${id}.${image.extension}`, image.bytes);
        }
        staged.set(`pages/${id}/${row.id}.md`, textBytes(serializeRevision(row)));
        requireKnowledge([...staged.values()].reduce((sum, bytes) => sum + bytes.length, 0) <= 64 * 1024 * 1024, 'capacity');
      }
      await check(); await this.commitFiles(staged, before, 0, false);
    }
    const pending: { path: string; sequence: number }[] = [];
    await this.database.okFiles.where('pending').equals(1).each(file => { pending.push({ path: file.path, sequence: file.sequence }); });
    for (const item of pending.sort((a, b) => a.sequence - b.sequence)) {
      await check();
      const file = await this.database.okFiles.get(item.path); requireKnowledge(file, 'stale_operation');
      if (file.path.startsWith('sources/')) await remote.putSource(await parseSource(decodeFile(file.bytes)));
      else if (file.path.startsWith('attachments/')) await remote.putAttachment(await imageAttachment(file.bytes));
      else if (file.path.startsWith('pages/')) await remote.append(await parseRevision(decodeFile(file.bytes)), { preserveConflict: true });
      else throw new Error('knowledge_unexpected_file');
      await this.commitFiles(new Map([[file.path, file.bytes]]), before, 0, false);
    }
  }
  async saveDraft(id: string, body: string): Promise<void> {
    requireKnowledge(typeof id === 'string' && id.length > 0 && id.length <= 128 && textBytes(body).length <= 2 * 1024 * 1024, 'draft');
    await this.database.okDrafts.put({ id, body, updatedAt: Date.now() });
  }
  async draft(id: string): Promise<string> { return (await this.database.okDrafts.get(id))?.body ?? ''; }
  async migrateLegacy(): Promise<number> {
    const db = this.database, before = await this.state(); if (before.migration) return 0;
    const legacy = await db.transaction('r', db.lgAssets, db.lgWiki, db.lgMeta, async () => ({
      assets: await db.lgAssets.toArray(), wiki: await db.lgWiki.get('state') ?? emptyWiki(), meta: await db.lgMeta.get('state') ?? null,
    }));
    const receipt = await digest(jsonBytes(legacy));
    const migration = await legacyMigration(legacy.assets, legacy.wiki);
    for (const item of migration) {
      requireKnowledge((await this.state()).epoch === before.epoch, 'stale_operation');
      await this.save(item.page, [], { sources: item.sources }, { actor: 'migration', updatedAt: item.updatedAt });
    }
    await db.transaction('rw', db.okMeta, db.lgMeta, db.lgWiki, async () => {
      const current = await this.state(); requireKnowledge(current.epoch === before.epoch, 'stale_operation');
      const meta = await db.lgMeta.get('state') ?? null, wiki = await db.lgWiki.get('state') ?? emptyWiki();
      requireKnowledge(JSON.stringify(meta) === JSON.stringify(legacy.meta) && wiki.revision === legacy.wiki.revision, 'legacy_changed');
      await db.okMeta.put({ ...current, migration: receipt });
    });
    return migration.length;
  }
  async clear(): Promise<void> {
    const db = this.database;
    await db.transaction('rw', db.okFiles, db.okMeta, db.okDrafts, async () => {
      const before = await this.state(); await db.okFiles.clear(); await db.okDrafts.clear();
      await db.okMeta.put({ ...initialKnowledgeMeta(), epoch: before.epoch + 1, sequence: before.sequence + 1 });
    });
  }
}
