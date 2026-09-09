import type { LocalDataCategoryRegistration } from '../../shared/local-data-category-contract.ts';
import { db } from './db.ts';

export function getExplicitMemoryDataCategoryRegistration(): LocalDataCategoryRegistration {
  const usage = async () => {
    const items = (await db.explicitMemory.get('state'))?.items ?? [];
    return { count: items.length, usageBytes: items.length ? new TextEncoder().encode(JSON.stringify(items)).byteLength : 0 };
  };
  return { id: 'explicitMemory', label: '显式记忆', includeInClearAll: true, collectUsage: usage,
    clear: async () => {
      const { ExplicitMemoryRepository } = await import('./explicit-memory-repo.ts');
      const before = await usage(); await new ExplicitMemoryRepository(db).clear(); return { cleared: { explicitMemory: before.count } };
    },
    readAfterClear: async () => { const after = await usage(); return { ...after, empty: after.count === 0 }; },
  };
}
