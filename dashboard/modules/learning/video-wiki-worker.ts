import { db } from '../../../src/background/storage/db.ts';
import { VideoWikiRepository, wikiMarkdown } from '../../../src/background/storage/video-wiki-repo.ts';
import { learningAssert } from '../../../src/shared/learning.ts';

const repo = new VideoWikiRepository(db);
let busy = false;
self.onmessage = async ({ data }) => {
  const { id, action, params = {} } = data;
  if (busy) { self.postMessage({ id, error: '另一项操作正在进行，请稍后重试。' }); return; }
  busy = true;
  try {
    let result: unknown;
    if (action === 'view') result = await repo.view();
    else if (action === 'page' || action === 'markdown') {
      const state = await repo.state();
      learningAssert(state.wiki.pages.some(page => page.bvid === params.bvid && !page.deleted), 'stale_wiki');
      const assets = state.assets.filter(asset => asset.video.bvid === params.bvid);
      result = action === 'page' ? assets : { file: new Blob([wikiMarkdown(params.bvid, assets)], { type: 'text/markdown;charset=utf-8' }) };
    } else if (action === 'removePage') {
      learningAssert(typeof params.removeAssets === 'boolean', 'wiki_format');
      await repo.removePage(params.version, params.bvid, params.removeAssets); result = await repo.view();
    } else if (action === 'topic') {
      const topicId = await repo.changeTopic(params.version, params.change); result = { view: await repo.view(), topicId };
    } else throw Error('wiki_format');
    self.postMessage({ id, result });
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    self.postMessage({ id, error: code.includes('capacity') ? '视频 Wiki 的组织空间已满，未提交本次修改。'
      : code.includes('stale') ? '内容已在其他窗口变化，请刷新后重试。'
        : '本次操作未完成，请刷新后确认。' });
  } finally { busy = false; }
};
