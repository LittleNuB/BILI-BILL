import type { BiliAnalyticsDB } from './db.ts';
import { learningAssert, learningInteger, learningTime, newLearningId, type LearningAsset } from '../../shared/learning.ts';
import { mergeLearningAssets, sameLearningContent, learningNotCancelled } from '../../shared/learning-backup.ts';
import { emptyWiki, validateWiki, wikiBytes, type WikiState, type WikiView, type WikiTopic } from '../../shared/video-wiki.ts';
import { deriveWikiTopics } from '../../shared/video-wiki-topics.ts';

export interface WikiVersion { epoch: number; assetRevision: number; wikiRevision: number }
export const wikiVersion = (view: WikiView): WikiVersion => ({ epoch: view.epoch, assetRevision: view.assetRevision, wikiRevision: view.state.revision });
export class VideoWikiRepository {
  private database: BiliAnalyticsDB;
  private cached: { key: string; topics: WikiView['topics'] } | null = null;
  constructor(database: BiliAnalyticsDB) { this.database = database; }
  async state() {
    const db = this.database;
    return db.transaction('r', db.lgAssets, db.lgMeta, db.lgWiki, async () => ({
      assets: await db.lgAssets.toArray(),
      meta: await db.lgMeta.get('state') ?? { key: 'state' as const, epoch: 0, revision: 0 },
      wiki: await db.lgWiki.get('state') ?? emptyWiki(),
    }));
  }
  async view(): Promise<WikiView> {
    const { assets, meta, wiki } = await this.state();
    const key = `${meta.epoch}:${meta.revision}:${wiki.revision}`;
    if (this.cached?.key !== key) this.cached = { key, topics: deriveWikiTopics(assets, wiki) };
    const grouped = new Map<string, LearningAsset[]>();
    for (const asset of assets) grouped.set(asset.video.bvid, [...grouped.get(asset.video.bvid) ?? [], asset]);
    return { epoch: meta.epoch, assetRevision: meta.revision, state: wiki, bytes: wikiBytes(wiki), topics: this.cached.topics,
      pages: wiki.pages.filter(page => !page.deleted).map(page => {
        const rows = grouped.get(page.bvid) ?? [];
        return { ...page, title: rows[0]?.video.title || page.bvid, count: rows.length, updatedAt: Math.max(page.createdAt, ...rows.map(row => row.updatedAt)) };
      }).sort((a, b) => b.updatedAt - a.updatedAt || a.bvid.localeCompare(b.bvid)) };
  }
  private assertVersion(version: WikiVersion, meta: { epoch: number; revision: number }, wiki: WikiState) {
    learningInteger(version?.epoch); learningInteger(version?.assetRevision); learningInteger(version?.wikiRevision);
    learningAssert(version.epoch === meta.epoch && version.assetRevision === meta.revision && version.wikiRevision === wiki.revision, 'stale_wiki');
  }
  async removePage(version: WikiVersion, bvid: string, removeAssets = false) {
    const db = this.database;
    await db.transaction('rw', db.lgAssets, db.lgMeta, db.lgWiki, async () => {
      const { assets, meta, wiki } = await this.state(); this.assertVersion(version, meta, wiki);
      const page = wiki.pages.find(page => page.bvid === bvid && !page.deleted); learningAssert(page, 'stale_wiki');
      page.deleted = true; wiki.relations = wiki.relations.filter(relation => relation.bvid !== bvid); wiki.revision++; validateWiki(wiki);
      if (removeAssets) await db.lgAssets.bulkDelete(assets.filter(asset => asset.video.bvid === bvid).map(asset => asset.id));
      learningInteger(meta.epoch + 1); learningInteger(meta.revision + 1);
      await db.lgMeta.put({ ...meta, epoch: meta.epoch + 1, revision: meta.revision + 1 });
      await db.lgWiki.put(wiki);
    });
  }
  async changeTopic(version: WikiVersion, change: { action: 'create'; name: string } | { action: 'rename'; id: string; name: string }
    | { action: 'relation'; id: string; bvid: string; mode: 'include' | 'exclude' | 'automatic' }) {
    const db = this.database;
    const before = await this.state(); this.assertVersion(version, before.meta, before.wiki);
    const next = structuredClone(before.wiki);
    let topic: WikiTopic | undefined;
    if (change.action === 'create') { topic = { id: newLearningId(), name: change.name.trim(), term: null }; next.topics.push(topic); }
    else {
      topic = next.topics.find(topic => topic.id === change.id);
      if (!topic) {
        const derived = deriveWikiTopics(before.assets, before.wiki).find(topic => topic.id === change.id); learningAssert(derived, 'stale_wiki');
        topic = { id: derived.id, name: derived.name, term: derived.term }; next.topics.push(topic);
      }
      if (change.action === 'rename') topic.name = change.name.trim();
      else {
        learningAssert(next.pages.some(page => page.bvid === change.bvid && !page.deleted), 'stale_wiki');
        next.relations = next.relations.filter(relation => relation.topicId !== change.id || relation.bvid !== change.bvid);
        if (change.mode !== 'automatic') next.relations.push({ topicId: change.id, bvid: change.bvid, mode: change.mode });
      }
    }
    next.revision++; validateWiki(next);
    await db.transaction('rw', db.lgAssets, db.lgMeta, db.lgWiki, async () => {
      const current = await this.state(); this.assertVersion(version, current.meta, current.wiki); await db.lgWiki.put(next);
    });
    return topic.id;
  }
  async restore(version: WikiVersion, incoming: LearningAsset[], organization: WikiState, signal?: AbortSignal, onCommit?: () => void) {
    const db = this.database, before = await this.state(); this.assertVersion(version, before.meta, before.wiki);
    const wiki = structuredClone(organization); validateWiki(wiki);
    const rows = await mergeLearningAssets(before.assets, incoming, signal);
    wiki.revision = before.wiki.revision + 1; validateWiki(wiki); learningNotCancelled(signal);
    const prior = new Map(before.assets.map(asset => [asset.id, asset]));
    const put = rows.filter(asset => !sameLearningContent(prior.get(asset.id), asset));
    await db.transaction('rw', db.lgAssets, db.lgMeta, db.lgWiki, async () => {
      const current = await this.state(); this.assertVersion(version, current.meta, current.wiki); learningNotCancelled(signal);
      learningInteger(current.meta.epoch + 1); learningInteger(current.meta.revision + 1); onCommit?.();
      await db.lgAssets.bulkPut(put); await db.lgWiki.put(wiki);
      await db.lgMeta.put({ ...current.meta, epoch: current.meta.epoch + 1, revision: current.meta.revision + 1 });
    });
    return { added: put.length, total: rows.length };
  }
}

