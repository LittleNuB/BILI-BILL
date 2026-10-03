import { validateLearningAsset, type LearningAsset } from '../learning.ts';
import { digest, exact, hashId, IMAGE_MAX_BYTES, jsonBytes, requireKnowledge, shortText, SOURCE_MAX_BYTES, videoPageId } from './format.ts';

export interface KnowledgeSource {
  format: 1;
  id: string;
  kind: 'subtitles' | 'optimized-subtitles' | 'legacy' | 'external';
  video: { bvid: string; title: string; cid: string | null; page: number | null } | null;
  label: string;
  language: string | null;
  version: string | null;
  capturedAt: number;
  text: string;
  segments: { fromMs: number; toMs: number; text: string }[];
  derivedFrom: string | null;
  legacyAsset: LearningAsset | null;
}
export function validateSource(value: unknown): asserts value is KnowledgeSource {
  exact(value, ['format', 'id', 'kind', 'video', 'label', 'language', 'version', 'capturedAt', 'text', 'segments', 'derivedFrom', 'legacyAsset']);
  const row = value as unknown as KnowledgeSource;
  hashId(row.id); requireKnowledge(row.format === 1, 'version');
  requireKnowledge(['subtitles', 'optimized-subtitles', 'legacy', 'external'].includes(row.kind), 'source');
  if (row.video !== null) {
    exact(row.video, ['bvid', 'title', 'cid', 'page']); videoPageId(row.video.bvid);
    shortText(row.video.title, 4096);
    requireKnowledge(row.video.cid === null && row.video.page === null || typeof row.video.cid === 'string'
      && /^[1-9][0-9]{0,19}$/.test(row.video.cid) && Number.isSafeInteger(row.video.page) && row.video.page! > 0, 'part');
  }
  if (row.kind === 'subtitles' || row.kind === 'optimized-subtitles') requireKnowledge(row.video?.cid && row.video.page, 'part');
  shortText(row.label, 4096); shortText(row.text, SOURCE_MAX_BYTES);
  if (row.language !== null) shortText(row.language, 128);
  if (row.version !== null) shortText(row.version, 256);
  requireKnowledge(Number.isSafeInteger(row.capturedAt) && row.capturedAt >= 0, 'date');
  requireKnowledge(Array.isArray(row.segments) && row.segments.length <= 50000, 'segments');
  let lastStart = -1;
  for (const segment of row.segments) {
    exact(segment, ['fromMs', 'toMs', 'text']);
    requireKnowledge(Number.isSafeInteger(segment.fromMs) && segment.fromMs >= 0 && segment.fromMs >= lastStart
      && Number.isSafeInteger(segment.toMs) && segment.toMs > segment.fromMs, 'timeline');
    shortText(segment.text, 65536); lastStart = segment.fromMs;
  }
  if (row.kind === 'optimized-subtitles') hashId(row.derivedFrom);
  else requireKnowledge(row.derivedFrom === null, 'source');
  if (row.legacyAsset !== null) { requireKnowledge(row.kind === 'legacy', 'source'); validateLearningAsset(row.legacyAsset); }
  requireKnowledge(jsonBytes(row).length <= SOURCE_MAX_BYTES, 'capacity');
}
export async function createSource(input: Omit<KnowledgeSource, 'format' | 'id'>): Promise<KnowledgeSource> {
  const payload = { ...input, format: 1 as const };
  const row = { ...payload, id: await digest(jsonBytes(payload)) }; validateSource(row); return row;
}
export async function parseSource(text: string): Promise<KnowledgeSource> {
  shortText(text, SOURCE_MAX_BYTES); const row: unknown = JSON.parse(text); validateSource(row);
  const { id, ...payload } = row; requireKnowledge(id === await digest(jsonBytes(payload)), 'integrity'); return row;
}
export interface KnowledgeAttachment { id: string; extension: 'png' | 'jpg' | 'webp'; bytes: Uint8Array }
export async function imageAttachment(bytes: Uint8Array): Promise<KnowledgeAttachment> {
  requireKnowledge(bytes.length > 0 && bytes.length <= IMAGE_MAX_BYTES, 'image_size');
  const same = (offset: number, values: number[]) => values.every((v, i) => bytes[offset + i] === v);
  const extension = same(0, [137, 80, 78, 71, 13, 10, 26, 10]) ? 'png'
    : same(0, [255, 216, 255]) ? 'jpg'
      : same(0, [82, 73, 70, 70]) && same(8, [87, 69, 66, 80]) ? 'webp' : null;
  requireKnowledge(extension, 'image_type');
  return { id: await digest(bytes), extension, bytes: bytes.slice() };
}
