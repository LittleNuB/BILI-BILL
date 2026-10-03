import { requireKnowledge } from './format.ts';
import { safeKnowledgeDirectory, safeKnowledgePath, type KnowledgeFiles } from './directory.ts';

export interface KnowledgeDirectoryHandle extends FileSystemDirectoryHandle {
  queryPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
}
const notFound = (error: unknown) => error instanceof Error && error.name === 'NotFoundError';
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, i) => value === b[i]);
export class BrowserKnowledgeFiles implements KnowledgeFiles {
  readonly root: KnowledgeDirectoryHandle;
  constructor(root: KnowledgeDirectoryHandle) { this.root = root; }
  async permission(request = false): Promise<boolean> {
    if (await this.root.queryPermission({ mode: 'readwrite' }) === 'granted') return true;
    return request && await this.root.requestPermission({ mode: 'readwrite' }) === 'granted';
  }
  private async parent(parts: string[], create = false): Promise<FileSystemDirectoryHandle> {
    let handle: FileSystemDirectoryHandle = this.root;
    for (const part of parts) handle = await handle.getDirectoryHandle(part, { create });
    return handle;
  }
  async read(path: string): Promise<Uint8Array | null> {
    const parts = safeKnowledgePath(path), name = parts.pop()!;
    try {
      const file = await (await (await this.parent(parts)).getFileHandle(name)).getFile();
      requireKnowledge(file.size <= 33 * 1024 * 1024, 'capacity');
      return new Uint8Array(await file.arrayBuffer());
    } catch (error) { if (notFound(error)) return null; throw error; }
  }
  async putImmutable(path: string, bytes: Uint8Array): Promise<void> {
    const parts = safeKnowledgePath(path), name = parts.pop()!;
    requireKnowledge(bytes.length > 0 && bytes.length <= 33 * 1024 * 1024, 'capacity');
    const write = async () => {
      const existing = await this.read(path);
      if (existing?.length) { requireKnowledge(same(existing, bytes), 'integrity'); return; }
      const file = await (await this.parent(parts, true)).getFileHandle(name, { create: true });
      const writer = await file.createWritable({ keepExistingData: false });
      try { await writer.write(new Uint8Array(bytes).buffer); await writer.close(); }
      catch (error) { try { await writer.abort(); } catch { /* The writer may already have closed. */ } throw error; }
      requireKnowledge(same((await this.read(path)) ?? new Uint8Array(), bytes), 'integrity');
    };
    // This serializes extension windows; cross-process races are preserved by the revision graph.
    if (globalThis.navigator?.locks) await navigator.locks.request(`bili-bill-file:${path}`, write);
    else await write();
  }
  async list(path: string): Promise<{ name: string; kind: 'file' | 'directory' }[]> {
    const parts = safeKnowledgeDirectory(path);
    try {
      const directory = await this.parent(parts) as KnowledgeDirectoryHandle, entries: { name: string; kind: 'file' | 'directory' }[] = [];
      for await (const entry of directory.values()) {
        requireKnowledge(entries.length < 50000, 'capacity'); entries.push({ name: entry.name, kind: entry.kind });
      }
      return entries;
    } catch (error) { if (notFound(error)) return []; throw error; }
  }
}
export async function pickKnowledgeDirectory(): Promise<KnowledgeDirectoryHandle> {
  const picker = (globalThis as unknown as { showDirectoryPicker?: (options: { mode: 'readwrite'; id: string }) => Promise<KnowledgeDirectoryHandle> }).showDirectoryPicker;
  requireKnowledge(picker, 'browser_unsupported');
  const selected = await picker({ mode: 'readwrite', id: 'bili-bill-knowledge' });
  // The picker grants access to the parent; writes are confined to its named managed area.
  return await selected.getDirectoryHandle('Bili-Bill', { create: true }) as KnowledgeDirectoryHandle;
}
