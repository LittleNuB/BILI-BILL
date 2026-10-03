import { db } from './storage/db.ts';
import { KnowledgeRepository } from './storage/open-knowledge-repo.ts';
import { refreshReadonlyReferences } from './storage/open-knowledge-references.ts';
import { retrieveKnowledgeSections, type KnowledgeReference, type KnowledgeSection } from '../shared/knowledge-chat.ts';
import { hashId, pageId, requireKnowledge } from '../shared/open-knowledge/format.ts';
import { hasKnowledge } from '../shared/open-knowledge/workspace.ts';
import { stableDigestHex } from '../shared/stable-digest.ts';

export async function retrieveOpenKnowledge(question: string) {
  const repo = new KnowledgeRepository(db), migrated = new Set<string>(); let refs: KnowledgeReference[] = [];
  const external = await refreshReadonlyReferences(repo), stamp = await openKnowledgeStamp();
  const add = (sections: KnowledgeSection[]) => {
    refs = retrieveKnowledgeSections(question, [...refs.map(ref => ({ ...ref, text: ref.excerpt })), ...sections]);
  };
  for (const id of await repo.pageIds()) {
    const { heads } = await repo.readPage(id);
    for (const row of heads) {
      row.legacyIds.forEach(id => migrated.add(id));
      if (row.archived || !hasKnowledge(row)) continue;
      const common = { id: row.id, title: row.title, videoTitle: row.bvid ? row.title : '', bvid: row.bvid ?? '', page: null,
        digest: row.id, location: { kind: 'page' as const, pageId: row.pageId, revisionId: row.id } };
      const prefix = heads.length > 1 ? '待合并版本·' : '';
      add([{ ...common, label: prefix + '个人笔记', text: row.body }, { ...common, label: prefix + 'AI 补充', text: row.aiNotes }]);
      for (const sourceId of row.sourceIds) {
        const source = await repo.readSource(sourceId);
        if (source.version?.startsWith('favorites:') || source.kind === 'legacy') continue;
        add([{ ...common, id: source.id, digest: source.id, page: source.video?.page ?? null,
          videoTitle: source.video?.title ?? common.videoTitle, label: prefix + (source.kind === 'optimized-subtitles' ? 'AI 优化字幕' : source.label),
          text: source.text, location: { ...common.location, sourceId } }]);
      }
    }
  }
  for (const ref of external) if (ref.available) add([{ id: stableDigestHex('reference:' + ref.id),
    title: ref.name, videoTitle: '', bvid: '', page: null, label: '外部只读资料', text: ref.text, digest: ref.digest,
    location: { kind: 'reference', referenceId: ref.id } }]);
  requireKnowledge(stamp === await openKnowledgeStamp(), 'stale_operation');
  return { refs, migrated, stamp };
}
export async function openKnowledgeStamp(): Promise<string> {
  const state = await new KnowledgeRepository(db).state(); return state.epoch || state.sequence ? `:open:${state.epoch}:${state.sequence}` : '';
}
export async function handleKnowledgeReference(input: Record<string, unknown>) {
  try {
    hashId(input.digest); const repo = new KnowledgeRepository(db);
    if (input.kind === 'page') {
      pageId(input.pageId); hashId(input.revisionId);
      const { heads, revisions } = await repo.readPage(input.pageId);
      const old = revisions.find(row => row.id === input.revisionId);
      if (input.sourceId !== undefined) { hashId(input.sourceId); requireKnowledge(old?.sourceIds.includes(input.sourceId), 'scope'); }
      return { success: true, data: { available: heads.some(row => !row.archived), current: heads.some(row => row.id === input.revisionId && !row.archived) } };
    }
    requireKnowledge(input.kind === 'reference' && typeof input.referenceId === 'string', 'scope');
    const row = (await refreshReadonlyReferences(repo)).find(row => row.id === input.referenceId);
    return { success: true, data: { available: !!row?.available, current: !!row?.available && row.digest === input.digest } };
  } catch { return { success: false, error: '暂时无法核对原条目，已保存的引用仍可查看。' }; }
}
