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
test('a player subtitle signal during an empty in-flight read is not overwritten by backoff', async () => {
  const poll = new AutomaticSubtitlePoll();
  let rows = 0, available = false, calls = 0;
  let release!: () => void;
  const load = async () => { calls++; if (available) rows = 1045; };
  poll.sync('third-video', 0);
  for (const now of [0, 2500, 10500]) await poll.tick(now, { visible: true, ready: false, load });
  const pending = poll.tick(30500, { visible: true, ready: false, load: () => {
    calls++; return new Promise<void>(resolve => { release = resolve; });
  } });
  available = true; poll.notify(32000);
  await poll.tick(32500, { visible: true, ready: false, load });
  assert.equal(calls, 4, 'a new signal must not start a parallel read');
  release(); await pending;
  await poll.tick(33000, { visible: true, ready: false, load });
  assert.equal(rows, 1045, 'subtitle availability must not wait for the old 45-second backoff');
  assert.equal(calls, 5);
});
test('a signal during a failed read survives until the page is visible, even at the retry limit', async () => {
  const poll = new AutomaticSubtitlePoll(); let calls = 0;
  let reject!: (error: Error) => void;
  const load = async () => { calls++; };
  poll.sync('video', 0);
  for (const now of [0, 2500, 10500, 30500, 75500]) await poll.tick(now, { visible: true, ready: false, load });
  const pending = poll.tick(135500, { visible: true, ready: false, load: () => {
    calls++; return new Promise<void>((_resolve, rejectRead) => { reject = rejectRead; });
  } });
  poll.notify(136000); reject(new Error('temporary read failure'));
  await assert.rejects(pending, /temporary read failure/);
  await poll.tick(136500, { visible: false, ready: false, load });
  assert.equal(calls, 6);
  await poll.tick(137000, { visible: true, ready: true, load });
  assert.equal(calls, 7, 'the pending signal survives the failure and overrides ready/attempt limits once');
  await poll.tick(138000, { visible: true, ready: true, load });
  assert.equal(calls, 7, 'settled sources must not be polled without a new signal');
});
test('unverified structured overview keeps distinct prose sections without duplicate blocks or jump claims', () => {
  const result = readableModelOutput({ summary: '共同正文', keyPoints: ['共同正文'], highlights: [{ title: '真实亮点', description: '另一段说明', start: 123 }] }, 'summary');
  assert.equal(result.match(/共同正文/g)?.length, 1);
  assert.match(result, /摘要\n共同正文/); assert.match(result, /时间未核实/); assert.ok(!result.includes('123'));
  assert.equal(readableModelOutput('普通模型回答', 'summary'), '普通模型回答');
});
