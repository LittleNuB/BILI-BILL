import { db } from '../../../src/background/storage/db.ts';
import { KnowledgeRepository } from '../../../src/background/storage/open-knowledge-repo.ts';
import { BrowserKnowledgeFiles, pickKnowledgeDirectory, type KnowledgeDirectoryHandle } from '../../../src/shared/open-knowledge/browser-files.ts';
import { KnowledgeDirectory } from '../../../src/shared/open-knowledge/directory.ts';

export const knowledgeRepository = new KnowledgeRepository(db);
let synchronization: Promise<boolean> | null = null;
export async function syncKnowledge(requestPermission = false): Promise<boolean> {
  if (synchronization) return synchronization;
  synchronization = (async () => {
    const handle = (await knowledgeRepository.state()).handle;
    if (!handle) return false;
    const files = new BrowserKnowledgeFiles(handle);
    if (!await files.permission(requestPermission)) return false;
    await knowledgeRepository.sync(new KnowledgeDirectory(files));
    return true;
  })();
  try { return await synchronization; } finally { synchronization = null; }
}
export async function connectKnowledge(handlePromise: Promise<KnowledgeDirectoryHandle> = pickKnowledgeDirectory()) {
  const handle = await handlePromise;
  const directory = new KnowledgeDirectory(new BrowserKnowledgeFiles(handle));
  await knowledgeRepository.connect(directory, handle);
  await syncKnowledge();
}