export function wikiMarkdown(bvid: string, assets: LearningAsset[]): string {
  const rows = assets.filter(asset => asset.video.bvid === bvid).sort((a, b) => (a.part?.page ?? 0) - (b.part?.page ?? 0) || a.createdAt - b.createdAt);
  learningAssert(rows.length > 0, 'wiki_empty');
  const escape = (text: string) => text.replace(/[\\`*_[\]<>#]/g, '\\$&');
  return `# ${escape(rows[0].video.title)}\n\n` + rows.map(asset => {
    const time = asset.bookmarkMs ?? asset.snapshot?.citations[0]?.fromMs;
    const url = `https://www.bilibili.com/video/${asset.video.bvid}/${asset.part ? `?p=${asset.part.page}` : ''}`;
    return `## ${escape(asset.personal.title || '学习记录')}\n\n来源：${url}${asset.part ? ` · P${asset.part.page}` : ''}${time !== undefined && time !== null ? ` · ${learningTime(time)}` : ''}\n\n`
      + (asset.personal.note ? `### 我的笔记\n\n${escape(asset.personal.note)}\n\n` : '')
      + (asset.snapshot ? `### ${asset.snapshot.origin === 'subtitle' ? '视频原文摘录' : '已保存模型内容'}\n\n${escape(asset.snapshot.body)}\n\n`
        + asset.snapshot.citations.map(citation => `> ${learningTime(citation.fromMs)} ${escape(citation.text).replaceAll('\n', '\n> ')}\n`).join('\n') : '');
  }).join('\n');
}
