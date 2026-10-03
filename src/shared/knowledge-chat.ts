import type { LearningAsset } from './learning.ts';
import { stableDigestHex } from './stable-digest.ts';
import { fitChatText, serializedBytes } from './learning-chat-context.ts';
import type { CurrentVideoQaSessionRecord } from './types/current-video-qa-session.ts';

export interface KnowledgeReference {
  number: number; id: string; title: string; videoTitle: string; bvid: string;
  page: number | null; label: string; excerpt: string; digest: string;
  location?: { kind: 'page'; pageId: string; revisionId: string; sourceId?: string }
    | { kind: 'reference'; referenceId: string };
}
export interface KnowledgeSection extends Omit<KnowledgeReference, 'number' | 'excerpt'> { text: string }
export const KNOWLEDGE_MAX_REFERENCES = 6;
export const KNOWLEDGE_MAX_BYTES = 8192;
const stop = new Set(['这个', '那个', '如何', '什么', '怎么', '可以', '需要', '我们', '你们', '一下', '为什么', '哪些', '视频', '笔记', '知识库', '比较', '之前']);
const equivalents = [['测试', '检验', '验证'], ['需求', '要求'], ['稳定', '可靠'], ['交付', '上线'], ['上下文', '语境']];
function terms(text: string): string[] {
  const words = [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(text.normalize('NFKC').toLowerCase())]
    .filter(s => s.isWordLike && s.segment.length > 1 && !stop.has(s.segment)).map(s => s.segment);
  return [...new Set(words.flatMap(word => equivalents.find(group => group.includes(word)) ?? [word]))].slice(0, 32);
}
export function knowledgeDigest(asset: LearningAsset): string { return stableDigestHex(JSON.stringify(asset)); }
export function retrieveKnowledge(question: string, assets: LearningAsset[]): KnowledgeReference[] {
  return retrieveKnowledgeSections(question, assets.flatMap(asset => [
    { label: '个人笔记', text: asset.personal.note },
    { label: asset.snapshot?.origin === 'subtitle' ? '视频原文摘录' : '已保存模型内容', text: asset.snapshot?.body ?? '' },
  ].map(section => ({ ...section, id: asset.id, title: asset.personal.title, videoTitle: asset.video.title,
    bvid: asset.video.bvid, page: asset.part?.page ?? null, digest: knowledgeDigest(asset) }))));
}
export function retrieveKnowledgeSections(question: string, candidates: KnowledgeSection[]): KnowledgeReference[] {
  const words = terms(question);
  if (!words.length) return [];
  const sections = [...new Map(candidates.filter(item => item.text.trim()).map(item => [`${item.id}:${item.label}`, item])).values()];
  const ranked = sections.map(item => {
    const text = item.text.normalize('NFKC').toLowerCase();
    const hits = words.filter(word => text.includes(word));
    return { ...item, hits, score: hits.reduce((sum, word) => sum + 1 + Math.min(word.length, 8) / 8, 0) };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const refs: KnowledgeReference[] = [];
  for (const item of ranked) {
    if (refs.length >= KNOWLEDGE_MAX_REFERENCES) break;
    const start = Math.max(0, item.text.toLowerCase().indexOf(item.hits[0]) - 120);
    const excerpt = fitChatText(item.text.slice(start), 1050);
    const ref: KnowledgeReference = { number: refs.length + 1, id: item.id,
      title: fitChatText(item.title, 180), videoTitle: fitChatText(item.videoTitle, 180),
      bvid: item.bvid, page: item.page, label: item.label,
      excerpt: `${start ? '…' : ''}${excerpt}${start + excerpt.length < item.text.length ? '…' : ''}`, digest: item.digest,
      ...(item.location ? { location: item.location } : {}) };
    if (serializedBytes([...refs, ref]) <= KNOWLEDGE_MAX_BYTES) refs.push(ref);
  }
  return refs;
}
export function knowledgeMaterial(refs: KnowledgeReference[]): string {
  return refs.map(r => `[${r.number}] ${r.label}：${r.title}${r.videoTitle ? `\n关联视频：${r.videoTitle}${r.page ? ` · P${r.page}` : ''}` : ''}\n保存内容节选：${r.excerpt}`).join('\n\n');
}

// A changed library or revoked permission cuts derived history too, without deleting local conversations.
export function knowledgeSafeSession(session: CurrentVideoQaSessionRecord | null, stamp: string | null): { session: CurrentVideoQaSessionRecord | null; omitted: boolean } {
  if (!session) return { session: null, omitted: false };
  const first = session.turns.findIndex(t => t.knowledgeStamp && t.knowledgeStamp !== stamp);
  if (first < 0) return { session, omitted: false };
  return { session: { ...session, turns: session.turns.slice(0, first), learningContext: undefined }, omitted: true };
}
