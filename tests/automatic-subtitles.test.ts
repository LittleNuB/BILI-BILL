import test from 'node:test';
import assert from 'node:assert/strict';
import { AutomaticSubtitlePoll, preferredTextIdentity, readableSubtitle, subtitleLanguagePriority } from '../src/shared/automatic-subtitles.ts';
import { readableModelOutput } from '../src/shared/readable-model-output.ts';

const key = (language = 'zh', hash = 'aaa', cid = 1, source = 'bilibili_subtitle') => `primary-text:${source}:BVauto:${cid}:1:${language}:${hash}`;
test('automatic track choice, manual continuity, missing manual source and part isolation', () => {
  assert.equal(preferredTextIdentity([key('en'), key('ai-zh'), key()]), key());
  assert.equal(preferredTextIdentity([key('en'), key('ai-zh')]), key('ai-zh'));
  assert.equal(preferredTextIdentity([key(), key('en')], key('en')), key('en'));
  assert.equal(preferredTextIdentity([key('en', 'bbb')], key('en')), key('en', 'bbb'));
  assert.equal(preferredTextIdentity([key('en', 'bbb', 2)], key('en')), null);
  assert.equal(preferredTextIdentity([key()], key('zh', 'aaa', 1, 'local_transcript')), null);
  assert.equal(preferredTextIdentity([key('zh', 'bbb'), key('zh', 'ccc')], key()), null);
  assert.ok(subtitleLanguagePriority('ai-zh') < subtitleLanguagePriority('en'));
  assert.equal(readableSubtitle(' 字 幕  阅读 \n example  API '), '字幕阅读 example API');
});
test('late subtitle signals retry after backoff, ready pauses polling, navigation fences old completion', async () => {
  const poll = new AutomaticSubtitlePoll(); let count = 0;
  const load = async () => { count++; };
  poll.sync('p1', 0);
  await poll.tick(0, { visible: false, ready: false, load }); assert.equal(count, 0);
  await poll.tick(0, { visible: true, ready: false, load }); assert.equal(count, 1);
  await poll.tick(10, { visible: true, ready: false, load }); assert.equal(count, 1);
  await poll.tick(3000, { visible: true, ready: true, load }); assert.equal(count, 1);
  poll.notify(3000); await poll.tick(4000, { visible: true, ready: true, load }); assert.equal(count, 2);
  let release!: () => void;
  poll.notify(5000);
  const pending = poll.tick(6000, { visible: true, ready: false, load: () => new Promise<void>(resolve => { release = resolve; }) });
  poll.sync('p2', 7000); release(); await pending;
  await poll.tick(7000, { visible: true, ready: false, load }); assert.equal(count, 3);
});
test('unverified structured overview keeps distinct prose sections without duplicate blocks or jump claims', () => {
  const result = readableModelOutput({ summary: '共同正文', keyPoints: ['共同正文'], highlights: [{ title: '真实亮点', description: '另一段说明', start: 123 }] }, 'summary');
  assert.equal(result.match(/共同正文/g)?.length, 1);
  assert.match(result, /摘要\n共同正文/); assert.match(result, /时间未核实/); assert.ok(!result.includes('123'));
  assert.equal(readableModelOutput('普通模型回答', 'summary'), '普通模型回答');
});
