import type { LearningAsset } from './learning.ts';
import { learningAssert, learningInteger } from './learning.ts';

export const WIKI_MAX_PAGES = 4096;
export const WIKI_MAX_TOPICS = 128;
export const WIKI_MAX_RELATIONS = 8192;
export const WIKI_MAX_BYTES = 2 * 1024 * 1024;
export interface WikiPage { bvid: string; createdAt: number; deleted: boolean }
export interface WikiTopic { id: string; name: string; term: string | null; manualName: boolean }
export interface WikiRelation { topicId: string; bvid: string; mode: 'include' | 'exclude' }
export interface WikiState { key: 'state'; revision: number; pages: WikiPage[]; topics: WikiTopic[]; relations: WikiRelation[] }
export interface WikiViewTopic extends WikiTopic { bvids: string[]; automatic: boolean }
export interface WikiViewPage extends WikiPage { title: string; count: number; updatedAt: number }
export interface WikiView { epoch: number; assetRevision: number; state: WikiState; pages: WikiViewPage[]; topics: WikiViewTopic[]; bytes: number }
export const emptyWiki = (): WikiState => ({ key: 'state', revision: 0, pages: [], topics: [], relations: [] });
export const wikiBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const bv = (value: unknown): value is string => typeof value === 'string' && /^BV[a-zA-Z0-9]{10}$/.test(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  learningAssert(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(','), 'wiki_format');
}
export function validateWiki(value: unknown): asserts value is WikiState {
  exact(value, ['key', 'revision', 'pages', 'topics', 'relations']);
  learningAssert(value.key === 'state', 'wiki_format'); learningInteger(value.revision);
  learningAssert(Array.isArray(value.pages) && value.pages.length <= WIKI_MAX_PAGES, 'wiki_capacity');
  learningAssert(Array.isArray(value.topics) && value.topics.length <= WIKI_MAX_TOPICS, 'wiki_capacity');
  learningAssert(Array.isArray(value.relations) && value.relations.length <= WIKI_MAX_RELATIONS, 'wiki_capacity');
  const pages = new Set<string>(), topics = new Set<string>(), relations = new Set<string>();
  for (const page of value.pages) {
    exact(page, ['bvid', 'createdAt', 'deleted']); learningAssert(bv(page.bvid) && !pages.has(page.bvid) && typeof page.deleted === 'boolean', 'wiki_format');
    learningInteger(page.createdAt); pages.add(page.bvid);
  }
  for (const topic of value.topics) {
    exact(topic, ['id', 'name', 'term', 'manualName']); learningAssert(id(topic.id) && !topics.has(topic.id) && typeof topic.manualName === 'boolean', 'wiki_format');
    learningAssert(typeof topic.name === 'string' && topic.name.trim().length > 0 && topic.name.length <= 80, 'wiki_format');
    learningAssert(topic.term === null || typeof topic.term === 'string' && topic.term.length > 0 && topic.term.length <= 80, 'wiki_format'); topics.add(topic.id);
  }
  for (const relation of value.relations) {
    exact(relation, ['topicId', 'bvid', 'mode']);
    learningAssert(typeof relation.topicId === 'string' && topics.has(relation.topicId) && bv(relation.bvid) && pages.has(relation.bvid)
      && (relation.mode === 'include' || relation.mode === 'exclude'), 'wiki_format');
    const key = `${relation.topicId}:${relation.bvid}`; learningAssert(!relations.has(key), 'wiki_format'); relations.add(key);
  }
  learningAssert(wikiBytes(value) <= WIKI_MAX_BYTES, 'wiki_capacity');
}
export function wikiPageSaved(state: WikiState, asset: LearningAsset): WikiState {
  const next = structuredClone(state), prior = next.pages.find(page => page.bvid === asset.video.bvid);
  if (prior && !prior.deleted) return state;
  if (prior) { prior.deleted = false; prior.createdAt = asset.createdAt; }
  else next.pages.push({ bvid: asset.video.bvid, createdAt: asset.createdAt, deleted: false });
  // Recreated pages start with current automatic grouping, not old manual memberships.
  next.relations = next.relations.filter(relation => relation.bvid !== asset.video.bvid);
  next.revision++; validateWiki(next); return next;
}
