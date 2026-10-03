import type { LocalDataCategoryRegistration } from '../../shared/local-data-category-contract.ts';
import { db } from './db.ts';
import { KnowledgeRepository } from './open-knowledge-repo.ts';

export function getOpenKnowledgeDataCategoryRegistration(): LocalDataCategoryRegistration {
  const repository = new KnowledgeRepository(db);
  const usage = async () => {
    let count = 0, usageBytes = 0;
    await db.okFiles.each(file => { count++; usageBytes += file.bytes.length; });
    await db.okDrafts.each(draft => { count++; usageBytes += new TextEncoder().encode(draft.body).length; });
    await db.okCaptures.each(draft => { count++; usageBytes += new TextEncoder().encode(JSON.stringify({ ...draft, images: [] })).length
      + draft.images.reduce((sum, image) => sum + image.bytes.length, 0); });
    const state = await repository.state();
    if (state.handle || state.libraryId || state.migration) { count++; usageBytes += 256; }
    return { count, usageBytes };
  };
  return { id: 'openKnowledge', label: '开放知识库的浏览器副本与草稿', includeInClearAll: true, collectUsage: usage,
    clear: async () => {
      const files = await db.okFiles.count(), drafts = await db.okDrafts.count() + await db.okCaptures.count();
      await repository.clear(); return { cleared: { openKnowledgeFiles: files, openKnowledgeDrafts: drafts } };
    },
    readAfterClear: async () => { const after = await usage(); return { ...after, empty: after.count === 0 }; },
  };
}
