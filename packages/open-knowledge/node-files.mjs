import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { safeKnowledgeDirectory, safeKnowledgePath } from '../../src/shared/open-knowledge/directory.ts';
import { requireKnowledge } from '../../src/shared/open-knowledge/format.ts';

const MAX_FILE = 33 * 1024 * 1024;
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
export class NodeKnowledgeFiles {
  static async open(root) {
    requireKnowledge(isAbsolute(root), 'scope');
    const info = await lstat(root); requireKnowledge(info.isDirectory() && !info.isSymbolicLink(), 'link');
    return new NodeKnowledgeFiles(await realpath(root), info);
  }
  constructor(root, identity) { this.root = root; this.identity = identity; }
  async checkRoot() {
    const current = await lstat(this.root);
    requireKnowledge(!current.isSymbolicLink() && sameFile(current, this.identity), 'scope');
  }
  async directory(parts, create = false) {
    await this.checkRoot(); let current = this.root;
    for (const part of parts) {
      current = join(current, part);
      if (create) try { await mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const info = await lstat(current);
      requireKnowledge(info.isDirectory() && !info.isSymbolicLink(), 'link');
      const rel = relative(this.root, await realpath(current));
      requireKnowledge(rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel), 'scope');
    }
    return current;
  }
  async verifyOpened(path, handle) {
    await this.checkRoot();
    const actual = await handle.stat(), entry = await lstat(path);
    requireKnowledge(actual.isFile() && actual.nlink === 1 && !entry.isSymbolicLink() && sameFile(actual, entry), 'link');
    const rel = relative(this.root, await realpath(path));
    requireKnowledge(rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel), 'scope');
    requireKnowledge(actual.size <= MAX_FILE, 'capacity'); return actual;
  }
  async read(path) {
    const parts = safeKnowledgePath(path), name = parts.pop();
    let handle;
    try {
      const full = join(await this.directory(parts), name);
      const entry = await lstat(full); requireKnowledge(!entry.isSymbolicLink(), 'link');
      handle = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      await this.verifyOpened(full, handle);
      const bytes = await handle.readFile(); requireKnowledge(bytes.length <= MAX_FILE, 'capacity');
      await this.verifyOpened(full, handle); return new Uint8Array(bytes);
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    finally { await handle?.close(); }
  }
  async putImmutable(path, bytes) {
    requireKnowledge(bytes.length > 0 && bytes.length <= MAX_FILE, 'capacity');
    const parts = safeKnowledgePath(path), name = parts.pop();
    const directory = await this.directory(parts, true), full = join(directory, name);
    const existing = await this.read(path);
    if (existing) { requireKnowledge(Buffer.from(existing).equals(Buffer.from(bytes)), 'integrity'); return; }
    let handle, identity;
    try {
      try { handle = await open(full, 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const concurrent = await this.read(path);
        requireKnowledge(concurrent && Buffer.from(concurrent).equals(Buffer.from(bytes)), 'integrity'); return;
      }
      identity = await this.verifyOpened(full, handle);
      await handle.writeFile(bytes); await handle.sync(); await this.verifyOpened(full, handle);
    } catch (error) {
      await handle?.close(); handle = undefined;
      // Only remove the failed file created by this operation, never another writer's file.
      if (identity) {
        await this.checkRoot(); const now = await lstat(full);
        if (!now.isSymbolicLink() && sameFile(now, identity)) await unlink(full);
      }
      throw error;
    } finally { await handle?.close(); }
  }
  async list(path) {
    const parts = safeKnowledgeDirectory(path);
    try {
      const full = await this.directory(parts), entries = await readdir(full, { withFileTypes: true });
      requireKnowledge(entries.length <= 50000, 'capacity');
      return entries.map(entry => {
        requireKnowledge(!entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()), 'link');
        return { name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file' };
      });
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
}
