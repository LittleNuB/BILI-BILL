import { digest, jsonBytes, requireKnowledge, videoPageId, type KnowledgePage, type KnowledgeRevision } from './format.ts';
import { createSource, type KnowledgeSource } from './sources.ts';
import type { KnowledgeRepository } from '../../background/storage/open-knowledge-repo.ts';

export interface KnowledgeReader {
  pageIds(): Promise<string[]>;
  readPage(id: string): Promise<{ revisions: KnowledgeRevision[]; heads: KnowledgeRevision[] }>;
  readSource(id: string): Promise<KnowledgeSource>;
}
export interface KnowledgeEntry { head: KnowledgeRevision; conflicts: number; metadataOnly: boolean; excerpt: string; matchSourceId?: string }
export function personalPage(title = '未命名页面', now = Date.now()): KnowledgePage {
  return { pageId: `page-${crypto.randomUUID()}`, kind: 'personal', bvid: null, title, body: '', aiNotes: '',
    topics: [], sourceIds: [], attachmentIds: [], legacyIds: [], createdAt: now };
}
export function hasKnowledge(page: KnowledgePage): boolean {
  return page.kind === 'personal' || !!(page.body.trim() || page.aiNotes.trim() || page.attachmentIds.length || page.legacyIds.length);
}
export async function listKnowledge(reader: KnowledgeReader,
  options: { query?: string; topic?: string; includeMetadata?: boolean; archived?: boolean } = {}): Promise<KnowledgeEntry[]> {
  const result: KnowledgeEntry[] = [], query = (options.query ?? '').trim().toLocaleLowerCase().slice(0, 256);
  for (const id of await reader.pageIds()) {
    const { heads } = await reader.readPage(id), head = heads[0]; if (!head) continue;
    if (head.archived !== !!options.archived || (options.topic && !head.topics.includes(options.topic))) continue;
    const metadataOnly = !hasKnowledge(head); if (metadataOnly && !options.includeMetadata) continue;
    let content = `${head.title}\n${head.topics.join(' ')}\n${head.body}\n${head.aiNotes}`, matchSourceId: string | undefined;
    let match = query ? content.toLocaleLowerCase().indexOf(query) : 0;
    if (query && match < 0) for (const sourceId of [...new Set(heads.flatMap(row => row.sourceIds))]) {
      const source = await reader.readSource(sourceId); const index = source.text.toLocaleLowerCase().indexOf(query);
      if (index >= 0) { content = source.text; match = index; matchSourceId = sourceId; break; }
    }
    if (match < 0) continue;
    result.push({ head, conflicts: heads.length - 1, metadataOnly,
      excerpt: query ? content.slice(Math.max(0, match - 50), Math.max(0, match - 50) + 220) : (head.body || head.aiNotes).slice(0, 220),
      ...(matchSourceId ? { matchSourceId } : {}) });
  }
  return result.sort((a, b) => b.head.updatedAt - a.head.updatedAt || a.head.pageId.localeCompare(b.head.pageId));
}
export async function restoreKnowledge(repo: KnowledgeRepository, revision: KnowledgeRevision, parents: string[]) {
  const stored = await repo.readPage(revision.pageId);
  const original = stored.revisions.find(row => row.id === revision.id); requireKnowledge(original, 'missing_revision');
  return repo.save(original, parents, {}, { actor: 'restore' });
}
export interface FavoriteImportItem { bvid: string; title: string; authorName: string; duration: number; cover: string }
export function favoriteSourceFolder(source: KnowledgeSource): string | null {
  return source.kind === 'external' ? /^favorites:([1-9][0-9]*):[a-f0-9]{64}$/.exec(source.version ?? '')?.[1] ?? null : null;
}
export async function importFavoriteItems(repo: KnowledgeRepository, folder: { mediaId: number; title: string },
  items: FavoriteImportItem[], signal?: AbortSignal): Promise<{ imported: number; unchanged: number }> {
  requireKnowledge(Number.isSafeInteger(folder.mediaId) && folder.mediaId > 0 && items.length <= 4096, 'favorites');
  let imported = 0, unchanged = 0;
  const seen = new Set<string>();
  for (const item of items) {
    if (signal?.aborted) throw new DOMException('Import stopped', 'AbortError');
    const id = videoPageId(item.bvid); if (seen.has(id)) continue; seen.add(id);
    const state = await repo.readPage(id); requireKnowledge(state.heads.length <= 1, 'conflict');
    const previous = state.heads[0];
    const text = JSON.stringify({ folder: { mediaId: folder.mediaId, title: folder.title }, video: {
      bvid: item.bvid, title: item.title, authorName: item.authorName, duration: item.duration,
      cover: item.cover, url: `https://www.bilibili.com/video/${item.bvid}/`,
    } }, null, 2);
    const version = `favorites:${folder.mediaId}:${await digest(jsonBytes(text))}`;
    const sources = await Promise.all((previous?.sourceIds ?? []).map(id => repo.readSource(id)));
    if (sources.some(source => source.version === version)) { unchanged++; continue; }
    const now = Date.now();
    const source = await createSource({ kind: 'external', video: { bvid: item.bvid, title: item.title, cid: null, page: null },
      label: folder.title, language: null, version, capturedAt: now, text, segments: [], derivedFrom: null, legacyAsset: null });
    const sourceIds = [...sources.filter(row => favoriteSourceFolder(row) !== String(folder.mediaId)).map(row => row.id), source.id];
    const page: KnowledgePage = previous ? { ...previous, sourceIds,
      title: hasKnowledge(previous) ? previous.title : item.title } : {
      pageId: id, kind: 'video', bvid: item.bvid, title: item.title, body: '', aiNotes: '', topics: [], sourceIds,
      attachmentIds: [], legacyIds: [], createdAt: now,
    };
    if (signal?.aborted) throw new DOMException('Import stopped', 'AbortError');
    await repo.save(page, previous ? [previous.id] : [], { sources: [source] }); imported++;
  }
  return { imported, unchanged };
}

export function knowledgeError(error: unknown): string {
  const name = error instanceof Error ? error.name : '', message = error instanceof Error ? error.message : '';
  if (name === 'AbortError') return '已取消，已保存的内容保留。';
  if (name === 'NotAllowedError' || message.includes('permission')) return '目录权限已失效。本地记录仍在，请重新连接。';
  if (message.includes('conflict') || message.includes('missing_parent')) return '页面已有新的修改。草稿已保留，请查看最新版本后再保存。';
  if (message.includes('library_mismatch')) return '这不是之前连接的知识库，请选择原目录。';
  if (message.includes('capacity') || message.includes('image_size')) return '内容超过本次处理上限，请缩小范围后重试。';
  if (message.includes('NOT_LOGGED_IN')) return '请先在 B 站登录，再读取收藏夹。';
  if (message.includes('browser_unsupported')) return '当前浏览器不支持目录连接，请在 Chrome 或 Edge 中打开工作台。';
  if (message.includes('integrity') || message.includes('format')) return '资料文件不完整或已被外部改写，未覆盖本地内容。请检查历史版本。';
  return '操作未完成，已保存的内容保留。请重试。';
}
