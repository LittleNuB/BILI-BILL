import { canonicalLearning } from '../learning.ts';

export const KNOWLEDGE_FORMAT = 'bili-bill-open-knowledge';
export const PAGE_MAX_BYTES = 16 * 1024 * 1024;
export const SOURCE_MAX_BYTES = 32 * 1024 * 1024;
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const textBytes = (text: string) => new TextEncoder().encode(text);
export const jsonBytes = (value: unknown) => textBytes(canonicalLearning(value));
export function requireKnowledge(value: unknown, code: string): asserts value {
  if (!value) throw new Error(`knowledge_${code}`);
}
export async function digest(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function hashId(value: unknown): asserts value is string {
  requireKnowledge(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'id');
}
export function pageId(value: unknown): asserts value is string {
  requireKnowledge(typeof value === 'string' && /^(video-[a-f0-9]{24}|page-[a-f0-9-]{36})$/.test(value), 'page_id');
}
export function videoPageId(bvid: string): string {
  requireKnowledge(/^BV[a-zA-Z0-9]{10}$/.test(bvid), 'video');
  return `video-${[...textBytes(bvid)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
export function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  requireKnowledge(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(','), 'format');
}
export function shortText(value: unknown, max: number): asserts value is string {
  requireKnowledge(typeof value === 'string' && textBytes(value).length <= max
    && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value), 'text');
}
export function ids(value: unknown, max = 2048): asserts value is string[] {
  requireKnowledge(Array.isArray(value) && value.length <= max && new Set(value).size === value.length, 'references');
  value.forEach(hashId);
}
export interface KnowledgePage {
  pageId: string;
  kind: 'video' | 'personal';
  bvid: string | null;
  title: string;
  body: string;
  aiNotes: string;
  topics: string[];
  sourceIds: string[];
  attachmentIds: string[];
  legacyIds: string[];
  createdAt: number;
  archived?: boolean;
}
export type KnowledgeActor = 'browser' | 'codex' | 'migration' | 'restore';
export interface KnowledgeRevision extends KnowledgePage {
  archived: boolean;
  format: 1;
  id: string;
  parents: string[];
  updatedAt: number;
  actor: KnowledgeActor;
  proposalId: string | null;
}
const pageKeys = ['pageId', 'kind', 'bvid', 'title', 'body', 'aiNotes', 'topics', 'sourceIds', 'attachmentIds', 'legacyIds', 'createdAt', 'archived'];
const revisionKeys = [...pageKeys, 'format', 'id', 'parents', 'updatedAt', 'actor', 'proposalId'];
export function validatePage(value: unknown): asserts value is KnowledgePage {
  const row = value as KnowledgePage;
  requireKnowledge(row && typeof row === 'object', 'format');
  pageId(row.pageId);
  requireKnowledge(row.kind === 'personal' && row.bvid === null && row.pageId.startsWith('page-')
    || row.kind === 'video' && typeof row.bvid === 'string' && row.pageId === videoPageId(row.bvid), 'video');
  shortText(row.title, 4096); requireKnowledge(row.title.trim().length > 0, 'title');
  shortText(row.body, PAGE_MAX_BYTES); shortText(row.aiNotes, PAGE_MAX_BYTES);
  requireKnowledge(Array.isArray(row.topics) && row.topics.length <= 128 && new Set(row.topics).size === row.topics.length, 'topics');
  row.topics.forEach(topic => shortText(topic, 256));
  ids(row.sourceIds); ids(row.attachmentIds); ids(row.legacyIds);
  requireKnowledge(Number.isSafeInteger(row.createdAt) && row.createdAt >= 0, 'date');
  requireKnowledge(typeof row.archived === 'boolean', 'archived');
}
export function validateRevision(value: unknown): asserts value is KnowledgeRevision {
  exact(value, revisionKeys); validatePage(value);
  const row = value as unknown as KnowledgeRevision;
  requireKnowledge(row.format === 1, 'version'); hashId(row.id); ids(row.parents, 32);
  requireKnowledge(!row.parents.includes(row.id), 'cycle');
  requireKnowledge(Number.isSafeInteger(row.updatedAt) && row.updatedAt >= row.createdAt, 'date');
  requireKnowledge(['browser', 'codex', 'migration', 'restore'].includes(row.actor), 'actor');
  if (row.proposalId !== null) hashId(row.proposalId);
  requireKnowledge(jsonBytes(row).length <= PAGE_MAX_BYTES, 'capacity');
}
export async function createRevision(page: KnowledgePage, parents: string[], actor: KnowledgeActor,
  updatedAt = Date.now(), proposalId: string | null = null): Promise<KnowledgeRevision> {
  // Pick page fields explicitly so an existing revision can be the basis of a new one.
  const fields = Object.fromEntries(pageKeys.map(key => [key, page[key as keyof KnowledgePage]])) as unknown as KnowledgePage;
  const payload = { ...fields, body: fields.body.replace(/\r\n/g, '\n'), aiNotes: fields.aiNotes.replace(/\r\n/g, '\n'),
    archived: page.archived ?? false, format: 1 as const, parents: [...parents].sort(), updatedAt, actor, proposalId };
  const row = { ...payload, id: await digest(jsonBytes(payload)) };
  validateRevision(row); return row;
}
const aiDivider = '\n\n## AI 补充\n\n';
export function serializeRevision(row: KnowledgeRevision): string {
  validateRevision(row);
  const { body, aiNotes, ...metadata } = row;
  return `---\nbili_bill: ${canonicalLearning({ ...metadata, bodyLength: body.length })}\n---\n\n${body}${aiDivider}${aiNotes}`;
}
export async function parseRevision(text: string): Promise<KnowledgeRevision> {
  shortText(text, PAGE_MAX_BYTES + 8192);
  text = text.replace(/\r\n/g, '\n');
  requireKnowledge(text.startsWith('---\nbili_bill: '), 'format');
  const boundary = text.indexOf('\n---\n\n'); requireKnowledge(boundary > 0, 'format');
  const metadata = JSON.parse(text.slice(15, boundary));
  exact(metadata, [...revisionKeys.filter(key => key !== 'body' && key !== 'aiNotes'), 'bodyLength']);
  const { bodyLength, ...fields } = metadata;
  requireKnowledge(Number.isSafeInteger(bodyLength) && (bodyLength as number) >= 0, 'format');
  const content = text.slice(boundary + 6), length = bodyLength as number;
  requireKnowledge(content.slice(length, length + aiDivider.length) === aiDivider, 'integrity');
  const row = { ...fields, body: content.slice(0, length), aiNotes: content.slice(length + aiDivider.length) };
  validateRevision(row);
  const { id, ...payload } = row;
  requireKnowledge(id === await digest(jsonBytes(payload)), 'integrity');
  return row;
}
export function revisionHeads(rows: KnowledgeRevision[]): KnowledgeRevision[] {
  const byId = new Map(rows.map(row => [row.id, row]));
  requireKnowledge(byId.size === rows.length && new Set(rows.map(row => row.pageId)).size <= 1, 'graph');
  const parents = new Set<string>();
  for (const row of rows) for (const id of row.parents) {
    requireKnowledge(byId.has(id) && id !== row.id, 'missing_parent'); parents.add(id);
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string) => {
    requireKnowledge(!visiting.has(id), 'cycle'); if (visited.has(id)) return;
    visiting.add(id); byId.get(id)!.parents.forEach(visit); visiting.delete(id); visited.add(id);
  };
  rows.forEach(row => visit(row.id));
  return rows.filter(row => !parents.has(row.id)).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}
export interface KnowledgeLibrary { format: typeof KNOWLEDGE_FORMAT; version: 1; id: string }
export function validateLibrary(value: unknown): asserts value is KnowledgeLibrary {
  exact(value, ['format', 'version', 'id']);
  requireKnowledge(value.format === KNOWLEDGE_FORMAT && value.version === 1, 'version');
  requireKnowledge(typeof value.id === 'string' && /^[a-f0-9-]{36}$/.test(value.id), 'library_id');
}
