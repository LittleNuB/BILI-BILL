import { canonicalLearning, validateLearningAsset, type LearningAsset } from '../learning.ts';
import { validateWiki, type WikiState } from '../video-wiki.ts';
import { createSource, type KnowledgeSource } from './sources.ts';
import { videoPageId, type KnowledgePage } from './format.ts';

export async function legacyMigration(assets: LearningAsset[], wiki: WikiState): Promise<{ page: KnowledgePage; sources: KnowledgeSource[]; updatedAt: number }[]> {
  assets.forEach(validateLearningAsset); validateWiki(wiki);
  const organization = await createSource({ kind: 'external', video: null, label: '迁移前的主题与关联', language: null,
    version: String(wiki.revision), capturedAt: 0, text: canonicalLearning(wiki), segments: [], derivedFrom: null, legacyAsset: null });
  const groups = new Map<string, LearningAsset[]>();
  for (const asset of [...assets].sort((a, b) => a.id.localeCompare(b.id))) {
    const group = groups.get(asset.video.bvid) ?? []; group.push(asset); groups.set(asset.video.bvid, group);
  }
  for (const page of wiki.pages) if (!groups.has(page.bvid)) groups.set(page.bvid, []);
  const result: { page: KnowledgePage; sources: KnowledgeSource[]; updatedAt: number }[] = [];
  for (const [bvid, group] of groups) {
    const priorPage = wiki.pages.find(page => page.bvid === bvid), sources: KnowledgeSource[] = [organization], sections: string[] = [];
    for (const asset of group) {
      const source = await createSource({ kind: 'legacy', video: { ...asset.video, cid: asset.part?.cid ?? null, page: asset.part?.page ?? null },
        label: asset.personal.title || '原笔记', language: null, version: asset.snapshot?.source.hash ?? null, capturedAt: asset.updatedAt,
        text: asset.snapshot?.body ?? asset.personal.note,
        segments: [...asset.snapshot?.citations ?? []].sort((a, b) => a.fromMs - b.fromMs), derivedFrom: null, legacyAsset: asset });
      sources.push(source);
      const position = asset.bookmarkMs === null ? '' : ` · ${Math.floor(asset.bookmarkMs / 60000)}:${String(Math.floor(asset.bookmarkMs / 1000) % 60).padStart(2, '0')}`;
      sections.push(`### ${asset.personal.title || '笔记'}\n\n${asset.part ? `P${asset.part.page}${position}\n\n` : ''}${asset.personal.note}${asset.snapshot ? `\n\n> ${asset.snapshot.body.replace(/\n/g, '\n> ')}` : ''}\n\n[原始记录](../../sources/${source.id}.json)`);
    }
    const wikiTopics = wiki.topics.filter(topic => wiki.relations.some(relation => relation.bvid === bvid && relation.topicId === topic.id && relation.mode === 'include'))
      .sort((a, b) => a.id.localeCompare(b.id)).map(topic => topic.name);
    const allTopics = [...new Set([...wikiTopics, ...group.flatMap(asset => asset.personal.tags)])];
    // Only the page index is bounded; immutable sources retain every tag and Wiki decision.
    const topics = allTopics.slice(0, 128);
    if (allTopics.length > topics.length) sections.push(`## 迁移主题说明\n\n主题索引仅收录 ${topics.length} / ${allTopics.length} 项（Wiki 显式主题优先，其后按原始记录顺序收录标签）。完整旧标签保留在各条「原始记录」中；完整 Wiki 主题与包含/排除关系见[迁移前的主题与关联](../../sources/${organization.id}.json)。`);
    const createdAt = Math.min(...group.map(asset => asset.createdAt), priorPage?.createdAt ?? Infinity);
    result.push({ page: { pageId: videoPageId(bvid), kind: 'video', bvid, title: group[0]?.video.title || bvid,
      body: sections.join('\n\n'), aiNotes: '', topics,
      sourceIds: sources.map(source => source.id), attachmentIds: [], legacyIds: group.map(asset => asset.id),
      createdAt: Number.isFinite(createdAt) ? createdAt : 0, archived: priorPage?.deleted ?? false },
      sources, updatedAt: Math.max(createdAt || 0, ...group.map(asset => asset.updatedAt)) });
  }
  return result;
}
