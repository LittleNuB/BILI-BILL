import { KnowledgeRepository } from './open-knowledge-repo.ts';
import { jsonBytes, requireKnowledge, shortText, videoPageId } from '../../shared/open-knowledge/format.ts';
import { appendCapturedNote, captureSource, noteKey, validateAnchor, type CapturedNote, type NoteReceipt } from '../../shared/open-knowledge/captures.ts';
import { validateSource, imageAttachment } from '../../shared/open-knowledge/sources.ts';
import type { BiliAnalyticsDB } from './db.ts';
import { legacyMigration } from '../../shared/open-knowledge/migration.ts';
import { emptyWiki } from '../../shared/video-wiki.ts';
import type { LearningAsset } from '../../shared/learning.ts';
import type { KnowledgeSource } from '../../shared/open-knowledge/sources.ts';

export class KnowledgeNotes {
  readonly repo: KnowledgeRepository;
  readonly db: BiliAnalyticsDB;
  constructor(db: BiliAnalyticsDB) { this.db = db; this.repo = new KnowledgeRepository(db); }
  async load(key: string): Promise<CapturedNote | null> {
    return (await this.db.okCaptures.where('key').equals(key).toArray()).sort((a, b) => b.anchor.capturedAt - a.anchor.capturedAt)[0] ?? null;
  }
  async begin(note: CapturedNote): Promise<CapturedNote> {
    validateAnchor(note.anchor); requireKnowledge(note.key === noteKey(note.anchor) && /^[a-f0-9-]{36}$/.test(note.id), 'capture');
    shortText(note.text, 64000); shortText(note.quote, 16000);
    note.sources.forEach(validateSource);
    requireKnowledge(note.sources.length <= 2 && note.images.length <= 4, 'capture');
    for (const source of note.sources) requireKnowledge(source.video?.bvid === note.anchor.bvid && source.video.cid === note.anchor.cid
      && source.video.page === note.anchor.page, 'part');
    for (const image of note.images) requireKnowledge((await imageAttachment(image.bytes)).id === image.id, 'integrity');
    const size = (row: CapturedNote) => jsonBytes({ ...row, images: [] }).length + row.images.reduce((sum, image) => sum + image.bytes.length, 0);
    requireKnowledge(size(note) <= 64 * 1024 * 1024, 'capacity');
    return this.db.transaction('rw', this.db.okCaptures, this.db.okMeta, async () => {
      requireKnowledge((await this.repo.state()).epoch === note.epoch, 'stale_operation');
      const prior = await this.db.okCaptures.get(note.id);
      if (prior) { requireKnowledge(prior.key === note.key, 'capture'); return prior; }
      const drafts = await this.db.okCaptures.toArray();
      requireKnowledge(drafts.length < 32 && drafts.reduce((sum, row) => sum + size(row), size(note)) <= 256 * 1024 * 1024, 'draft_capacity');
      await this.db.okCaptures.add(note); return note;
    });
  }
  async edit(id: string, epoch: number, version: number, text: string): Promise<CapturedNote> {
    shortText(text, 64000);
    return this.db.transaction('rw', this.db.okCaptures, this.db.okMeta, async () => {
      const row = await this.db.okCaptures.get(id);
      requireKnowledge(row && row.epoch === epoch && (await this.repo.state()).epoch === epoch, 'stale_operation');
      if (row.version === version + 1 && row.text === text) return row;
      requireKnowledge(row.version === version, 'draft_conflict');
      const next = { ...row, text, version: version + 1, savedRevision: null };
      await this.db.okCaptures.put(next); return next;
    });
  }
  async save(id: string, epoch: number, version: number): Promise<NoteReceipt> {
    const note = await this.db.okCaptures.get(id);
    requireKnowledge(note && note.epoch === epoch && (await this.repo.state()).epoch === epoch, 'stale_operation');
    requireKnowledge(note.version === version, 'draft_conflict');
    if (note.savedRevision) return this.receipt(note, note.savedRevision);
    await this.repo.migrateLegacy();
    const view = await this.repo.readPage(videoPageId(note.anchor.bvid));
    // Do not silently resolve existing branches when appending a new note.
    requireKnowledge(view.heads.length <= 1, 'conflict');
    const source = await captureSource(note), prior = view.heads[0] ?? null;
    const previousSource = note.savedSource ? await this.repo.readSource(note.savedSource) : undefined;
    const existing = view.revisions.find(row => row.sourceIds.includes(source.id));
    const row = existing ?? await this.repo.save(appendCapturedNote(prior, note, source, previousSource), prior ? [prior.id] : [],
      { sources: [...note.sources, source], attachments: note.images }, { expectedEpoch: epoch, capture: { id, version, sourceId: source.id } });
    return this.receipt(note, row.id);
  }
  private async receipt(note: CapturedNote, revision: string): Promise<NoteReceipt> {
    return { id: note.id, pageId: videoPageId(note.anchor.bvid), revision,
      status: (await this.repo.status()).pending === 0 && !!(await this.repo.state()).libraryId ? 'directory' : 'local',
      imageIds: note.images.map(image => image.id) };
  }
  async finish(id: string, epoch: number, version: number): Promise<void> {
    await this.db.transaction('rw', this.db.okCaptures, this.db.okMeta, async () => {
      const row = await this.db.okCaptures.get(id);
      requireKnowledge((await this.repo.state()).epoch === epoch, 'stale_operation');
      if (!row) return;
      requireKnowledge(row.epoch === epoch && row.version === version && row.savedRevision, 'draft_conflict');
      await this.db.okCaptures.delete(id);
    });
  }
  async mirrorLegacy(asset: LearningAsset, epoch: number, fullSources: KnowledgeSource[] = []): Promise<void> {
    requireKnowledge((await this.repo.state()).epoch === epoch, 'stale_operation');
    await this.repo.migrateLegacy();
    const view = await this.repo.readPage(videoPageId(asset.video.bvid));
    requireKnowledge(view.heads.length <= 1, 'conflict');
    const item = (await legacyMigration([asset], emptyWiki()))[0];
    const prior = view.heads[0] ?? { ...item.page, body: '', sourceIds: [], legacyIds: [] };
    const resources = [...item.sources.filter(source => source.kind === 'legacy'), ...fullSources];
    const already = prior.legacyIds.includes(asset.id);
    if (already && resources.every(source => prior.sourceIds.includes(source.id))) return;
    await this.repo.save({ ...prior, archived: false, body: already ? prior.body : [prior.body, item.page.body].filter(Boolean).join('\n\n'),
      sourceIds: [...new Set([...prior.sourceIds, ...resources.map(source => source.id)])],
      legacyIds: [...new Set([...prior.legacyIds, asset.id])] }, view.heads.map(row => row.id), { sources: resources }, { expectedEpoch: epoch });
  }
}
