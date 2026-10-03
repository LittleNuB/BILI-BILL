import { db } from '../storage/db.ts';
import { KnowledgeNotes } from '../storage/knowledge-notes.ts';
import { requireKnowledge } from '../../shared/open-knowledge/format.ts';
import { noteKey, validateAnchor, captionContext, type NoteAnchor, type CapturedNote } from '../../shared/open-knowledge/captures.ts';
import type { KnowledgeSource } from '../../shared/open-knowledge/sources.ts';
import { normalizedImage, imageDataUrl } from '../../shared/open-knowledge/images.ts';
import { BrowserKnowledgeFiles } from '../../shared/open-knowledge/browser-files.ts';
import { KnowledgeDirectory } from '../../shared/open-knowledge/directory.ts';

const notes = new KnowledgeNotes(db);
export type NoteSourceResolver = (tabId: number, anchor: NoteAnchor, selected: unknown, quote: unknown) => Promise<{ sources: KnowledgeSource[]; quote: string }>;
let synchronization: { key: string; run: Promise<void> } | null = null;
export async function flushNoteDirectory(): Promise<void> {
  const state = await notes.repo.state(), key = `${state.epoch}:${state.connectionRevision ?? 0}`;
  if (synchronization?.key === key) return synchronization.run;
  const run = (async () => {
    const handle = state.handle;
    if (!handle) return;
    const files = new BrowserKnowledgeFiles(handle);
    if (await files.permission()) await notes.repo.sync(new KnowledgeDirectory(files), state);
  })();
  synchronization = { key, run };
  try { await run; } finally { if (synchronization?.run === run) synchronization = null; }
}
const publicNote = (note: CapturedNote | null) => note && ({ ...note, sources: [], captions: captionContext(note.anchor, note.sources), images: note.images.map(image => ({ id: image.id, data: imageDataUrl(image) })) });
export async function handleKnowledgeNote(params: Record<string, unknown>, tabId: number | null, resolve: NoteSourceResolver) {
  try {
    requireKnowledge(tabId !== null, 'tab');
    if (params.mode === 'epoch') return { success: true, data: (await notes.repo.state()).epoch };
    if (params.mode === 'load') {
      requireKnowledge(typeof params.key === 'string' && params.key.length < 128, 'capture');
      return { success: true, data: publicNote(await notes.load(params.key)) };
    }
    if (params.mode === 'list') {
      requireKnowledge(typeof params.key === 'string' && params.key.length < 128, 'capture');
      return { success: true, data: (await db.okCaptures.where('key').equals(params.key).toArray()).map(row => ({ id: row.id, timeMs: row.anchor.timeMs, saved: !!row.savedRevision, text: row.text.slice(0, 40) })) };
    }
    if (params.mode === 'get') return { success: true, data: publicNote(await db.okCaptures.get(String(params.id)) ?? null) };
    if (params.mode === 'begin') {
      const anchor = params.anchor as NoteAnchor; validateAnchor(anchor);
      const epoch = (await notes.repo.state()).epoch;
      requireKnowledge(params.epoch === epoch, 'stale_operation');
      const prior = await db.okCaptures.get(String(params.id));
      if (prior) { requireKnowledge(prior.epoch === epoch && prior.key === noteKey(anchor), 'capture'); return { success: true, data: publicNote(prior) }; }
      const resolved = await resolve(tabId, anchor, params.selectedSourceIdentityKey, params.quote);
      const images = params.image ? [await normalizedImage(params.image)] : [];
      const row = await notes.begin({ id: String(params.id), key: noteKey(anchor), epoch, version: 0, anchor,
        text: '', quote: resolved.quote, sources: resolved.sources, images, savedRevision: null, savedSource: null });
      return { success: true, data: publicNote(row) };
    }
    if (params.mode === 'edit') return { success: true, data: publicNote(await notes.edit(String(params.id), Number(params.epoch), Number(params.version), String(params.text ?? ''))) };
    if (params.mode === 'finish') { await notes.finish(String(params.id), Number(params.epoch), Number(params.version)); return { success: true, data: true }; }
    if (params.mode === 'save') {
      const receipt = await notes.save(String(params.id), Number(params.epoch), Number(params.version));
      try { await flushNoteDirectory(); } catch { /* Durable local save is not undone by unavailable directory access. */ }
      if ((await notes.repo.status()).pending === 0 && (await notes.repo.state()).libraryId) receipt.status = 'directory';
      return { success: true, data: receipt };
    }
    throw Error('knowledge_mode');
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    return { success: false, error: code.includes('conflict') ? '这条笔记或知识页已有其他修改，草稿仍保留，请在知识库处理后重试。'
      : code.includes('capacity') || code.includes('size') ? '草稿或图片空间不足，请先保存已有记录，或使用较小图片。'
      : code.includes('image') ? '图片暂不可用，请使用 PNG、JPEG 或 WebP（不超过 10 MB）。'
      : code.includes('stale') || code.includes('part') ? '视频或存储状态已变化，原草稿仍保留，请回到原视频重试。'
      : '本地保存未完成，草稿仍保留，请重试。' };
  }
}
