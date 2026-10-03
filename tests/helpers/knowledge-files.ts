import type { KnowledgeFiles } from '../../src/shared/open-knowledge/directory.ts';
export class MemoryKnowledgeFiles implements KnowledgeFiles {
  data = new Map<string, Uint8Array>();
  failWrites = false;
  async read(path: string) { return this.data.get(path)?.slice() ?? null; }
  async putImmutable(path: string, value: Uint8Array) {
    if (this.failWrites) throw new Error('permission_denied');
    const prior = this.data.get(path);
    if (prior && !Buffer.from(prior).equals(Buffer.from(value))) throw new Error('knowledge_integrity');
    this.data.set(path, value.slice());
  }
  async list(path: string) {
    const prefix = path ? path + '/' : '', entries = new Map<string, 'file' | 'directory'>();
    for (const key of this.data.keys()) if (key.startsWith(prefix)) {
      const parts = key.slice(prefix.length).split('/'); entries.set(parts[0], parts.length > 1 ? 'directory' : 'file');
    }
    return [...entries].map(([name, kind]) => ({ name, kind }));
  }
}
