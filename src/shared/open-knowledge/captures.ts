import { requireKnowledge, shortText, videoPageId, type KnowledgePage } from './format.ts';
import { createSource, type KnowledgeSource, type KnowledgeAttachment } from './sources.ts';
import { learningTime } from '../learning.ts';

export interface NoteAnchor {
  bvid: string; cid: string; page: number; title: string;
  timeMs: number | null; capturedAt: number; method: 'note' | 'frame' | 'page-crop' | 'upload';
  endMs?: number;
}
export interface CapturedNote {
  id: string; key: string; epoch: number; version: number; anchor: NoteAnchor;
  text: string; quote: string; sources: KnowledgeSource[]; images: KnowledgeAttachment[];
  savedRevision: string | null; savedSource: string | null;
}
export interface NoteReceipt { id: string; pageId: string; revision: string; status: 'local' | 'directory'; imageIds: string[] }
export function noteKey(anchor: Pick<NoteAnchor, 'bvid' | 'cid' | 'page'>): string { return `${anchor.bvid}:${anchor.cid}:${anchor.page}`; }
export function validateAnchor(anchor: NoteAnchor): void {
  videoPageId(anchor.bvid); shortText(anchor.title, 4096);
  requireKnowledge(/^[1-9][0-9]{0,19}$/.test(anchor.cid) && Number.isSafeInteger(anchor.page) && anchor.page > 0, 'part');
  requireKnowledge(anchor.timeMs === null || Number.isSafeInteger(anchor.timeMs) && anchor.timeMs >= 0 && anchor.timeMs < 86400000, 'timeline');
  requireKnowledge(Number.isSafeInteger(anchor.capturedAt) && anchor.capturedAt >= 0, 'date');
  requireKnowledge(['note', 'frame', 'page-crop', 'upload'].includes(anchor.method), 'capture');
  if (anchor.endMs !== undefined) requireKnowledge(Number.isSafeInteger(anchor.endMs) && anchor.timeMs !== null && anchor.endMs >= anchor.timeMs && anchor.endMs - anchor.timeMs <= 2000, 'timeline');
}
export function captionContext(anchor: NoteAnchor, sources: KnowledgeSource[]) {
  const original = sources.find(source => source.kind === 'subtitles');
  if (!original || anchor.timeMs === null) return { overlapping: [], nearby: [] };
  const start = anchor.timeMs, end = anchor.endMs ?? start;
  const overlapping = original.segments.filter(line => line.fromMs <= start && line.toMs > end);
  const nearby = original.segments.filter(line => !overlapping.includes(line) && line.toMs > start - 15000 && line.fromMs < end + 15000).slice(0, 8);
  return { overlapping, nearby };
}
export function noteBody(note: CapturedNote): string {
  const { anchor } = note, captions = captionContext(anchor, note.sources);
  const time = anchor.timeMs === null ? '' : ` · ${learningTime(anchor.timeMs)}`;
  const url = `https://www.bilibili.com/video/${anchor.bvid}/?p=${anchor.page}${anchor.timeMs === null ? '' : `&t=${Math.floor(anchor.timeMs / 1000)}`}`;
  const quote = (value: string) => value.replace(/\n/g, '\n> ');
  return [
    `### ${anchor.method === 'note' ? '笔记' : anchor.method === 'upload' ? '插图' : '截图'} · P${anchor.page}${time}`,
    note.text.trim(),
    ...note.images.map(image => `![${anchor.method === 'upload' ? '插图' : '视频画面'}](../../attachments/${image.id}.${image.extension})`),
    note.quote ? `引用字幕\n\n> ${quote(note.quote)}` : '',
    captions.overlapping.length ? `当时字幕\n\n> ${captions.overlapping.map(line => quote(line.text)).join('\n> ')}` : '',
    captions.nearby.length ? `附近讲解（非该帧字幕）\n\n> ${captions.nearby.map(line => `${learningTime(line.fromMs)} ${quote(line.text)}`).join('\n> ')}` : '',
    anchor.method === 'page-crop' ? '页面截图时间取捕获期间的播放区间，附近讲解仅供对照。' : '',
    `[来源视频](${url})`,
  ].filter(Boolean).join('\n\n');
}
export async function captureSource(note: CapturedNote): Promise<KnowledgeSource> {
  const { bvid, cid, page, title, capturedAt } = note.anchor;
  return createSource({ kind: 'external', video: { bvid, cid, page, title }, label: '图文记录', language: null,
    version: `capture:${note.id}:${note.version}`, capturedAt, text: noteBody(note),
    segments: captionContext(note.anchor, note.sources).overlapping, derivedFrom: null, legacyAsset: null });
}
export function appendCapturedNote(prior: KnowledgePage | null, note: CapturedNote, source: KnowledgeSource, previousSource?: KnowledgeSource): KnowledgePage {
  const marker = `[原始记录](../../sources/${source.id}.json)`;
  const block = [noteBody(note), marker].join('\n\n');
  const old = previousSource ? `${previousSource.text}\n\n[原始记录](../../sources/${previousSource.id}.json)` : null;
  // Only replace our unchanged generated block. An externally edited block remains intact.
  const body = prior && old && prior.body.split(old).length === 2 ? prior.body.replace(old, block) : [prior?.body, block].filter(Boolean).join('\n\n');
  return { ...(prior ?? { pageId: videoPageId(note.anchor.bvid), kind: 'video', bvid: note.anchor.bvid,
    title: note.anchor.title || '视频笔记', body: '', aiNotes: '', topics: [], sourceIds: [], attachmentIds: [], legacyIds: [], createdAt: note.anchor.capturedAt }),
    body, archived: false,
    sourceIds: [...new Set([...(prior?.sourceIds ?? []), ...note.sources.map(item => item.id), source.id])],
    attachmentIds: [...new Set([...(prior?.attachmentIds ?? []), ...note.images.map(image => image.id)])] };
}
