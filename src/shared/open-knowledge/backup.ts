import { exact, parseRevision, requireKnowledge, validateLibrary, KNOWLEDGE_FORMAT } from './format.ts';
import { KnowledgeDirectory, decodeFile, safeKnowledgePath, type KnowledgeFiles } from './directory.ts';
import { imageAttachment, parseSource } from './sources.ts';
import { validateProposal } from './proposals.ts';

export const KNOWLEDGE_BACKUP_MAX_BYTES = 90 * 1024 * 1024;
export const KNOWLEDGE_BACKUP_RAW_MAX_BYTES = 64 * 1024 * 1024;
export type KnowledgeBackup = { format: 'bili-bill-knowledge-backup'; version: 1; libraryId: string | null;
  createdAt: number; files: { path: string; base64: string }[] };
export class SnapshotKnowledgeFiles implements KnowledgeFiles {
  readonly entries: Map<string, Uint8Array>;
  constructor(entries: Map<string, Uint8Array>) { this.entries = entries; }
  async read(path: string) { safeKnowledgePath(path); return this.entries.get(path)?.slice() ?? null; }
  async putImmutable(): Promise<void> { throw Error('knowledge_readonly'); }
  async list(path: string) {
    const prefix = path ? path + '/' : '', found = new Map<string, 'file' | 'directory'>();
    for (const key of this.entries.keys()) if (key.startsWith(prefix)) {
      const rest = key.slice(prefix.length).split('/'); found.set(rest[0], rest.length > 1 ? 'directory' : 'file');
    }
    return [...found].map(([name, kind]) => ({ name, kind }));
  }
}
function encode(bytes: Uint8Array): string {
  let raw = ''; for (let i = 0; i < bytes.length; i += 16384) raw += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(raw);
}
export async function validateKnowledgeFiles(entries: Map<string, Uint8Array>, libraryId: string | null) {
  if (libraryId !== null) validateLibrary({ format: KNOWLEDGE_FORMAT, version: 1, id: libraryId });
  requireKnowledge(entries.size <= 20000, 'capacity');
  const directory = new KnowledgeDirectory(new SnapshotKnowledgeFiles(entries));
  let bytes = 0, images = 0, sources = 0, versions = 0, proposals = 0;
  for (const [path, content] of entries) {
    safeKnowledgePath(path); requireKnowledge(path !== 'library.json' && content.length > 0, 'format');
    bytes += content.length; requireKnowledge(bytes <= KNOWLEDGE_BACKUP_RAW_MAX_BYTES, 'capacity');
    if (path.startsWith('pages/')) {
      const row = await parseRevision(decodeFile(content)); requireKnowledge(path === `pages/${row.pageId}/${row.id}.md`, 'integrity'); versions++;
      for (const id of row.sourceIds) await directory.readSource(id);
      for (const id of row.attachmentIds) await directory.readAttachment(id);
      if (row.proposalId) { const proposal = await directory.readProposal(row.proposalId);
        requireKnowledge(proposal.libraryId === libraryId && proposal.pageId === row.pageId, 'proposal'); }
    } else if (path.startsWith('sources/')) {
      const row = await parseSource(decodeFile(content)); requireKnowledge(path === `sources/${row.id}.json`, 'integrity');
      await directory.readSource(row.id); sources++;
    } else if (path.startsWith('attachments/')) {
      const image = await imageAttachment(content); requireKnowledge(path === `attachments/${image.id}.${image.extension}`, 'integrity'); images++;
    } else {
      const proposal = JSON.parse(decodeFile(content)); await validateProposal(proposal);
      requireKnowledge(proposal.libraryId === libraryId && path === `proposals/${proposal.id}.json`, 'proposal'); proposals++;
    }
  }
  const ids = await directory.pageIds(); let conflicts = 0;
  for (const id of ids) conflicts += Math.max(0, (await directory.readPage(id)).heads.length - 1);
  return { pages: ids.length, images, sources, versions, proposals, conflicts, bytes };
}
export async function serializeKnowledgeBackup(entries: Map<string, Uint8Array>, libraryId: string | null): Promise<string> {
  await validateKnowledgeFiles(entries, libraryId);
  const bundle: KnowledgeBackup = { format: 'bili-bill-knowledge-backup', version: 1, libraryId, createdAt: Date.now(),
    files: [...entries].sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => ({ path, base64: encode(bytes) })) };
  const text = JSON.stringify(bundle); requireKnowledge(text.length <= KNOWLEDGE_BACKUP_MAX_BYTES, 'capacity'); return text;
}
export async function parseKnowledgeBackup(text: string) {
  requireKnowledge(typeof text === 'string' && text.length <= KNOWLEDGE_BACKUP_MAX_BYTES, 'capacity');
  const value: unknown = JSON.parse(text); exact(value, ['format', 'version', 'libraryId', 'createdAt', 'files']);
  requireKnowledge(value.format === 'bili-bill-knowledge-backup' && value.version === 1
    && Number.isSafeInteger(value.createdAt) && (value.createdAt as number) >= 0, 'format');
  requireKnowledge(Array.isArray(value.files) && value.files.length <= 20000, 'capacity');
  const entries = new Map<string, Uint8Array>(); let size = 0;
  for (const item of value.files) {
    exact(item, ['path', 'base64']); requireKnowledge(typeof item.path === 'string' && !entries.has(item.path), 'format');
    safeKnowledgePath(item.path);
    requireKnowledge(typeof item.base64 === 'string' && item.base64.length % 4 === 0
      && /^[A-Za-z0-9+/]*={0,2}$/.test(item.base64), 'format');
    size += item.base64.length / 4 * 3; requireKnowledge(size <= KNOWLEDGE_BACKUP_RAW_MAX_BYTES + value.files.length * 2, 'capacity');
    const raw = atob(item.base64), bytes = Uint8Array.from(raw, char => char.charCodeAt(0));
    requireKnowledge(encode(bytes) === item.base64, 'format'); entries.set(item.path, bytes);
  }
  requireKnowledge(value.libraryId === null || typeof value.libraryId === 'string', 'format');
  const summary = await validateKnowledgeFiles(entries, value.libraryId);
  return { entries, libraryId: value.libraryId, summary };
}

// Dependency ordering matters when a recovered queue is replayed into an empty directory.
export async function orderKnowledgeFiles(entries: Map<string, Uint8Array>): Promise<string[]> {
  const ordered: string[] = [], seen = new Set<string>();
  const visit = async (path: string) => {
    if (seen.has(path)) return; seen.add(path);
    const bytes = entries.get(path); if (!bytes) return;
    if (path.startsWith('sources/')) {
      const row = await parseSource(decodeFile(bytes)); if (row.derivedFrom) await visit(`sources/${row.derivedFrom}.json`);
    } else if (path.startsWith('pages/')) {
      const row = await parseRevision(decodeFile(bytes));
      for (const id of row.sourceIds) await visit(`sources/${id}.json`);
      for (const id of row.attachmentIds) for (const extension of ['png', 'jpg', 'webp']) await visit(`attachments/${id}.${extension}`);
      if (row.proposalId) await visit(`proposals/${row.proposalId}.json`);
      for (const id of row.parents) await visit(`pages/${row.pageId}/${id}.md`);
    }
    ordered.push(path);
  };
  for (const path of entries.keys()) await visit(path); return ordered;
}
