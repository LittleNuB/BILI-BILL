import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CurrentVideoFullTextRequestGuard,
  buildCurrentVideoFullTextRequestEnvelope,
  buildCanonicalTextSourceRecord,
  buildCurrentVideoPrimaryTextState,
  buildCurrentVideoTextSourceIdentity,
  buildPrimaryTextSourceOption,
  serializeCurrentVideoCanonicalRecord,
} from '../src/shared/current-video-primary-text.ts';
import { stableDigestHex } from '../src/shared/stable-digest.ts';

test('stable digest uses a full SHA-256 identity boundary', () => {
  assert.equal(
    stableDigestHex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.equal(
    stableDigestHex(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  assert.equal(
    stableDigestHex('中文🙂'),
    '3f7e2b3029a16c844f54b308c8035842509a1a8d8a4f35a7548d2384f3b51901',
  );
  assert.equal(
    stableDigestHex('a\u0000b'),
    '59b271ae1bbcb1d31d41929817f4b16fb439eb4f31520b5ad1d5ce98920a7138',
  );
});

test('primary text state distinguishes no body, single source, multiple sources, and missing selection', () => {
  const subtitle = sourceOption('bilibili_subtitle', 'BV1Primary', 101, 1, 'zh-CN', 'subtitle body');
  const localTranscript = sourceOption('local_transcript', 'BV1Primary', 101, 1, 'zh-CN', 'local transcript body');

  const noBody = buildCurrentVideoPrimaryTextState({
    bvid: 'BV1Primary',
    cid: 101,
    page: 1,
    sources: [],
  });
  assert.equal(noBody.status, 'no_body');
  assert.equal(noBody.primarySource, null);
  assert.match(noBody.action, /自动接收/);

  const single = buildCurrentVideoPrimaryTextState({
    bvid: 'BV1Primary',
    cid: 101,
    page: 1,
    sources: [subtitle],
  });
  assert.equal(single.status, 'single_source_ready');
  assert.equal(single.primarySource?.identity.sourceIdentityKey, subtitle.identity.sourceIdentityKey);
  assert.equal(single.showSourceSwitcher, false);

  const multiple = buildCurrentVideoPrimaryTextState({
    bvid: 'BV1Primary',
    cid: 101,
    page: 1,
    sources: [subtitle, localTranscript],
  });
  assert.equal(multiple.status, 'automatic_source_ready');
  assert.equal(multiple.primarySource?.identity.sourceIdentityKey, subtitle.identity.sourceIdentityKey);
  assert.equal(multiple.showSourceSwitcher, true);

  const selected = buildCurrentVideoPrimaryTextState({
    bvid: 'BV1Primary',
    cid: 101,
    page: 1,
    sources: [subtitle, localTranscript],
    selectedSourceIdentityKey: localTranscript.identity.sourceIdentityKey,
  });
  assert.equal(selected.status, 'selected_source_ready');
  assert.equal(selected.primarySource?.label, '本地转录');

  const clearedSelected = buildCurrentVideoPrimaryTextState({
    bvid: 'BV1Primary',
    cid: 101,
    page: 1,
    sources: [subtitle],
    selectedSourceIdentityKey: localTranscript.identity.sourceIdentityKey,
  });
  assert.equal(clearedSelected.status, 'selected_source_missing');
  assert.equal(clearedSelected.primarySource, null);
  assert.match(clearedSelected.action, /等待所选来源恢复/);
});

test('source identity changes when text or timeline changes', () => {
  const base = buildCurrentVideoTextSourceIdentity({
    bvid: 'BV1Identity',
    cid: 202,
    page: 1,
    source: 'bilibili_subtitle',
    sourceType: 'bilibili_player_wbi_v2',
    language: 'zh-CN',
    lines: [{ startSeconds: 0, endSeconds: 2, text: 'same words' }],
  });
  const textChanged = buildCurrentVideoTextSourceIdentity({
    bvid: 'BV1Identity',
    cid: 202,
    page: 1,
    source: 'bilibili_subtitle',
    sourceType: 'bilibili_player_wbi_v2',
    language: 'zh-CN',
    lines: [{ startSeconds: 0, endSeconds: 2, text: 'changed words' }],
  });
  const timelineChanged = buildCurrentVideoTextSourceIdentity({
    bvid: 'BV1Identity',
    cid: 202,
    page: 1,
    source: 'bilibili_subtitle',
    sourceType: 'bilibili_player_wbi_v2',
    language: 'zh-CN',
    lines: [{ startSeconds: 0.5, endSeconds: 2.5, text: 'same words' }],
  });

  assert.notEqual(base.bodyHash, textChanged.bodyHash);
  assert.equal(base.timelineHash, textChanged.timelineHash);
  assert.equal(base.bodyHash, timelineChanged.bodyHash);
  assert.notEqual(base.timelineHash, timelineChanged.timelineHash);
  assert.notEqual(base.sourceIdentityKey, timelineChanged.sourceIdentityKey);
  assert.match(base.bodyHash, /^[a-f0-9]{64}$/);
  assert.match(base.timelineHash, /^[a-f0-9]{64}$/);
  assert.match(base.sourceHash, /^[a-f0-9]{64}$/);
  assert.match(base.sourceIdentityKey, /:[a-f0-9]{64}$/);
});

test('source identity hash is built from a versioned canonical record', () => {
  const identity = buildCurrentVideoTextSourceIdentity({
    bvid: 'BV1Canonical',
    cid: 515,
    page: 2,
    source: 'bilibili_subtitle',
    sourceType: 'bilibili_player_wbi_v2',
    language: 'zh-CN',
    lines: [
      { startSeconds: 0, endSeconds: 1, text: '同一段 | 含分隔符' },
      { startSeconds: 1, endSeconds: 2, text: '第二段🙂' },
    ],
  });
  const canonical = buildCanonicalTextSourceRecord({
    bvid: 'BV1Canonical',
    cid: 515,
    page: 2,
    source: 'bilibili_subtitle',
    sourceType: 'bilibili_player_wbi_v2',
    language: 'zh-CN',
    bodyHash: identity.bodyHash,
    timelineHash: identity.timelineHash,
    lineCount: 2,
  });

  assert.deepEqual(canonical, {
    version: 1,
    kind: 'current-video-primary-text-source',
    bvid: 'BV1Canonical',
    cid: 515,
    page: 2,
    source: 'bilibili_subtitle',
    sourceType: 'bilibili_player_wbi_v2',
    language: 'zh-CN',
    bodyHash: identity.bodyHash,
    timelineHash: identity.timelineHash,
    lineCount: 2,
  });
  assert.equal(identity.sourceHash, stableDigestHex(serializeCurrentVideoCanonicalRecord(canonical)));
  assert.match(serializeCurrentVideoCanonicalRecord(canonical), /"version":1/);
});

test('full text request envelope freezes the submitted snapshot and binds identity', () => {
  const envelope = buildCurrentVideoFullTextRequestEnvelope({
    requestId: 'req-1',
    operation: 'qa',
    submittedAt: 1234,
    model: 'model-a',
    video: {
      bvid: 'BV1Envelope',
      cid: 303,
      page: 2,
      title: 'Envelope video',
      partTitle: 'Part 2',
      durationSeconds: 120,
    },
    source: 'bilibili_subtitle',
    sourceType: 'bilibili_player_wbi_v2',
    language: 'zh-CN',
    lines: [
      { startSeconds: 4, endSeconds: 8, text: 'first line' },
      { startSeconds: 8, endSeconds: 12, text: 'second line' },
    ],
    sessionId: 'session-1',
    turnId: 'turn-1',
  });

  assert.equal(envelope.requestId, 'req-1');
  assert.equal(envelope.video.bvid, 'BV1Envelope');
  assert.equal(envelope.video.cid, 303);
  assert.equal(envelope.source, 'bilibili_subtitle');
  assert.equal(envelope.primaryTextIdentity.bvid, 'BV1Envelope');
  assert.equal(envelope.primaryTextIdentity.cid, 303);
  assert.equal(envelope.primaryTextIdentity.page, 2);
  assert.equal(envelope.text.lineCount, 2);
  assert.ok(envelope.text.utf8Bytes > 0);
  assert.equal(Object.isFrozen(envelope), true);
  assert.equal(Object.isFrozen(envelope.text.lines), true);
  assert.equal(Object.isFrozen(envelope.text.lines[0]), true);
});

test('full text request guard isolates cancel, retry, clear, and late results', () => {
  const first = envelope('req-first', 'turn-1', 'line one');
  const retry = envelope('req-retry', 'turn-1', 'line one');
  const otherTurn = envelope('req-other-turn', 'turn-2', 'line one');
  const changedText = envelope('req-changed', 'turn-1', 'changed line');
  const guard = new CurrentVideoFullTextRequestGuard();

  guard.start(first);
  assert.deepEqual(guard.canCommit(first, first.primaryTextIdentity), {
    ok: true,
    current: true,
    reason: 'active_request',
  });

  guard.retry(first, retry);
  assert.deepEqual(guard.canCommit(first, first.primaryTextIdentity), {
    ok: false,
    current: false,
    reason: 'invalidated',
  });
  assert.equal(guard.canCommit(retry, changedText.primaryTextIdentity).reason, 'snapshot_target_only');

  guard.start(otherTurn);
  assert.equal(guard.canCommit(otherTurn, otherTurn.primaryTextIdentity).ok, true);
  guard.cancel(otherTurn.requestId);
  assert.deepEqual(guard.canCommit(otherTurn, otherTurn.primaryTextIdentity), {
    ok: false,
    current: false,
    reason: 'invalidated',
  });

  guard.clearPrimaryText(retry.primaryTextIdentity);
  assert.deepEqual(guard.canCommit(retry, retry.primaryTextIdentity), {
    ok: false,
    current: false,
    reason: 'invalidated',
  });
});

test('full text request guard settlement cannot remove a newer replacement target', () => {
  const first = envelope('req-settle-first', 'turn-1', 'same target line');
  const replacement = envelope('req-settle-replacement', 'turn-1', 'same target line');
  const guard = new CurrentVideoFullTextRequestGuard();

  guard.start(first);
  guard.start(replacement);
  assert.equal(guard.canCommit(first).reason, 'replaced');
  assert.equal(guard.canCommit(replacement).ok, true);

  guard.settle(first);
  assert.equal(guard.canCommit(replacement).ok, true);

  guard.cancel(replacement.requestId);
  assert.equal(guard.canCommit(replacement).reason, 'invalidated');
  guard.settle(replacement);
  assert.equal(guard.canCommit(replacement).reason, 'wrong_target');

  guard.cancel('already-settled-request');
  assert.equal(guard.canCommit(replacement).reason, 'wrong_target');
});

function sourceOption(
  source: 'bilibili_subtitle' | 'local_transcript',
  bvid: string,
  cid: number,
  page: number,
  language: string,
  text: string,
) {
  const identity = buildCurrentVideoTextSourceIdentity({
    bvid,
    cid,
    page,
    source,
    sourceType: source === 'bilibili_subtitle' ? 'bilibili_player_wbi_v2' : 'local_transcript',
    language,
    lines: [{ startSeconds: 0, endSeconds: 2, text }],
  });
  return buildPrimaryTextSourceOption({
    identity,
    byteSize: text.length,
  });
}

function envelope(requestId: string, turnId: string, text: string) {
  return buildCurrentVideoFullTextRequestEnvelope({
    requestId,
    operation: 'qa',
    submittedAt: 100,
    model: 'model-a',
    video: {
      bvid: 'BV1Guard',
      cid: 404,
      page: 1,
      title: 'Guard video',
      partTitle: 'Main',
      durationSeconds: 60,
    },
    source: 'bilibili_subtitle',
    sourceType: 'bilibili_player_wbi_v2',
    language: 'zh-CN',
    lines: [{ startSeconds: 0, endSeconds: 1, text }],
    sessionId: 'session-guard',
    turnId,
  });
}
