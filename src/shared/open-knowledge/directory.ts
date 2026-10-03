import { KNOWLEDGE_FORMAT, hashId, jsonBytes, pageId, parseRevision, requireKnowledge, revisionHeads, serializeRevision, textBytes, validateLibrary,
  type KnowledgeLibrary, type KnowledgeRevision } from './format.ts';
import { imageAttachment, parseSource, type KnowledgeAttachment, type KnowledgeSource } from './sources.ts';
import { validateProposal, type KnowledgeProposal } from './proposals.ts';

export interface KnowledgeFiles {
  read(path: string): Promise<Uint8Array | null>;
  putImmutable(path: string, bytes: Uint8Array): Promise<void>;
  list(path: string): Promise<{ name: string; kind: 'file' | 'directory' }[]>;
}
export const decodeFile = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
export function safeKnowledgePath(path: string): string[] {
  requireKnowledge(typeof path === 'string' && path.length <= 240 && !path.includes('\\'), 'path');
  const parts = path.split('/');
  requireKnowledge(parts.every(part => /^[a-z0-9][a-z0-9._-]*$/.test(part) && !part.includes('..') && !part.endsWith('.')
    && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/.test(part)), 'path');
  requireKnowledge(/^(library\.json|pages\/(video-[a-f0-9]{24}|page-[a-f0-9-]{36})\/[a-f0-9]{64}\.md|sources\/[a-f0-9]{64}\.json|attachments\/[a-f0-9]{64}\.(png|jpg|webp)|proposals\/[a-f0-9]{64}\.json)$/.test(path), 'path');
  return parts;
}
export function safeKnowledgeDirectory(path: string): string[] {
  if (!path) return [];
  requireKnowledge(/^(pages|sources|attachments|proposals)(\/(video-[a-f0-9]{24}|page-[a-f0-9-]{36}))?$/.test(path), 'path');
  return path.split('/');
}
export interface KnowledgePageHistory { revisions: KnowledgeRevision[]; heads: KnowledgeRevision[]; byteLength: number }
function verifyDerivedSource(row: KnowledgeSource, original: KnowledgeSource) {
  requireKnowledge(original.kind === 'subtitles' && original.video?.bvid === row.video?.bvid
    && original.video?.cid === row.video?.cid && original.video?.page === row.video?.page
    && original.segments.length === row.segments.length
    && original.segments.every((segment, i) => segment.fromMs === row.segments[i].fromMs && segment.toMs === row.segments[i].toMs), 'timeline');
}
export class KnowledgeDirectory {
  readonly files: KnowledgeFiles;
  constructor(files: KnowledgeFiles) { this.files = files; }
  async connect(options: { create?: boolean; expectedId?: string } = {}): Promise<KnowledgeLibrary> {
    let bytes = await this.files.read('library.json');
    if (!bytes) {
      requireKnowledge(options.create && (await this.files.list('')).length === 0, 'not_library');
      const library: KnowledgeLibrary = { format: KNOWLEDGE_FORMAT, version: 1, id: options.expectedId ?? crypto.randomUUID() };
      validateLibrary(library); await this.files.putImmutable('library.json', jsonBytes(library));
      bytes = await this.files.read('library.json');
    }
    requireKnowledge(bytes && bytes.length <= 4096, 'not_library');
    const library: unknown = JSON.parse(decodeFile(bytes)); validateLibrary(library);
    requireKnowledge(!options.expectedId || library.id === options.expectedId, 'library_mismatch'); return library;
  }
  async readPage(id: string): Promise<KnowledgePageHistory> {
    pageId(id); const entries = await this.files.list(`pages/${id}`);
    requireKnowledge(entries.length <= 2000, 'capacity');
    const revisions: KnowledgeRevision[] = []; let totalBytes = 0;
    for (const entry of entries) {
      requireKnowledge(entry.kind === 'file' && /^[a-f0-9]{64}\.md$/.test(entry.name), 'unexpected_file');
      const bytes = await this.files.read(`pages/${id}/${entry.name}`);
      requireKnowledge(bytes, 'incomplete_write'); totalBytes += bytes.length; requireKnowledge(totalBytes <= 64 * 1024 * 1024, 'capacity');
      const row = await parseRevision(decodeFile(bytes));
      requireKnowledge(row.pageId === id && entry.name === `${row.id}.md`, 'integrity'); revisions.push(row);
    }
    return { revisions, heads: revisionHeads(revisions), byteLength: totalBytes };
  }
  async pageIds(): Promise<string[]> {
    const entries = await this.files.list('pages'); requireKnowledge(entries.length <= 4096, 'capacity');
    return entries.map(entry => { requireKnowledge(entry.kind === 'directory', 'unexpected_file'); pageId(entry.name); return entry.name; }).sort();
  }
  async append(row: KnowledgeRevision, options: { preserveConflict?: boolean } = {}): Promise<KnowledgePageHistory> {
    const text = serializeRevision(row); await parseRevision(text);
    const path = `pages/${row.pageId}/${row.id}.md`, existing = await this.files.read(path);
    if (existing) {
      requireKnowledge((await parseRevision(decodeFile(existing))).id === row.id, 'integrity'); return this.readPage(row.pageId);
    }
    const before = await this.readPage(row.pageId);
    // Reject before the immutable write so a full history remains readable.
    requireKnowledge(before.revisions.length < 2000 && before.byteLength + textBytes(text).length <= 64 * 1024 * 1024, 'capacity');
    if (!before.revisions.length) requireKnowledge((await this.pageIds()).length < 4096, 'capacity');
    const sameBase = before.heads.map(head => head.id).sort().join(',') === [...row.parents].sort().join(',');
    requireKnowledge(sameBase || options.preserveConflict, 'conflict');
    requireKnowledge(row.parents.every(id => before.revisions.some(revision => revision.id === id)), 'missing_parent');
    for (const id of row.sourceIds) await this.readSource(id);
    for (const id of row.attachmentIds) await this.readAttachment(id);
    await this.files.putImmutable(path, textBytes(text));
    return this.readPage(row.pageId);
  }
  async putSource(row: KnowledgeSource): Promise<void> {
    const bytes = jsonBytes(row); await parseSource(decodeFile(bytes));
    if (row.derivedFrom) {
      const original = await this.readSource(row.derivedFrom);
      verifyDerivedSource(row, original);
    }
    if (await this.files.read(`sources/${row.id}.json`)) { await this.readSource(row.id); return; }
    await this.files.putImmutable(`sources/${row.id}.json`, bytes);
  }
  async readProposal(id: string): Promise<KnowledgeProposal> {
    hashId(id); const bytes = await this.files.read(`proposals/${id}.json`);
    requireKnowledge(bytes && bytes.length <= 2 * 1024 * 1024, 'missing_proposal');
    const value: unknown = JSON.parse(decodeFile(bytes)); await validateProposal(value);
    const proposal = value as KnowledgeProposal; requireKnowledge(proposal.id === id, 'integrity'); return proposal;
  }
  async readSource(id: string): Promise<KnowledgeSource> {
    hashId(id); const bytes = await this.files.read(`sources/${id}.json`); requireKnowledge(bytes, 'missing_source');
    const row = await parseSource(decodeFile(bytes)); requireKnowledge(row.id === id, 'integrity');
    if (row.derivedFrom) {
      const originalBytes = await this.files.read(`sources/${row.derivedFrom}.json`); requireKnowledge(originalBytes, 'missing_source');
      const original = await parseSource(decodeFile(originalBytes)); requireKnowledge(original.id === row.derivedFrom, 'integrity');
      verifyDerivedSource(row, original);
    }
    return row;
  }
  async putAttachment(attachment: KnowledgeAttachment): Promise<void> {
    const checked = await imageAttachment(attachment.bytes);
    requireKnowledge(checked.id === attachment.id && checked.extension === attachment.extension, 'integrity');
    await this.files.putImmutable(`attachments/${checked.id}.${checked.extension}`, checked.bytes);
  }
  async readAttachment(id: string): Promise<KnowledgeAttachment> {
    hashId(id);
    for (const extension of ['png', 'jpg', 'webp'] as const) {
      const bytes = await this.files.read(`attachments/${id}.${extension}`);
      if (bytes) {
        const checked = await imageAttachment(bytes);
        requireKnowledge(checked.id === id && checked.extension === extension, 'integrity'); return checked;
      }
    }
    throw new Error('knowledge_missing_image');
  }
}
