import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CurrentVideoContext } from '../src/shared/types/current-video-context.ts';
import type { BiliVizRequest, BiliVizResponse } from '../src/shared/types/messages.ts';
import type {
  CurrentVideoSegmentRetrievalResult,
  CurrentVideoTimestampJumpResponse,
  CurrentVideoTimestampOperationLeaseConsumeResult,
  CurrentVideoTimestampReturnResponse,
} from '../src/shared/types/current-video-segment-retrieval.ts';
import type { CurrentVideoSummaryHighlightsResult } from '../src/shared/types/current-video-summary.ts';
import type { CurrentVideoFullTextQaResult } from '../src/shared/types/current-video-full-text-qa.ts';
import {
  CURRENT_VIDEO_QA_SESSION_MAX_BYTES,
  type CurrentVideoQaSessionRecord,
} from '../src/shared/types/current-video-qa-session.ts';
import type { CurrentVideoSubtitleViewSourcesResult } from '../src/shared/current-video-subtitle-view.ts';
import type { VideoKnowledgeResult } from '../src/shared/types/video-knowledge.ts';
import {
  CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY,
  type SaveCurrentVideoPrimaryTextSelectionResult,
} from '../src/shared/current-video-primary-text-selection.ts';

type RuntimeListener = (
  message: unknown,
  sender: { tab?: { id?: number; url?: string | null } },
  sendResponse: (response: unknown) => void,
) => boolean | undefined;
type RemovedListener = (tabId: number) => void;
type UpdatedListener = (tabId: number, changeInfo: { url?: string }) => void;
type FakeTab = { id: number; url: string | null; active: boolean; lastAccessed: number | null };

const runtimeListeners: RuntimeListener[] = [];
const removedListeners: RemovedListener[] = [];
const updatedListeners: UpdatedListener[] = [];
const tabs: FakeTab[] = [];
const tabMessageHandlers = new Map<number, (message: unknown) => Promise<unknown> | unknown>();
const storageValues: Record<string, unknown> = {};
const storageGetCounts = new Map<string, number>();
let rejectPrimaryTextSelectionStorageReads = false;
let primaryTextSelectionStorageGetGate: Promise<void> | null = null;
let storageRemoveGate: {
  key: string;
  reached: () => void;
  release: Promise<void>;
} | null = null;
let storageSetGate: {
  key: string;
  reached: () => void;
  release: Promise<void>;
} | null = null;
let storageGetGate: {
  key: string;
  reached: () => void;
  release: Promise<void>;
} | null = null;

installChromeFake();
const {
  clearTemporaryCurrentVideoTranscriptCache,
  computeDailyAggregate,
  computeStoredHistoryAggregates,
  db,
  getCurrentVideoCurrentOwnerTranscriptSourceIdentityKeys,
  getTemporaryCurrentVideoTranscriptSegments,
  invalidateCurrentVideoFullTextQaSources,
  normalizeBilibiliTranscriptEvidence,
  putTemporaryCurrentVideoTranscriptEvidence,
  retainTemporaryTranscriptOwnerForContextSnapshot,
  setupMessageHandlers,
  upsertCurrentVideoTranscriptEvidence,
} = await importBundledMessageHandlers();
setupMessageHandlers();

test('learning source capture saves exact current subtitle and rejects altered snapshot or stale selection', async () => {
  resetChromeHarness();
  await resetTranscriptDb();
  await db.lgAssets.clear(); await db.lgMeta.clear();
  const tabId = 19099;
  const context = handlerVideoContext('BV1234567890', 4999);
  const evidence = await seedHandlerTranscript(context, tabId, 'learning-source', '来源必须与当前视频一致。');
  const identity = evidence.sourceRecord.sourceIdentityKey!;
  storageValues[CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY] = { [handlerPartKey(context)]: identity };
  setTabs([{ id: tabId, url: context.url, active: true, lastAccessed: 1 }]);
  await sendContentMessage({ action: 'CURRENT_VIDEO_CONTEXT_UPDATE', payload: context }, tabId, context.url);
  await confirmHandlerTranscriptCurrent(context, tabId, evidence);
  const capture = { token: 'f'.repeat(64), kind: 'note', video: { bvid: context.bvid, title: context.title }, part: { cid: '4999', page: 1 }, bookmarkMs: null };
  tabMessageHandlers.set(tabId, (message: any) => message.action === 'CAPTURE_LEARNING_CONTEXT' || message.action === 'CHECK_LEARNING_CONTEXT' ? { capture } : context);
  const source = { origin: 'subtitle', sourceIdentityKey: identity, segmentIds: [evidence.segments[0].segmentId] };
  const prepared = await sendRequest<any>({ action: 'LEARNING_PREPARE_SOURCE', params: { source } }, tabId, context.url);
  assert.equal(prepared.success, true, JSON.stringify(prepared));
  assert.equal(prepared.data.snapshot.body, '来源必须与当前视频一致。');
  const view = await sendRequest<CurrentVideoSubtitleViewSourcesResult>({ action: 'GET_CURRENT_VIDEO_SUBTITLE_VIEW_SOURCES' }, tabId, context.url);
  assert.equal(view.success, true);
  const line = view.data!.sources[0].lines[0];
  const visibleSource = { origin: 'subtitle', sourceIdentityKey: identity, subtitleLine: { id: line.lineId, binding: line.lineBindingKey } };
  const badBinding = await sendRequest({ action: 'LEARNING_PREPARE_SOURCE', params: { source: { ...visibleSource, subtitleLine: { id: line.lineId, binding: 'changed' } } } }, tabId, context.url);
  assert.equal(badBinding.success, false);
  const visiblePrepared = await sendRequest<any>({ action: 'LEARNING_PREPARE_SOURCE', params: { source: visibleSource } }, tabId, context.url);
  assert.equal(visiblePrepared.success, true, JSON.stringify(visiblePrepared));
  assert.deepEqual(visiblePrepared.data.snapshot, prepared.data.snapshot);
  const asset = { id: 'e'.repeat(64), kind: 'excerpt', createdAt: 1, updatedAt: 1, video: capture.video, part: capture.part,
    personal: { title: '真实来源边界', note: '', tags: [] }, snapshot: prepared.data.snapshot, bookmarkMs: null, importedFrom: null };
  const altered = structuredClone(asset); altered.snapshot.body = '未验证文字';
  const invalid = await sendRequest({ action: 'LEARNING_SAVE', params: { epoch: 0, token: capture.token, asset: altered } }, tabId, context.url);
  assert.equal(invalid.success, false);
  const saved = await sendRequest({ action: 'LEARNING_SAVE', params: { epoch: 0, token: capture.token, asset } }, tabId, context.url);
  assert.equal(saved.success, true, JSON.stringify(saved));
  storageValues[CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY] = { [handlerPartKey(context)]: 'different-source' };
  const stale = await sendRequest({ action: 'LEARNING_SAVE', params: { epoch: 0, token: capture.token, asset: { ...asset, id: 'd'.repeat(64) } } }, tabId, context.url);
  assert.equal(stale.success, false);
  const retry = await sendRequest({ action: 'LEARNING_SAVE', params: { epoch: 0, token: capture.token, asset } }, tabId, context.url);
  assert.equal(retry.success, true);
  assert.equal(await db.lgAssets.count(), 1);
});

test('background selection action serializes interleaved tab saves without replacing other parts', async () => {
  resetChromeHarness();
  const storageKey = CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY;
  storageValues[storageKey] = {
    'BV1SavedA:1001:1': 'source-a',
    'BV1SavedB:1002:2': 'source-b',
  };
  let releaseFirstRead!: () => void;
  primaryTextSelectionStorageGetGate = new Promise<void>((resolve) => {
    releaseFirstRead = resolve;
  });

  const tabOnePromise = sendRequest<SaveCurrentVideoPrimaryTextSelectionResult>({
      action: 'SAVE_CURRENT_VIDEO_PRIMARY_TEXT_SELECTION' as BiliVizRequest['action'],
      params: {
        bvid: 'BV1SavedC',
        cid: 1003,
        page: 3,
        selectedSourceIdentityKey: 'source-c',
      },
    }, 19_001, 'https://www.bilibili.com/video/BV1SavedC?p=3');
  const tabTwoPromise = sendRequest<SaveCurrentVideoPrimaryTextSelectionResult>({
      action: 'SAVE_CURRENT_VIDEO_PRIMARY_TEXT_SELECTION' as BiliVizRequest['action'],
      params: {
        bvid: 'BV1SavedD',
        cid: 1004,
        page: 4,
        selectedSourceIdentityKey: 'source-d',
      },
    }, 19_002, 'https://www.bilibili.com/video/BV1SavedD?p=4');

  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(storageReadCount(storageKey), 1, 'the second handler save must wait before reading');
  releaseFirstRead();
  const [tabOne, tabTwo] = await Promise.all([tabOnePromise, tabTwoPromise]);

  assert.equal(tabOne.success, true);
  assert.equal(tabTwo.success, true);
  assert.deepEqual(storageValues[storageKey], {
    'BV1SavedA:1001:1': 'source-a',
    'BV1SavedB:1002:2': 'source-b',
    'BV1SavedC:1003:3': 'source-c',
    'BV1SavedD:1004:4': 'source-d',
  });
  assert.deepEqual(tabTwo.data?.selections, storageValues[storageKey]);
});

test('fixed popup tab owner keeps A context readable after active tab switches to B', () => {
  clearTemporaryCurrentVideoTranscriptCache();
  const contextA = handlerVideoContext('BV1HandlerA0', 8801);
  const tabA = 801;
  const tabB = 802;
  const ownerA = retainTemporaryTranscriptOwnerForContextSnapshot(contextA, tabA);
  assert.ok(ownerA);

  const evidenceA = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 0, to: 2, content: 'A 标签页的临时字幕应该跟随初始 owner。' }] },
    {
      bvid: contextA.bvid,
      cid: contextA.cid as number,
      page: contextA.currentPart.page,
      language: 'zh-CN',
      sourceType: 'bilibili_player_wbi_v2',
      trackId: '7',
      trackUrlHost: 'aisubtitle.hdslb.com',
      fetchedAt: 11_000,
    },
  );
  assert.equal(putTemporaryCurrentVideoTranscriptEvidence(ownerA, evidenceA).status, 'stored');

  const activeTabAfterDelay = tabB;
  const ownerFromWrongActiveTab = retainTemporaryTranscriptOwnerForContextSnapshot(contextA, activeTabAfterDelay);
  assert.ok(ownerFromWrongActiveTab);
  const identity = {
    bvid: evidenceA.sourceRecord.bvid,
    cid: evidenceA.sourceRecord.cid,
    page: evidenceA.sourceRecord.page,
    language: evidenceA.sourceRecord.language,
    sourceIdentityKey: evidenceA.sourceRecord.sourceIdentityKey,
    sourceHash: evidenceA.sourceRecord.sourceHash,
  };

  assert.equal(getTemporaryCurrentVideoTranscriptSegments(ownerA, identity).length, 1);
  assert.equal(getTemporaryCurrentVideoTranscriptSegments(ownerFromWrongActiveTab, identity).length, 0);
});

test('handler clears same-BV page-1 context on page navigation and refreshes page 2 without touching A', async () => {
  resetChromeHarness();
  await resetTranscriptDb();

  const tabId = 18_601;
  const bvid = 'BV1SameBvLeak9';
  const contextA = handlerVideoContext(bvid, 4101, 1);
  const contextB = handlerVideoContext(bvid, 4102, 2);
  const evidenceA = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 0, to: 3, content: 'persistent A before same BV page navigation' }] },
    {
      bvid,
      cid: 4101,
      page: 1,
      language: 'zh-CN',
      sourceType: 'bilibili_player_wbi_v2',
      trackId: 'same-bv-a',
      trackUrlHost: 'aisubtitle.hdslb.com',
      fetchedAt: 11_100,
    },
  );
  await upsertCurrentVideoTranscriptEvidence(evidenceA);
  const sourceBefore = await transcriptSource(evidenceA.sourceRecord.identityKey);

  setTabs([{ id: tabId, url: contextA.url, active: true, lastAccessed: 1_000 }]);
  await sendContentMessage({
    action: 'CURRENT_VIDEO_CONTEXT_UPDATE',
    payload: contextA,
  }, tabId, contextA.url);

  let freshContextRequests = 0;
  setTabMessageHandler(tabId, (message) => {
    assert.deepEqual(message, {
      action: 'COLLECT_CURRENT_VIDEO_CONTEXT',
      payload: {},
    });
    freshContextRequests += 1;
    return contextB;
  });

  emitTabUpdated(tabId, contextB.url);
  setTabs([{ id: tabId, url: contextB.url, active: true, lastAccessed: 2_000 }]);

  const response = await sendRequest<CurrentVideoSegmentRetrievalResult>({
    action: 'SEARCH_CURRENT_VIDEO_SEGMENTS',
    params: {
      query: 'persistent A before same BV page navigation',
      primaryTextSelectionsReady: true,
    },
  }, tabId, contextB.url);

  assert.equal(response.success, true);
  assert.equal(freshContextRequests, 1);
  assert.equal(response.data?.status, 'no_evidence');
  assert.equal(response.data?.candidates.length, 0);
  assert.equal(response.data?.evidenceState.transcriptSegmentCount, 0);

  const sourceAfter = await transcriptSource(evidenceA.sourceRecord.identityKey);
  assert.equal(sourceAfter?.lastAccessedAt, sourceBefore?.lastAccessedAt);
});

test('request-tab lookup revalidates stale same-BV page context before exact-source search', async () => {
  resetChromeHarness();
  await resetTranscriptDb();

  const tabId = 18_608;
  const bvid = 'BV1RequestTabRace';
  const contextP1 = handlerVideoContext(bvid, 4801, 1);
  const contextP2 = handlerVideoContext(bvid, 4802, 2);
  const evidenceP1 = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 0, to: 3, content: 'page one exact transcript must not leak into page two' }] },
    {
      bvid,
      cid: 4801,
      page: 1,
      language: 'zh-CN',
      sourceType: 'bilibili_player_wbi_v2',
      trackId: 'request-tab-race-p1',
      trackUrlHost: 'aisubtitle.hdslb.com',
      fetchedAt: 11_600,
    },
  );
  await upsertCurrentVideoTranscriptEvidence(evidenceP1);
  await db.currentVideoTranscriptSources
    .where('identityKey')
    .equals(evidenceP1.sourceRecord.identityKey)
    .modify({ lastAccessedAt: 1_000 });
  const sourceBefore = await transcriptSource(evidenceP1.sourceRecord.identityKey);

  setTabs([{ id: tabId, url: contextP1.url, active: true, lastAccessed: 7_000 }]);
  await sendContentMessage({
    action: 'CURRENT_VIDEO_CONTEXT_UPDATE',
    payload: contextP1,
  }, tabId, contextP1.url);

  let freshContextRequests = 0;
  setTabMessageHandler(tabId, (message) => {
    assert.deepEqual(message, {
      action: 'COLLECT_CURRENT_VIDEO_CONTEXT',
      payload: {},
    });
    freshContextRequests += 1;
    return contextP2;
  });

  setTabs([{ id: tabId, url: contextP2.url, active: true, lastAccessed: 8_000 }]);
  const search = await sendRequest<CurrentVideoSegmentRetrievalResult>({
    action: 'SEARCH_CURRENT_VIDEO_SEGMENTS',
    params: {
      query: 'page one exact transcript',
      primaryTextSelectionsReady: true,
      selectedSourceIdentityKey: evidenceP1.sourceRecord.sourceIdentityKey,
    },
  }, tabId, contextP2.url);

  assert.equal(search.success, true);
  assert.equal(freshContextRequests, 1);
  assert.equal(search.data?.status, 'no_evidence');
  assert.equal(search.data?.candidates.length, 0);
  assert.equal(search.data?.evidenceState.transcriptSegmentCount, 0);

  const sourceAfter = await transcriptSource(evidenceP1.sourceRecord.identityKey);
  assert.equal(sourceAfter?.lastAccessedAt, sourceBefore?.lastAccessedAt);

  await sendContentMessage({
    action: 'CURRENT_VIDEO_CONTEXT_UPDATE',
    payload: contextP1,
  }, tabId, contextP2.url);
  const contextAfterLateP1 = await sendRequest<CurrentVideoContext>({
    action: 'GET_CURRENT_VIDEO_CONTEXT',
    params: {},
  }, tabId, contextP2.url);

  assert.equal(contextAfterLateP1.success, true);
  assert.equal(contextAfterLateP1.data?.kind, 'video');
  assert.equal(contextAfterLateP1.data?.kind === 'video' ? contextAfterLateP1.data.cid : null, 4802);
  assert.equal(contextAfterLateP1.data?.kind === 'video' ? contextAfterLateP1.data.currentPart.page : null, 2);
});

test('handler rejects late page-1 context updates after the sender tab is on page 2', async () => {
  resetChromeHarness();
  await resetTranscriptDb();

  const tabId = 18_602;
  const bvid = 'BV1LateCtx186';
  const contextA = handlerVideoContext(bvid, 4201, 1);
  const contextB = handlerVideoContext(bvid, 4202, 2);
  setTabs([{ id: tabId, url: contextB.url, active: true, lastAccessed: 2_000 }]);
  setTabMessageHandler(tabId, () => contextB);

  await sendContentMessage({
    action: 'CURRENT_VIDEO_CONTEXT_UPDATE',
    payload: contextB,
  }, tabId, contextB.url);
  await sendContentMessage({
    action: 'CURRENT_VIDEO_CONTEXT_UPDATE',
    payload: contextA,
  }, tabId, contextB.url);

  const response = await sendRequest<CurrentVideoContext>({
    action: 'GET_CURRENT_VIDEO_CONTEXT',
    params: {},
  }, tabId, contextB.url);

  assert.equal(response.success, true);
  assert.equal(response.data?.kind, 'video');
  assert.equal(response.data?.kind === 'video' ? response.data.cid : null, 4202);
  assert.equal(response.data?.kind === 'video' ? response.data.currentPart.page : null, 2);
});

test('handler ignores late no-context updates without overwriting the current video snapshot', async () => {
  resetChromeHarness();
  await resetTranscriptDb();

  const tabId = 18_603;
  const context = handlerVideoContext('BV1NoCtxLate9', 4301, 1);
  let freshContextRequests = 0;
  setTabs([{ id: tabId, url: context.url, active: true, lastAccessed: 2_000 }]);
  setTabMessageHandler(tabId, () => {
    freshContextRequests += 1;
    return context;
  });

  await sendContentMessage({
    action: 'CURRENT_VIDEO_CONTEXT_UPDATE',
    payload: context,
  }, tabId, context.url);
  await sendContentMessage({
    action: 'CURRENT_VIDEO_CONTEXT_UPDATE',
    payload: {
      kind: 'no_context',
      url: 'https://www.bilibili.com/',
      collectedAt: Date.now(),
      reason: 'non_video_page',
      pageType: 'non_video',
    },
  }, tabId, context.url);

  const response = await sendRequest<CurrentVideoContext>({
    action: 'GET_CURRENT_VIDEO_CONTEXT',
    params: {},
  }, tabId, context.url);

  assert.equal(response.success, true);
  assert.equal(response.data?.kind, 'video');
  assert.equal(response.data?.kind === 'video' ? response.data.cid : null, 4301);
  assert.equal(freshContextRequests, 0);
});

test('legacy bounded current-video summary route is not runtime reachable', async () => {
  resetChromeHarness();

  const response = await sendRequest({
    action: 'GET_CURRENT_VIDEO_SUMMARY' as BiliVizRequest['action'],
    params: {},
  }, 18_603, 'https://www.bilibili.com/video/BV1LegacySummary9');

  assert.equal(response.success, false);
  assert.match(response.error ?? '', /Unknown action/);
});

test('background full-text handlers fail closed while primary text selection readiness is false', async () => {
  resetChromeHarness();
  await resetTranscriptDb();

  const tabId = 18_604;
  const context = handlerVideoContext('BV1Readiness9', 4401, 1);
  const evidence = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 4, to: 8, content: 'active V2 transcript must not be used while selection storage is loading' }] },
    {
      bvid: context.bvid,
      cid: context.cid as number,
      page: context.currentPart.page,
      language: 'zh-CN',
      sourceType: 'bilibili_player_wbi_v2',
      trackId: 'readiness-v2',
      trackUrlHost: 'aisubtitle.hdslb.com',
      fetchedAt: 11_200,
    },
  );
  await upsertCurrentVideoTranscriptEvidence(evidence);
  const sourceBefore = await transcriptSource(evidence.sourceRecord.identityKey);

  setTabs([{ id: tabId, url: context.url, active: true, lastAccessed: 3_000 }]);
  await sendContentMessage({
    action: 'CURRENT_VIDEO_CONTEXT_UPDATE',
    payload: context,
  }, tabId, context.url);

  const readinessParams = { primaryTextSelectionsReady: false };
  const summaryHighlights = await sendRequest<CurrentVideoSummaryHighlightsResult>({
    action: 'GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS',
    params: readinessParams,
  }, tabId, context.url);
  const knowledge = await sendRequest<VideoKnowledgeResult>({
    action: 'GET_VIDEO_KNOWLEDGE',
    params: readinessParams,
  }, tabId, context.url);
  const search = await sendRequest<CurrentVideoSegmentRetrievalResult>({
    action: 'SEARCH_CURRENT_VIDEO_SEGMENTS',
    params: {
      ...readinessParams,
      query: 'active V2 transcript',
    },
  }, tabId, context.url);
  const jump = await sendRequest<CurrentVideoTimestampJumpResponse>({
    action: 'REQUEST_CURRENT_VIDEO_SEGMENT_JUMP',
    params: {
      ...readinessParams,
      candidateId: 'readiness-blocked-candidate',
      query: 'active V2 transcript',
      confirmed: true,
    },
  }, tabId, context.url);

  assert.equal(summaryHighlights.success, true);
  assert.equal(summaryHighlights.data?.status, 'cancelled');
  assert.match(summaryHighlights.data?.message ?? '', /主要文本来源/);
  assert.equal(summaryHighlights.data?.highlights.length, 0);

  assert.equal(knowledge.success, true);
  assert.equal(knowledge.data?.nodes.length, 0);
  assert.equal(knowledge.data?.sourceState.transcriptEvidence, false);
  assert.match(knowledge.data?.limitations.join(' ') ?? '', /主要文本来源/);

  assert.equal(search.success, true);
  assert.equal(search.data?.status, 'no_evidence');
  assert.equal(search.data?.candidates.length, 0);
  assert.equal(search.data?.evidenceState.transcriptSegmentCount, 0);
  assert.match(search.data?.summary ?? '', /主要文本来源/);
  assert.equal(search.data?.aiRerank.status, 'not_requested');
  assert.equal(search.data?.qa.aiState.status, 'not_requested');

  assert.equal(jump.success, true);
  assert.equal(jump.data?.ok, false);
  assert.equal(jump.data?.targetSeconds, null);
  assert.match(jump.data?.message ?? '', /主要文本来源/);

  const sourceAfter = await transcriptSource(evidence.sourceRecord.identityKey);
  assert.equal(sourceAfter?.lastAccessedAt, sourceBefore?.lastAccessedAt);
  assert.equal(storageReadCount('userConfig'), 0);
});

test('background full-text handlers fail closed when the readiness marker is missing or malformed', async () => {
  resetChromeHarness();
  await resetTranscriptDb();

  const tabId = 18_605;
  const context = handlerVideoContext('BV1MissingReady9', 4501, 1);
  const evidence = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 9, to: 13, content: 'marker absent V2 body must remain unread' }] },
    {
      bvid: context.bvid,
      cid: context.cid as number,
      page: context.currentPart.page,
      language: 'zh-CN',
      sourceType: 'bilibili_player_wbi_v2',
      trackId: 'missing-marker-v2',
      trackUrlHost: 'aisubtitle.hdslb.com',
      fetchedAt: 11_300,
    },
  );
  await upsertCurrentVideoTranscriptEvidence(evidence);
  const sourceBefore = await transcriptSource(evidence.sourceRecord.identityKey);

  setTabs([{ id: tabId, url: context.url, active: true, lastAccessed: 4_000 }]);
  await sendContentMessage({
    action: 'CURRENT_VIDEO_CONTEXT_UPDATE',
    payload: context,
  }, tabId, context.url);

  const summaryHighlights = await sendRequest<CurrentVideoSummaryHighlightsResult>({
    action: 'GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS',
    params: {},
  }, tabId, context.url);
  const knowledge = await sendRequest<VideoKnowledgeResult>({
    action: 'GET_VIDEO_KNOWLEDGE',
    params: {},
  }, tabId, context.url);
  const search = await sendRequest<CurrentVideoSegmentRetrievalResult>({
    action: 'SEARCH_CURRENT_VIDEO_SEGMENTS',
    params: { query: 'marker absent V2 body' },
  }, tabId, context.url);
  const jump = await sendRequest<CurrentVideoTimestampJumpResponse>({
    action: 'REQUEST_CURRENT_VIDEO_SEGMENT_JUMP',
    params: {
      candidateId: 'missing-marker-candidate',
      query: 'marker absent V2 body',
      confirmed: true,
    },
  }, tabId, context.url);
  const malformed = await sendRequest<CurrentVideoSummaryHighlightsResult>({
    action: 'GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS',
    params: { primaryTextSelectionsReady: 'true' },
  }, tabId, context.url);

  assert.equal(summaryHighlights.data?.status, 'cancelled');
  assert.equal(summaryHighlights.data?.highlights.length, 0);
  assert.equal(knowledge.data?.nodes.length, 0);
  assert.equal(knowledge.data?.sourceState.transcriptEvidence, false);
  assert.equal(search.data?.status, 'no_evidence');
  assert.equal(search.data?.candidates.length, 0);
  assert.equal(search.data?.evidenceState.transcriptSegmentCount, 0);
  assert.equal(search.data?.aiRerank.status, 'not_requested');
  assert.equal(search.data?.qa.aiState.status, 'not_requested');
  assert.equal(jump.data?.ok, false);
  assert.equal(jump.data?.targetSeconds, null);
  assert.match(jump.data?.message ?? '', /主要文本来源/);
  assert.equal(malformed.data?.status, 'cancelled');

  const sourceAfter = await transcriptSource(evidence.sourceRecord.identityKey);
  assert.equal(sourceAfter?.lastAccessedAt, sourceBefore?.lastAccessedAt);
  assert.equal(storageReadCount('userConfig'), 0);
});

test('handler full-text QA sends every authorized line and explicit cancellation aborts the matching attempt', async () => {
  resetChromeHarness();
  await resetTranscriptDb();
  const tabId = 18_625;
  const context = handlerVideoContext('BV1HandlerFullQa', 4825);
  const evidence = normalizeBilibiliTranscriptEvidence(
    {
      body: [
        { from: 2, to: 7, content: '第一行说明当前视频的问题背景。' },
        { from: 7, to: 12, content: '第二行给出当前视频的方法。' },
      ],
    },
    {
      bvid: context.bvid,
      cid: context.cid as number,
      page: context.currentPart.page,
      language: 'zh-CN',
      sourceType: 'bilibili_player_wbi_v2',
      trackId: 'handler-full-qa',
      trackUrlHost: 'aisubtitle.hdslb.com',
      fetchedAt: 12_500,
    },
  );
  const owner = retainTemporaryTranscriptOwnerForContextSnapshot(context, tabId);
  assert.ok(owner);
  await upsertCurrentVideoTranscriptEvidence(evidence, { temporaryOwner: owner });
  const sourceIdentityKey = evidence.sourceRecord.sourceIdentityKey!;
  storageValues[CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY] = {
    [handlerPartKey(context)]: sourceIdentityKey,
  };
  setTabs([{ id: tabId, url: context.url, active: true, lastAccessed: 8_825 }]);
  await sendContentMessage({ action: 'CURRENT_VIDEO_CONTEXT_UPDATE', payload: context }, tabId, context.url);
  await confirmHandlerTranscriptCurrent(context, tabId, evidence);
  await sendRequest<void>({
    action: 'UPDATE_CONFIG',
    params: {
      ai: {
        baseURL: 'https://example.invalid',
        apiKey: 'handler-test-key',
        chatModel: 'handler-test-model',
      },
      assistant: { currentVideoAiAssistantEnabled: true },
    },
  }, tabId, context.url);

  const originalFetch = globalThis.fetch;
  try {
    let outboundPayload: { textLines?: unknown[]; question?: string } | null = null;
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      outboundPayload = JSON.parse(body.messages[1]!.content) as typeof outboundPayload;
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          supported: true,
          answerPoints: [{
            text: '作者先说明问题背景，再给出处理方法。',
            evidenceLineNumbers: [1, 2],
          }],
          citations: [{ evidenceLineNumbers: [1, 2] }],
        }) } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const answered = await sendRequest<CurrentVideoFullTextQaResult>({
      action: 'ASK_CURRENT_VIDEO_FULL_TEXT' as BiliVizRequest['action'],
      params: {
        sessionId: 'handler-full-qa-session',
        requestId: 'handler-full-qa-request',
        turnId: 'handler-full-qa-turn',
        question: '作者提出了什么方法？',
        primaryTextSelectionsReady: true,
        selectedSourceIdentityKey: sourceIdentityKey,
      },
    }, tabId, context.url);

    assert.equal(answered.success, true);
    assert.equal(answered.data?.status, 'ready');
    assert.equal(answered.data?.requestId, 'handler-full-qa-request');
    assert.equal(answered.data?.turnId, 'handler-full-qa-turn');
    assert.equal(outboundPayload?.question, '作者提出了什么方法？');
    assert.equal(outboundPayload?.textLines?.length, 2);
    assert.equal(answered.data?.citations[0]?.evidenceText, '第一行说明当前视频的问题背景。 第二行给出当前视频的方法。');

    const persistedCitation = answered.data?.citations[0];
    assert.ok(persistedCitation);
    invalidateCurrentVideoFullTextQaSources();
    let persistedCitationJumpCount = 0;
    setTabMessageHandler(tabId, () => {
      persistedCitationJumpCount += 1;
      return blockedTimestampJumpMock(persistedCitation.id);
    });
    const persistedJump = await sendRequest<CurrentVideoTimestampJumpResponse>({
      action: 'REQUEST_CURRENT_VIDEO_QA_CITATION_JUMP' as BiliVizRequest['action'],
      params: {
        ...persistedCitation.binding,
        confirmed: true,
        primaryTextSelectionsReady: true,
        selectedSourceIdentityKey: sourceIdentityKey,
      },
    }, tabId, context.url);
    assert.equal(persistedJump.success, true);
    assert.equal(persistedCitationJumpCount, 1);

    let markFetchStarted!: () => void;
    let resolveCancelledFetch!: (response: Response) => void;
    let outboundSignal: AbortSignal | null = null;
    let cancellationFetchCalls = 0;
    const fetchStarted = new Promise<void>(resolve => { markFetchStarted = resolve; });
    globalThis.fetch = ((_input, init) => {
      cancellationFetchCalls += 1;
      if (cancellationFetchCalls > 1) {
        return Promise.resolve(new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            supported: true,
            answerPoints: [{ text: '取消后提交的新问题可以继续回答。', evidenceLineNumbers: [1] }],
            citations: [{ evidenceLineNumbers: [1] }],
          }) } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      outboundSignal = init?.signal as AbortSignal | null;
      markFetchStarted();
      return new Promise<Response>((resolve) => {
        resolveCancelledFetch = resolve;
      });
    }) as typeof fetch;

    const pending = sendRequest<CurrentVideoFullTextQaResult>({
      action: 'ASK_CURRENT_VIDEO_FULL_TEXT' as BiliVizRequest['action'],
      params: {
        requestId: 'handler-full-qa-cancel-request',
        turnId: 'handler-full-qa-cancel-turn',
        question: '取消这次问题。',
        primaryTextSelectionsReady: true,
        selectedSourceIdentityKey: sourceIdentityKey,
      },
    }, tabId, context.url);
    await fetchStarted;
    await sendRequest<void>({
      action: 'CANCEL_CURRENT_VIDEO_FULL_TEXT_QA' as BiliVizRequest['action'],
      params: { requestId: 'handler-full-qa-cancel-request' },
    }, tabId, context.url);
    assert.equal(outboundSignal?.aborted, true);

    const continued = await sendRequest<CurrentVideoFullTextQaResult>({
      action: 'ASK_CURRENT_VIDEO_FULL_TEXT' as BiliVizRequest['action'],
      params: {
        requestId: 'handler-full-qa-after-cancel-request',
        turnId: 'handler-full-qa-after-cancel-turn',
        question: '取消后可以继续提问吗？',
        primaryTextSelectionsReady: true,
        selectedSourceIdentityKey: sourceIdentityKey,
      },
    }, tabId, context.url);
    assert.equal(continued.success, true);
    assert.equal(continued.data?.status, 'ready');
    assert.equal(cancellationFetchCalls, 2);

    resolveCancelledFetch(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        supported: true,
        answerPoints: [{ text: '这个迟到回答必须被丢弃。', evidenceLineNumbers: [1] }],
        citations: [{ evidenceLineNumbers: [1] }],
      }) } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const cancelled = await pending;
    assert.equal(cancelled.success, true);
    assert.equal(cancelled.data?.status, 'cancelled');
    assert.equal(cancelled.data?.question, '取消这次问题。');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('handler rejects a session write at the hard byte limit before any AI request', async () => {
  resetChromeHarness();
  await resetTranscriptDb();
  await db.currentVideoQaSessions.clear();
  const tabId = 18_635;
  const context = handlerVideoContext('BV1HandlerQaLimit', 4835);
  const evidence = await seedHandlerTranscript(
    context,
    tabId,
    'handler-qa-limit',
    '这一行正文用于验证会话空间达到上限时不会发送 AI 请求。',
  );
  const sourceIdentityKey = evidence.sourceRecord.sourceIdentityKey!;
  storageValues[CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY] = {
    [handlerPartKey(context)]: sourceIdentityKey,
  };
  setTabs([{ id: tabId, url: context.url, active: true, lastAccessed: 8_835 }]);
  await sendContentMessage({ action: 'CURRENT_VIDEO_CONTEXT_UPDATE', payload: context }, tabId, context.url);
  await confirmHandlerTranscriptCurrent(context, tabId, evidence);
  await sendRequest<void>({
    action: 'UPDATE_CONFIG',
    params: {
      ai: {
        baseURL: 'https://example.invalid',
        apiKey: 'handler-test-key',
        chatModel: 'handler-test-model',
      },
      assistant: { currentVideoAiAssistantEnabled: true },
    },
  }, tabId, context.url);

  const sessionId = 'handler-qa-limit-session';
  const stored = qaSessionNearByteLimit(sessionId);
  await db.currentVideoQaSessions.put(stored);
  const initialRows = await db.currentVideoQaSessions.toArray();
  assert.ok(serializedTestBytes(initialRows) <= CURRENT_VIDEO_QA_SESSION_MAX_BYTES);

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  try {
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error('AI request must not start after the local session limit rejects the turn');
    }) as typeof fetch;

    const response = await sendRequest<CurrentVideoFullTextQaResult>({
      action: 'ASK_CURRENT_VIDEO_FULL_TEXT' as BiliVizRequest['action'],
      params: {
        sessionId,
        requestId: 'handler-qa-limit-request',
        turnId: 'handler-qa-limit-new-turn',
        question: '达到本地上限后还能提问吗？',
        primaryTextSelectionsReady: true,
        selectedSourceIdentityKey: sourceIdentityKey,
      },
    }, tabId, context.url);

    assert.equal(response.success, true);
    assert.equal(response.data?.status, 'error');
    assert.match(response.data?.message ?? '', /25 MB 上限/);
    assert.equal(fetchCalls, 0);
    const persisted = await db.currentVideoQaSessions.where({ sessionId }).first();
    assert.equal(persisted?.turns.length, 1);
    assert.ok(serializedTestBytes(await db.currentVideoQaSessions.toArray()) <= CURRENT_VIDEO_QA_SESSION_MAX_BYTES);
  } finally {
    globalThis.fetch = originalFetch;
    await db.currentVideoQaSessions.clear();
  }
});

test('handler clear paths prevent a preflight request from restoring QA sessions', async t => {
  const cases: Array<{
    name: string;
    action: BiliVizRequest['action'];
    params?: Record<string, unknown>;
  }> = [
    {
      name: 'independent QA session clear',
      action: 'CLEAR_CURRENT_VIDEO_QA_SESSIONS' as BiliVizRequest['action'],
    },
    {
      name: 'clear all local data',
      action: 'CLEAR_ALL_LOCAL_DATA',
      params: { confirmation: '清理本地数据' },
    },
  ];

  for (const [index, currentCase] of cases.entries()) {
    await t.test(currentCase.name, async () => {
      resetChromeHarness();
      await resetTranscriptDb();
      await db.currentVideoQaSessions.clear();
      const tabId = 18_636 + index;
      const context = handlerVideoContext(`BV1QaClear0${index}`, 4_836 + index);
      const evidence = await seedHandlerTranscript(
        context,
        tabId,
        `handler-qa-clear-${index}`,
        '这一行正文用于验证清理完成后旧请求不能恢复问答会话。',
      );
      const sourceIdentityKey = evidence.sourceRecord.sourceIdentityKey!;
      storageValues[CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY] = {
        [handlerPartKey(context)]: sourceIdentityKey,
      };
      setTabs([{ id: tabId, url: context.url, active: true, lastAccessed: 8_836 + index }]);
      await sendContentMessage({ action: 'CURRENT_VIDEO_CONTEXT_UPDATE', payload: context }, tabId, context.url);
      await confirmHandlerTranscriptCurrent(context, tabId, evidence);
      await sendRequest<void>({
        action: 'UPDATE_CONFIG',
        params: {
          ai: {
            baseURL: 'https://example.invalid',
            apiKey: 'handler-test-key',
            chatModel: 'handler-test-model',
          },
          assistant: { currentVideoAiAssistantEnabled: true },
        },
      }, tabId, context.url);

      let fetchCalls = 0;
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async () => {
          fetchCalls += 1;
          throw new Error('AI request must not start after QA sessions are cleared');
        }) as typeof fetch;
        installGuardTestHook('before_full_text_qa_session_write', async () => {
          const cleared = await sendRequest({
            action: currentCase.action,
            params: currentCase.params,
          }, tabId, context.url);
          assert.equal(cleared.success, true);
        });

        const response = await sendRequest<CurrentVideoFullTextQaResult>({
          action: 'ASK_CURRENT_VIDEO_FULL_TEXT' as BiliVizRequest['action'],
          params: {
            sessionId: `handler-qa-clear-session-${index}`,
            requestId: `handler-qa-clear-request-${index}`,
            turnId: `handler-qa-clear-turn-${index}`,
            question: '清理后这次问题还会保存吗？',
            primaryTextSelectionsReady: true,
            selectedSourceIdentityKey: sourceIdentityKey,
          },
        }, tabId, context.url);

        assert.equal(response.success, true);
        assert.equal(response.data?.status, 'cancelled');
        assert.match(response.data?.message ?? '', /不再写入/);
        assert.equal(fetchCalls, 0);
        assert.equal(await db.currentVideoQaSessions.count(), 0);
      } finally {
        globalThis.fetch = originalFetch;
        await db.currentVideoQaSessions.clear();
      }
    });
  }
});

test('clear all suppresses a heartbeat after history readback while later categories are clearing', async () => {
  resetChromeHarness();
  await resetTranscriptDb();
  await Promise.all([
    db.watchHistory.clear(),
    db.playerEvents.clear(),
    db.dailyAggregates.clear(),
    db.favoriteFolders.clear(),
  ]);
  await db.playerEvents.add({
    bvid: 'BV1BeforeClearHeartbeat',
    cid: 7_301,
    eventType: 'heartbeat',
    timestamp: 1,
    currentTime: 30,
    duration: 120,
    playbackRate: 1,
    tabId: 18_650,
  });
  await db.favoriteFolders.add({
    mediaId: 7_301,
    title: '清理顺序测试收藏夹',
    mediaCount: 0,
    syncedAt: 1,
  });

  const laterCategoryReached = deferred<void>();
  const releaseLaterCategory = deferred<void>();
  storageRemoveGate = {
    key: 'dynamicBillSyncState',
    reached: () => laterCategoryReached.resolve(),
    release: releaseLaterCategory.promise,
  };

  const tabId = 18_650;
  const senderUrl = 'https://www.bilibili.com/video/BV1DuringClearHeartbeat';
  const clearing = sendRequest<{ status: string }>({
    action: 'CLEAR_ALL_LOCAL_DATA',
    params: { confirmation: '清理本地数据' },
  }, tabId, senderUrl);

  try {
    await laterCategoryReached.promise;
    assert.equal(await db.favoriteFolders.count(), 0);
    assert.equal(await db.playerEvents.count(), 0);

    const heartbeat = await sendContentMessage({
      action: 'PLAYER_HEARTBEAT',
      payload: {
        bvid: 'BV1DuringClearHeartbeat',
        cid: 7_302,
        currentTime: 45,
        duration: 120,
        playbackRate: 1,
      },
    }, tabId, senderUrl);
    assert.equal(heartbeat.success, true);
    assert.equal(await db.playerEvents.count(), 0);

    releaseLaterCategory.resolve();
    const clearResult = await clearing;
    assert.equal(clearResult.success, true);
    assert.equal(clearResult.data?.status, 'completed');
    assert.equal(await db.playerEvents.count(), 0);
  } finally {
    releaseLaterCategory.resolve();
    storageRemoveGate = null;
    await clearing.catch(() => undefined);
  }
});

test('history-only clear waits for stored-history aggregation and removes its final write', async () => {
  resetChromeHarness();
  await Promise.all([
    db.watchHistory.clear(),
    db.playerEvents.clear(),
    db.dailyAggregates.clear(),
  ]);
  const aggregateWriteReached = deferred<void>();
  const releaseAggregateWrite = deferred<void>();
  installHistoryAggregateTestHook(async () => {
    aggregateWriteReached.resolve();
    await releaseAggregateWrite.promise;
  });

  const aggregating = computeStoredHistoryAggregates();
  await aggregateWriteReached.promise;
  const clearing = sendRequest<{ status: string }>({
    action: 'CLEAR_LOCAL_DATA_CATEGORY',
    params: { categoryId: 'history' },
  }, 18_654, 'https://www.bilibili.com/video/BV1HistoryAggregate');
  let clearSettled = false;
  void clearing.then(
    () => { clearSettled = true; },
    () => { clearSettled = true; },
  );

  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(clearSettled, false);

    releaseAggregateWrite.resolve();
    await aggregating;
    const clearResult = await clearing;
    assert.equal(clearResult.success, true);
    assert.equal(clearResult.data?.status, 'completed');
    assert.equal(await db.dailyAggregates.count(), 0);
  } finally {
    releaseAggregateWrite.resolve();
    await Promise.allSettled([aggregating, clearing]);
  }
});

test('clear all waits for daily aggregation and removes its final write', async () => {
  resetChromeHarness();
  await Promise.all([
    db.watchHistory.clear(),
    db.playerEvents.clear(),
    db.dailyAggregates.clear(),
  ]);
  const aggregateWriteReached = deferred<void>();
  const releaseAggregateWrite = deferred<void>();
  installHistoryAggregateTestHook(async () => {
    aggregateWriteReached.resolve();
    await releaseAggregateWrite.promise;
  });

  const aggregating = computeDailyAggregate('2026-07-20');
  await aggregateWriteReached.promise;
  const clearing = sendRequest<{ status: string }>({
    action: 'CLEAR_ALL_LOCAL_DATA',
    params: { confirmation: '清理本地数据' },
  }, 18_655, 'https://www.bilibili.com/video/BV1DailyAggregate');
  let clearSettled = false;
  void clearing.then(
    () => { clearSettled = true; },
    () => { clearSettled = true; },
  );

  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(clearSettled, false);

    releaseAggregateWrite.resolve();
    assert.ok(await aggregating);
    const clearResult = await clearing;
    assert.equal(clearResult.success, true);
    assert.equal(clearResult.data?.status, 'completed');
    assert.equal(await db.dailyAggregates.count(), 0);
  } finally {
    releaseAggregateWrite.resolve();
    await Promise.allSettled([aggregating, clearing]);
  }
});

test('clear all waits for an earlier config write and removes its completed value', async () => {
  resetChromeHarness();
  await resetTranscriptDb();
  const configWriteReached = deferred<void>();
  const releaseConfigWrite = deferred<void>();
  storageSetGate = {
    key: 'userConfig',
    reached: () => configWriteReached.resolve(),
    release: releaseConfigWrite.promise,
  };
  const laterCategoryReached = deferred<void>();
  const releaseLaterCategory = deferred<void>();
  let reachedLaterCategory = false;
  storageRemoveGate = {
    key: 'dynamicBillSyncState',
    reached: () => {
      reachedLaterCategory = true;
      laterCategoryReached.resolve();
    },
    release: releaseLaterCategory.promise,
  };

  const tabId = 18_651;
  const senderUrl = 'https://www.bilibili.com/video/BV1ConfigBeforeClear';
  const updating = sendRequest<void>({
    action: 'UPDATE_CONFIG',
    params: {
      ai: {
        baseURL: 'https://example.invalid',
        apiKey: 'fixture-config-key',
        chatModel: 'fixture-model',
      },
    },
  }, tabId, senderUrl);
  await configWriteReached.promise;

  const clearing = sendRequest<{ status: string }>({
    action: 'CLEAR_ALL_LOCAL_DATA',
    params: { confirmation: '清理本地数据' },
  }, tabId, senderUrl);

  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(reachedLaterCategory, false);

    storageSetGate = null;
    releaseConfigWrite.resolve();
    const updateResult = await updating;
    assert.equal(updateResult.success, true);

    await laterCategoryReached.promise;
    releaseLaterCategory.resolve();
    const clearResult = await clearing;
    assert.equal(clearResult.success, true);
    assert.equal(clearResult.data?.status, 'completed');
    assert.equal(storageValues.userConfig, null);
    const revision = storageValues.userConfigRevision as {
      token?: string;
      configPresent?: boolean;
      mutation?: string;
    };
    assert.equal(typeof revision.token, 'string');
    assert.equal(revision.configPresent, false);
    assert.equal(revision.mutation, 'clear');
    assert.doesNotMatch(JSON.stringify(revision), /fixture-config-key/);
  } finally {
    storageSetGate = null;
    storageRemoveGate = null;
    releaseConfigWrite.resolve();
    releaseLaterCategory.resolve();
    await Promise.allSettled([updating, clearing]);
  }
});

test('config writes started during clear all are rejected through final readback', async () => {
  resetChromeHarness();
  await resetTranscriptDb();
  storageValues.userConfig = {
    ai: { apiKey: 'fixture-existing-key' },
  };
  const laterCategoryReached = deferred<void>();
  const releaseLaterCategory = deferred<void>();
  storageRemoveGate = {
    key: 'dynamicBillSyncState',
    reached: () => laterCategoryReached.resolve(),
    release: releaseLaterCategory.promise,
  };

  const tabId = 18_652;
  const senderUrl = 'https://www.bilibili.com/video/BV1ConfigDuringClear';
  const clearing = sendRequest<{ status: string }>({
    action: 'CLEAR_ALL_LOCAL_DATA',
    params: { confirmation: '清理本地数据' },
  }, tabId, senderUrl);

  try {
    await laterCategoryReached.promise;
    const updateResult = await sendRequest<void>({
      action: 'UPDATE_CONFIG',
      params: {
        ai: {
          baseURL: 'https://example.invalid',
          apiKey: 'fixture-late-key',
          chatModel: 'fixture-model',
        },
      },
    }, tabId, senderUrl);
    assert.equal(updateResult.success, false);
    assert.equal(updateResult.error, 'LOCAL_SETTINGS_CLEAR_IN_PROGRESS');

    releaseLaterCategory.resolve();
    const clearResult = await clearing;
    assert.equal(clearResult.success, true);
    assert.equal(clearResult.data?.status, 'completed');
    assert.equal(storageValues.userConfig, null);
  } finally {
    storageRemoveGate = null;
    releaseLaterCategory.resolve();
    await clearing.catch(() => undefined);
  }
});

test('concurrent Settings pages serialize UPDATE_CONFIG and reject the stale second save', async () => {
  resetChromeHarness();
  await resetTranscriptDb();
  const tabId = 18_653;
  const senderUrl = 'https://www.bilibili.com/video/BV1ConcurrentSettings';
  const snapshotResult = await sendRequest<{
    config: Record<string, unknown>;
    revision: string;
  }>({ action: 'GET_CONFIG_SNAPSHOT' }, tabId, senderUrl);
  assert.equal(snapshotResult.success, true);
  assert.ok(snapshotResult.data);
  const expectedConfig = snapshotResult.data.config;
  const expectedConfigRevision = snapshotResult.data.revision;

  const [first, second] = await Promise.all([
    sendRequest<void>({
      action: 'UPDATE_CONFIG',
      params: {
        ai: {
          baseURL: 'https://example.invalid',
          apiKey: 'fixture-first-page-key',
          chatModel: 'fixture-first-page-model',
        },
        expectedConfig,
        expectedConfigRevision,
      },
    }, tabId, senderUrl),
    sendRequest<void>({
      action: 'UPDATE_CONFIG',
      params: {
        ai: {
          baseURL: 'https://example.invalid',
          apiKey: 'fixture-second-page-key',
          chatModel: 'fixture-second-page-model',
        },
        expectedConfig,
        expectedConfigRevision,
      },
    }, tabId, senderUrl),
  ]);

  assert.equal(first.success, true);
  assert.equal(second.success, false);
  assert.equal(second.error, 'LOCAL_SETTINGS_STALE_CONFIG');
  const storedConfig = storageValues.userConfig as { ai?: { apiKey?: string } };
  assert.equal(storedConfig.ai?.apiKey, 'fixture-first-page-key');
});

test('UPDATE_CONFIG without an expected snapshot cannot write after a completed clear', async () => {
  resetChromeHarness();
  await resetTranscriptDb();
  const tabId = 18_654;
  const senderUrl = 'https://www.bilibili.com/video/BV1LegacySettings';
  const cleared = await sendRequest<{ status: string }>({
    action: 'CLEAR_ALL_LOCAL_DATA',
    params: { confirmation: '清理本地数据' },
  }, tabId, senderUrl);
  assert.equal(cleared.success, true);
  assert.equal(cleared.data?.status, 'completed');
  const revisionBefore = storageValues.userConfigRevision as { token?: string };

  const update = await sendRuntimeMessage<BiliVizResponse<void>>({
    action: 'UPDATE_CONFIG',
    params: {
      ai: {
        baseURL: 'https://example.invalid',
        apiKey: 'fixture-legacy-stale-key',
        chatModel: 'fixture-legacy-model',
      },
      assistant: { currentVideoAiAssistantEnabled: true },
    },
  }, tabId, senderUrl);

  assert.equal(update.success, false);
  assert.equal(update.error, 'LOCAL_SETTINGS_STALE_CONFIG');
  assert.equal(storageValues.userConfig, null);
  assert.equal((storageValues.userConfigRevision as { token?: string }).token, revisionBefore.token);
});

test('clear all waits for an earlier config read and prevents normalized config from returning', async () => {
  resetChromeHarness();
  await resetTranscriptDb();
  storageValues.userConfig = {
    ai: {
      baseURL: 'https://example.invalid',
      apiKey: 'fixture-read-key',
      chatModel: 'fixture-model',
    },
    assistant: { currentVideoQaAiEnabled: true },
  };
  const configReadReached = deferred<void>();
  const releaseConfigRead = deferred<void>();
  storageGetGate = {
    key: 'userConfig',
    reached: () => configReadReached.resolve(),
    release: releaseConfigRead.promise,
  };
  const laterCategoryReached = deferred<void>();
  const releaseLaterCategory = deferred<void>();
  let reachedLaterCategory = false;
  storageRemoveGate = {
    key: 'dynamicBillSyncState',
    reached: () => {
      reachedLaterCategory = true;
      laterCategoryReached.resolve();
    },
    release: releaseLaterCategory.promise,
  };

  const tabId = 18_653;
  const senderUrl = 'https://www.bilibili.com/video/BV1ConfigReadBeforeClear';
  const reading = sendRequest({ action: 'GET_CONFIG' }, tabId, senderUrl);
  await configReadReached.promise;
  const clearing = sendRequest<{ status: string }>({
    action: 'CLEAR_ALL_LOCAL_DATA',
    params: { confirmation: '清理本地数据' },
  }, tabId, senderUrl);

  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(reachedLaterCategory, false);

    storageGetGate = null;
    releaseConfigRead.resolve();
    const readResult = await reading;
    assert.equal(readResult.success, true);

    await laterCategoryReached.promise;
    releaseLaterCategory.resolve();
    const clearResult = await clearing;
    assert.equal(clearResult.success, true);
    assert.equal(clearResult.data?.status, 'completed');
    assert.equal(storageValues.userConfig, null);
  } finally {
    storageGetGate = null;
    storageRemoveGate = null;
    releaseConfigRead.resolve();
    releaseLaterCategory.resolve();
    await Promise.allSettled([reading, clearing]);
  }
});

test('rejected clear-all requests do not cancel an in-flight QA turn', async t => {
  const cases = [
    {
      name: 'invalid confirmation',
      confirmation: '删除本地数据',
      expectedError: 'LOCAL_DATA_CLEAR_CONFIRMATION_REQUIRED',
      historySyncing: false,
    },
    {
      name: 'active history sync',
      confirmation: '清理本地数据',
      expectedError: 'HISTORY_SYNC_IN_PROGRESS',
      historySyncing: true,
    },
  ] as const;

  for (const [index, currentCase] of cases.entries()) {
    await t.test(currentCase.name, async () => {
      resetChromeHarness();
      await resetTranscriptDb();
      await db.currentVideoQaSessions.clear();
      const tabId = 18_646 + index;
      const context = handlerVideoContext(`BV1QaReject0${index}`, 4_846 + index);
      const evidence = await seedHandlerTranscript(
        context,
        tabId,
        `handler-qa-rejected-clear-${index}`,
        '这一行正文用于验证未被接受的清理请求不会中断当前视频问答。',
      );
      const sourceIdentityKey = evidence.sourceRecord.sourceIdentityKey!;
      storageValues[CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY] = {
        [handlerPartKey(context)]: sourceIdentityKey,
      };
      setTabs([{ id: tabId, url: context.url, active: true, lastAccessed: 8_846 + index }]);
      await sendContentMessage({ action: 'CURRENT_VIDEO_CONTEXT_UPDATE', payload: context }, tabId, context.url);
      await confirmHandlerTranscriptCurrent(context, tabId, evidence);
      await sendRequest<void>({
        action: 'UPDATE_CONFIG',
        params: {
          ai: {
            baseURL: 'https://example.invalid',
            apiKey: 'handler-test-key',
            chatModel: 'handler-test-model',
          },
          assistant: { currentVideoAiAssistantEnabled: true },
        },
      }, tabId, context.url);
      if (currentCase.historySyncing) {
        storageValues.historySyncing = true;
        storageValues.historySyncStartedAt = Date.now();
      }

      const originalFetch = globalThis.fetch;
      let fetchCalls = 0;
      try {
        globalThis.fetch = (async () => {
          fetchCalls += 1;
          return new Response(JSON.stringify({
            choices: [{ message: { content: JSON.stringify({
              supported: true,
              answerPoints: [{ text: '未被接受的清理不会中断这次回答。', evidenceLineNumbers: [1] }],
              citations: [{ evidenceLineNumbers: [1] }],
            }) } }],
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }) as typeof fetch;
        installGuardTestHook('before_full_text_qa_session_write', async () => {
          const rejected = await sendRequest({
            action: 'CLEAR_ALL_LOCAL_DATA',
            params: { confirmation: currentCase.confirmation },
          }, tabId, context.url);
          assert.equal(rejected.success, false);
          assert.equal(rejected.error, currentCase.expectedError);
          delete storageValues.historySyncing;
          delete storageValues.historySyncStartedAt;
        });

        const sessionId = `handler-qa-rejected-clear-session-${index}`;
        const response = await sendRequest<CurrentVideoFullTextQaResult>({
          action: 'ASK_CURRENT_VIDEO_FULL_TEXT' as BiliVizRequest['action'],
          params: {
            sessionId,
            requestId: `handler-qa-rejected-clear-request-${index}`,
            turnId: `handler-qa-rejected-clear-turn-${index}`,
            question: '这次回答会继续吗？',
            primaryTextSelectionsReady: true,
            selectedSourceIdentityKey: sourceIdentityKey,
          },
        }, tabId, context.url);

        assert.equal(response.success, true);
        assert.equal(response.data?.status, 'ready');
        assert.equal(fetchCalls, 1);
        const persisted = await db.currentVideoQaSessions.where({ sessionId }).first();
        assert.equal(persisted?.turns.length, 1);
        assert.equal(persisted?.turns[0]?.status, 'ready');
      } finally {
        delete storageValues.historySyncing;
        delete storageValues.historySyncStartedAt;
        globalThis.fetch = originalFetch;
        await db.currentVideoQaSessions.clear();
      }
    });
  }
});

test('handler same-turn retry cannot be overwritten by an older preflight request', async () => {
  resetChromeHarness();
  await resetTranscriptDb();
  await db.currentVideoQaSessions.clear();
  const tabId = 18_638;
  const context = handlerVideoContext('BV1QaRetry01', 4_838);
  const evidence = await seedHandlerTranscript(
    context,
    tabId,
    'handler-qa-retry-preflight',
    '这一行正文用于验证同一问题重试后旧请求不能覆盖新回答。',
  );
  const sourceIdentityKey = evidence.sourceRecord.sourceIdentityKey!;
  storageValues[CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY] = {
    [handlerPartKey(context)]: sourceIdentityKey,
  };
  setTabs([{ id: tabId, url: context.url, active: true, lastAccessed: 8_838 }]);
  await sendContentMessage({ action: 'CURRENT_VIDEO_CONTEXT_UPDATE', payload: context }, tabId, context.url);
  await confirmHandlerTranscriptCurrent(context, tabId, evidence);
  await sendRequest<void>({
    action: 'UPDATE_CONFIG',
    params: {
      ai: {
        baseURL: 'https://example.invalid',
        apiKey: 'handler-test-key',
        chatModel: 'handler-test-model',
      },
      assistant: { currentVideoAiAssistantEnabled: true },
    },
  }, tabId, context.url);

  let releaseOld!: () => void;
  let markOldHeld!: () => void;
  const oldHeld = new Promise<void>(resolve => { markOldHeld = resolve; });
  const oldRelease = new Promise<void>(resolve => { releaseOld = resolve; });
  installGuardTestHook('before_segment_body_read', async () => {
    markOldHeld();
    await oldRelease;
  });
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  try {
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          supported: true,
          answerPoints: [{ text: '新请求生成的回答。', evidenceLineNumbers: [1] }],
          citations: [{ evidenceLineNumbers: [1] }],
        }) } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const sessionId = 'handler-qa-retry-preflight-session';
    const turnId = 'handler-qa-retry-preflight-turn';
    const oldRequest = sendRequest<CurrentVideoFullTextQaResult>({
      action: 'ASK_CURRENT_VIDEO_FULL_TEXT' as BiliVizRequest['action'],
      params: {
        sessionId,
        requestId: 'handler-qa-retry-preflight-old',
        turnId,
        question: '这个问题需要重试吗？',
        primaryTextSelectionsReady: true,
        selectedSourceIdentityKey: sourceIdentityKey,
      },
    }, tabId, context.url);
    await oldHeld;

    const retried = await sendRequest<CurrentVideoFullTextQaResult>({
      action: 'ASK_CURRENT_VIDEO_FULL_TEXT' as BiliVizRequest['action'],
      params: {
        sessionId,
        requestId: 'handler-qa-retry-preflight-new',
        turnId,
        question: '这个问题需要重试吗？',
        primaryTextSelectionsReady: true,
        selectedSourceIdentityKey: sourceIdentityKey,
      },
    }, tabId, context.url);
    assert.equal(retried.success, true);
    assert.equal(retried.data?.status, 'ready');

    releaseOld();
    const lateOld = await oldRequest;
    assert.equal(lateOld.success, true);
    assert.equal(lateOld.data?.status, 'cancelled');
    assert.equal(fetchCalls, 1);
    const persisted = await db.currentVideoQaSessions.where({ sessionId }).first();
    assert.equal(persisted?.turns.length, 1);
    assert.equal(persisted?.turns[0]?.requestId, 'handler-qa-retry-preflight-new');
    assert.equal(persisted?.turns[0]?.status, 'ready');
  } finally {
    releaseOld();
    globalThis.fetch = originalFetch;
    await db.currentVideoQaSessions.clear();
  }
});

test('handler rejects a duplicate request id without sharing lifecycle state across sessions', async () => {
  resetChromeHarness();
  await resetTranscriptDb();
  await db.currentVideoQaSessions.clear();
  const tabId = 18_639;
  const context = handlerVideoContext('BV1QaDuplicateRequest', 4_839);
  const evidence = await seedHandlerTranscript(
    context,
    tabId,
    'handler-qa-duplicate-request',
    'This complete current-video text supports the first request only.',
  );
  const sourceIdentityKey = evidence.sourceRecord.sourceIdentityKey!;
  storageValues[CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY] = {
    [handlerPartKey(context)]: sourceIdentityKey,
  };
  setTabs([{ id: tabId, url: context.url, active: true, lastAccessed: 8_839 }]);
  await sendContentMessage({ action: 'CURRENT_VIDEO_CONTEXT_UPDATE', payload: context }, tabId, context.url);
  await confirmHandlerTranscriptCurrent(context, tabId, evidence);
  await sendRequest<void>({
    action: 'UPDATE_CONFIG',
    params: {
      ai: {
        baseURL: 'https://example.invalid',
        apiKey: 'handler-test-key',
        chatModel: 'handler-test-model',
      },
      assistant: { currentVideoAiAssistantEnabled: true },
    },
  }, tabId, context.url);

  let releaseFetch!: () => void;
  let markFetchStarted!: () => void;
  const fetchStarted = new Promise<void>(resolve => { markFetchStarted = resolve; });
  const fetchRelease = new Promise<void>(resolve => { releaseFetch = resolve; });
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  try {
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      markFetchStarted();
      await fetchRelease;
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          supported: true,
          answerPoints: [{ text: '首个请求生成了有正文依据的回答。', evidenceLineNumbers: [1] }],
          citations: [{ evidenceLineNumbers: [1] }],
        }) } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const requestId = 'handler-qa-shared-request-id';
    const firstRequest = sendRequest<CurrentVideoFullTextQaResult>({
      action: 'ASK_CURRENT_VIDEO_FULL_TEXT' as BiliVizRequest['action'],
      params: {
        sessionId: 'handler-qa-duplicate-session-a',
        requestId,
        turnId: 'handler-qa-duplicate-turn-a',
        question: 'What does the first request say?',
        primaryTextSelectionsReady: true,
        selectedSourceIdentityKey: sourceIdentityKey,
      },
    }, tabId, context.url);
    await fetchStarted;

    const duplicate = await sendRequest<CurrentVideoFullTextQaResult>({
      action: 'ASK_CURRENT_VIDEO_FULL_TEXT' as BiliVizRequest['action'],
      params: {
        sessionId: 'handler-qa-duplicate-session-b',
        requestId,
        turnId: 'handler-qa-duplicate-turn-b',
        question: 'This request must be rejected independently.',
        primaryTextSelectionsReady: true,
        selectedSourceIdentityKey: sourceIdentityKey,
      },
    }, tabId, context.url);
    assert.equal(duplicate.success, true);
    assert.equal(duplicate.data?.status, 'error');
    assert.doesNotMatch(duplicate.data?.message ?? '', /request_duplicate/);
    assert.equal(fetchCalls, 1);

    releaseFetch();
    const first = await firstRequest;
    assert.equal(first.success, true);
    assert.equal(first.data?.status, 'ready');
    const persisted = await db.currentVideoQaSessions.toArray();
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]?.sessionId, 'handler-qa-duplicate-session-a');
    assert.equal(persisted[0]?.turns[0]?.requestId, requestId);
  } finally {
    releaseFetch();
    globalThis.fetch = originalFetch;
    await db.currentVideoQaSessions.clear();
  }
});

test('handler blocks an old full-text citation when a retry replaces its turn during jump revalidation', async () => {
  resetChromeHarness();
  await resetTranscriptDb();
  const tabId = 18_626;
  const context = handlerVideoContext('BV1HandlerQaRetryJump', 4826);
  const evidence = await seedHandlerTranscript(
    context,
    tabId,
    'handler-qa-retry-jump',
    '这一行正文用于验证重试替换后旧引用不能继续跳转。',
  );
  const sourceIdentityKey = evidence.sourceRecord.sourceIdentityKey!;
  storageValues[CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY] = {
    [handlerPartKey(context)]: sourceIdentityKey,
  };
  setTabs([{ id: tabId, url: context.url, active: true, lastAccessed: 8_826 }]);
  await sendContentMessage({ action: 'CURRENT_VIDEO_CONTEXT_UPDATE', payload: context }, tabId, context.url);
  await confirmHandlerTranscriptCurrent(context, tabId, evidence);
  await sendRequest<void>({
    action: 'UPDATE_CONFIG',
    params: {
      ai: {
        baseURL: 'https://example.invalid',
        apiKey: 'handler-test-key',
        chatModel: 'handler-test-model',
      },
      assistant: { currentVideoAiAssistantEnabled: true },
    },
  }, tabId, context.url);

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        supported: true,
        answerPoints: [{ text: '当前回答有正文支持。', evidenceLineNumbers: [1] }],
        citations: [{ evidenceLineNumbers: [1] }],
      }) } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    const first = await sendRequest<CurrentVideoFullTextQaResult>({
      action: 'ASK_CURRENT_VIDEO_FULL_TEXT' as BiliVizRequest['action'],
      params: {
        requestId: 'handler-qa-jump-old',
        turnId: 'handler-qa-jump-turn',
        question: '这段正文说明了什么？',
        primaryTextSelectionsReady: true,
        selectedSourceIdentityKey: sourceIdentityKey,
      },
    }, tabId, context.url);
    const citation = first.data?.citations[0];
    assert.ok(citation);

    let contentMessageCount = 0;
    setTabMessageHandler(tabId, () => {
      contentMessageCount += 1;
      return blockedTimestampJumpMock(citation.id);
    });
    installGuardTestHook('before_timestamp_message', async () => {
      const retry = await sendRequest<CurrentVideoFullTextQaResult>({
        action: 'ASK_CURRENT_VIDEO_FULL_TEXT' as BiliVizRequest['action'],
        params: {
          requestId: 'handler-qa-jump-retry',
          turnId: 'handler-qa-jump-turn',
          question: '这段正文说明了什么？',
          primaryTextSelectionsReady: true,
          selectedSourceIdentityKey: sourceIdentityKey,
        },
      }, tabId, context.url);
      assert.equal(retry.data?.status, 'ready');
    });

    const jump = await sendRequest<CurrentVideoTimestampJumpResponse>({
      action: 'REQUEST_CURRENT_VIDEO_QA_CITATION_JUMP' as BiliVizRequest['action'],
      params: {
        ...citation.binding,
        confirmed: true,
        primaryTextSelectionsReady: true,
        selectedSourceIdentityKey: sourceIdentityKey,
      },
    }, tabId, context.url);

    assert.equal(jump.success, true);
    assert.equal(jump.data?.ok, false);
    assert.match(jump.data?.message ?? '', /引用已过期/);
    assert.equal(contentMessageCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('popup full-text QA keeps the submitted source snapshot when selection changes before network', async () => {
  resetChromeHarness();
  await resetTranscriptDb();
  const tabId = 18_627;
  const context = handlerVideoContext('BV1PopupQaSourceRace', 4827);
  const evidence = await seedHandlerTranscript(
    context,
    tabId,
    'popup-qa-source-race',
    '这一行正文属于提交时已经确认的来源快照。',
  );
  const sourceIdentityKey = evidence.sourceRecord.sourceIdentityKey!;
  storageValues[CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY] = {
    [handlerPartKey(context)]: sourceIdentityKey,
  };
  setTabs([{ id: tabId, url: context.url, active: true, lastAccessed: 8_827 }]);
  await sendContentMessage({ action: 'CURRENT_VIDEO_CONTEXT_UPDATE', payload: context }, tabId, context.url);
  await confirmHandlerTranscriptCurrent(context, tabId, evidence);
  await sendRequest<void>({
    action: 'UPDATE_CONFIG',
    params: {
      ai: {
        baseURL: 'https://example.invalid',
        apiKey: 'handler-test-key',
        chatModel: 'handler-test-model',
      },
      assistant: { currentVideoAiAssistantEnabled: true },
    },
  }, tabId, context.url);

  let fetchCalls = 0;
  let sentText = '';
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (_input, init) => {
      fetchCalls += 1;
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const payload = JSON.parse(body.messages[1]!.content) as { textLines: Array<{ text: string }> };
      sentText = payload.textLines.map(line => line.text).join(' ');
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          supported: true,
          answerPoints: [{ text: '回答继续使用提交时锁定的正文。', evidenceLineNumbers: [1] }],
          citations: [{ evidenceLineNumbers: [1] }],
        }) } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    installGuardTestHook('before_full_text_qa_network', async () => {
      storageValues[CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY] = {
        [handlerPartKey(context)]: 'replacement-source-identity',
      };
    });

    const response = await sendPopupRequest<CurrentVideoFullTextQaResult>({
      action: 'ASK_CURRENT_VIDEO_FULL_TEXT' as BiliVizRequest['action'],
      params: {
        requestId: 'popup-source-race-request',
        turnId: 'popup-source-race-turn',
        question: '这段正文说明了什么？',
        primaryTextSelectionsReady: true,
        selectedSourceIdentityKey: sourceIdentityKey,
      },
    });

    assert.equal(response.success, true);
    assert.equal(response.data?.status, 'ready');
    assert.equal(response.data?.question, '这段正文说明了什么？');
    assert.equal(fetchCalls, 1);
    assert.match(sentText, /提交时已经确认的来源快照/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('UPDATE_CONFIG disables and aborts an in-flight combined generation through handleRequest', async () => {
  resetChromeHarness();
  await resetTranscriptDb();
  await db.currentVideoSummaryHighlights.clear();
  const tabId = 18_608;
  const context = handlerVideoContext('BV1ConfigDisable', 4808);
  const evidence = await seedHandlerTranscript(
    context,
    tabId,
    'config-disable-source',
    '这一行正文用于验证关闭授权会取消正在生成的摘要与亮点。',
  );
  const sourceIdentityKey = evidence.sourceRecord.identityKey;
  storageValues[CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY] = {
    [handlerPartKey(context)]: sourceIdentityKey,
  };
  setTabs([{ id: tabId, url: context.url, active: true, lastAccessed: 8_800 }]);
  await sendContentMessage({ action: 'CURRENT_VIDEO_CONTEXT_UPDATE', payload: context }, tabId, context.url);
  await confirmHandlerTranscriptCurrent(context, tabId, evidence);

  const originalFetch = globalThis.fetch;
  try {
    for (const terminal of ['resolve', 'reject'] as const) {
      await db.currentVideoSummaryHighlights.clear();
      await sendRequest<void>({
        action: 'UPDATE_CONFIG',
        params: {
          ai: {
            baseURL: 'https://example.invalid',
            apiKey: 'handler-test-key',
            chatModel: 'handler-test-model',
          },
          assistant: { currentVideoAiAssistantEnabled: true },
        },
      }, tabId, context.url);

      let resolveFetch!: (response: Response) => void;
      let rejectFetch!: (error: Error) => void;
      let markFetchStarted!: () => void;
      let outboundSignal: AbortSignal | null = null;
      const fetchStarted = new Promise<void>(resolve => { markFetchStarted = resolve; });
      const deferredFetch = new Promise<Response>((resolve, reject) => {
        resolveFetch = resolve;
        rejectFetch = reject;
      });
      globalThis.fetch = ((_input, init) => {
        outboundSignal = init?.signal as AbortSignal | null;
        markFetchStarted();
        return deferredFetch;
      }) as typeof fetch;

      const generation = sendRequest<CurrentVideoSummaryHighlightsResult>({
        action: 'GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS',
        params: {
          requestId: `handler-config-disable-${terminal}`,
          primaryTextSelectionsReady: true,
          selectedSourceIdentityKey: sourceIdentityKey,
        },
      }, tabId, context.url);
      await fetchStarted;

      await sendRequest<void>({
        action: 'UPDATE_CONFIG',
        params: { assistant: { currentVideoAiAssistantEnabled: false } },
      }, tabId, context.url);
      assert.equal(outboundSignal?.aborted, true);

      if (terminal === 'resolve') {
        resolveFetch(new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(handlerSummaryHighlightsAiOutput()) } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } }));
      } else {
        rejectFetch(new Error('late handler network rejection'));
      }
      const response = await generation;
      assert.equal(response.success, true);
      assert.equal(response.data?.status, 'cancelled');
      assert.equal(await db.currentVideoSummaryHighlights.count(), 0);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('UPDATE_CONFIG model change aborts in-flight combined generation and preserves exact-model cache', async () => {
  resetChromeHarness();
  await resetTranscriptDb();
  await db.currentVideoSummaryHighlights.clear();
  const tabId = 18_615;
  const context = handlerVideoContext('BV1ConfigModelChange', 4815);
  const evidence = await seedHandlerTranscript(
    context,
    tabId,
    'config-model-source',
    'old model output must not persist after the model changes during generation',
  );
  const sourceIdentityKey = evidence.sourceRecord.identityKey;
  storageValues[CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY] = {
    [handlerPartKey(context)]: sourceIdentityKey,
  };
  setTabs([{ id: tabId, url: context.url, active: true, lastAccessed: 8_815 }]);
  await sendContentMessage({ action: 'CURRENT_VIDEO_CONTEXT_UPDATE', payload: context }, tabId, context.url);
  await confirmHandlerTranscriptCurrent(context, tabId, evidence);
  await sendRequest<void>({
    action: 'UPDATE_CONFIG',
    params: {
      ai: {
        baseURL: 'https://example.invalid',
        apiKey: 'handler-test-key',
        chatModel: 'handler-old-model',
      },
      assistant: { currentVideoAiAssistantEnabled: true },
    },
  }, tabId, context.url);

  const originalFetch = globalThis.fetch;
  let resolveOldFetch!: (response: Response) => void;
  let markOldFetchStarted!: () => void;
  let outboundSignal: AbortSignal | null = null;
  let fetchCalls = 0;
  const oldFetchStarted = new Promise<void>(resolve => { markOldFetchStarted = resolve; });
  const deferredOldFetch = new Promise<Response>((resolve) => {
    resolveOldFetch = resolve;
  });
  try {
    globalThis.fetch = ((_input, init) => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        outboundSignal = init?.signal as AbortSignal | null;
        markOldFetchStarted();
        return deferredOldFetch;
      }
      return Promise.resolve(new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(handlerSummaryHighlightsAiOutput()) } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }) as typeof fetch;

    const oldGeneration = sendRequest<CurrentVideoSummaryHighlightsResult>({
      action: 'GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS',
      params: {
        requestId: 'handler-old-model-request',
        primaryTextSelectionsReady: true,
        selectedSourceIdentityKey: sourceIdentityKey,
      },
    }, tabId, context.url);
    await oldFetchStarted;

    await sendRequest<void>({
      action: 'UPDATE_CONFIG',
      params: {
        ai: {
          baseURL: 'https://example.invalid',
          apiKey: 'handler-test-key',
          chatModel: 'handler-new-model',
        },
        assistant: { currentVideoAiAssistantEnabled: true },
      },
    }, tabId, context.url);
    assert.equal(outboundSignal?.aborted, true);

    resolveOldFetch(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(handlerSummaryHighlightsAiOutput()) } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const oldResponse = await oldGeneration;
    assert.equal(oldResponse.success, true);
    assert.equal(oldResponse.data?.status, 'cancelled');
    assert.equal(await db.currentVideoSummaryHighlights.count(), 0);

    const newResponse = await sendRequest<CurrentVideoSummaryHighlightsResult>({
      action: 'GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS',
      params: {
        requestId: 'handler-new-model-request',
        primaryTextSelectionsReady: true,
        selectedSourceIdentityKey: sourceIdentityKey,
      },
    }, tabId, context.url);

    assert.equal(newResponse.success, true);
    assert.equal(newResponse.data?.status, 'ready');
    assert.equal(newResponse.data?.model, 'handler-new-model');
    assert.equal(fetchCalls, 2);
    const cachedRows = await db.currentVideoSummaryHighlights.toArray();
    assert.equal(cachedRows.length, 1);
    assert.equal(cachedRows[0]?.model, 'handler-new-model');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('combined generation cancellation during preflight makes zero network calls', async () => {
  resetChromeHarness();
  await resetTranscriptDb();
  await db.currentVideoSummaryHighlights.clear();
  const tabId = 18_616;
  const context = handlerVideoContext('BV1PreflightCancel', 4816);
  const evidence = await seedHandlerTranscript(
    context,
    tabId,
    'preflight-cancel-source',
    'preflight cancellation must stop before any outbound summary request',
  );
  const sourceIdentityKey = evidence.sourceRecord.identityKey;
  storageValues[CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY] = {
    [handlerPartKey(context)]: sourceIdentityKey,
  };
  setTabs([{ id: tabId, url: context.url, active: true, lastAccessed: 8_816 }]);
  await sendContentMessage({ action: 'CURRENT_VIDEO_CONTEXT_UPDATE', payload: context }, tabId, context.url);
  await confirmHandlerTranscriptCurrent(context, tabId, evidence);
  await sendRequest<void>({
    action: 'UPDATE_CONFIG',
    params: {
      ai: {
        baseURL: 'https://example.invalid',
        apiKey: 'handler-test-key',
        chatModel: 'handler-test-model',
      },
      assistant: { currentVideoAiAssistantEnabled: true },
    },
  }, tabId, context.url);

  const requestId = 'handler-preflight-cancel-request';
  installGuardTestHook('before_segment_body_read', async () => {
    await sendRequest<void>({
      action: 'CANCEL_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS',
      params: {
        requestId,
        selectedSourceIdentityKey: sourceIdentityKey,
      },
    }, tabId, context.url);
  });

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  try {
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(handlerSummaryHighlightsAiOutput()) } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const response = await sendRequest<CurrentVideoSummaryHighlightsResult>({
      action: 'GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS',
      params: {
        requestId,
        primaryTextSelectionsReady: true,
        selectedSourceIdentityKey: sourceIdentityKey,
      },
    }, tabId, context.url);

    assert.equal(response.success, true);
    assert.equal(response.data?.status, 'cancelled');
    assert.equal(fetchCalls, 0);
    assert.equal(await db.currentVideoSummaryHighlights.count(), 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('late exact cancel for an older same-source generation does not abort the newer request', async () => {
  resetChromeHarness();
  await resetTranscriptDb();
  await db.currentVideoSummaryHighlights.clear();
  const tabId = 18_619;
  const context = handlerVideoContext('BV1LateExactCancel', 4819);
  const evidence = await seedHandlerTranscript(
    context,
    tabId,
    'late-exact-cancel-source',
    'newer same-source generation must survive an older exact cancel',
  );
  const sourceIdentityKey = evidence.sourceRecord.identityKey;
  storageValues[CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY] = {
    [handlerPartKey(context)]: sourceIdentityKey,
  };
  setTabs([{ id: tabId, url: context.url, active: true, lastAccessed: 8_819 }]);
  await sendContentMessage({ action: 'CURRENT_VIDEO_CONTEXT_UPDATE', payload: context }, tabId, context.url);
  await confirmHandlerTranscriptCurrent(context, tabId, evidence);
  await sendRequest<void>({
    action: 'UPDATE_CONFIG',
    params: {
      ai: {
        baseURL: 'https://example.invalid',
        apiKey: 'handler-test-key',
        chatModel: 'handler-test-model',
      },
      assistant: { currentVideoAiAssistantEnabled: true },
    },
  }, tabId, context.url);

  const originalFetch = globalThis.fetch;
  const fetchRecords: Array<{
    signal: AbortSignal | null;
    resolve: (response: Response) => void;
    reject: (error: Error) => void;
  }> = [];
  const fetchWaiters: Array<{ count: number; resolve: () => void }> = [];
  const waitForFetchCount = async (count: number): Promise<void> => {
    if (fetchRecords.length >= count) return;
    await new Promise<void>(resolve => fetchWaiters.push({ count, resolve }));
  };
  const notifyFetchWaiters = () => {
    for (const waiter of [...fetchWaiters]) {
      if (fetchRecords.length < waiter.count) continue;
      fetchWaiters.splice(fetchWaiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  };
  const response = () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(handlerSummaryHighlightsAiOutput()) } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  try {
    globalThis.fetch = ((_input, init) => {
      const signal = init?.signal ?? null;
      let resolveFetch!: (value: Response) => void;
      let rejectFetch!: (error: Error) => void;
      const promise = new Promise<Response>((resolve, reject) => {
        resolveFetch = resolve;
        rejectFetch = reject;
      });
      fetchRecords.push({
        signal,
        resolve: resolveFetch,
        reject: rejectFetch,
      });
      if (signal?.aborted) {
        rejectFetch(new Error('MOCK_FETCH_ABORTED'));
      } else {
        signal?.addEventListener('abort', () => rejectFetch(new Error('MOCK_FETCH_ABORTED')), { once: true });
      }
      notifyFetchWaiters();
      return promise;
    }) as typeof fetch;

    const firstGeneration = sendRequest<CurrentVideoSummaryHighlightsResult>({
      action: 'GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS',
      params: {
        requestId: 'handler-late-exact-cancel-a1',
        primaryTextSelectionsReady: true,
        selectedSourceIdentityKey: sourceIdentityKey,
      },
    }, tabId, context.url);
    await waitForFetchCount(1);

    const secondGeneration = sendRequest<CurrentVideoSummaryHighlightsResult>({
      action: 'GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS',
      params: {
        requestId: 'handler-late-exact-cancel-a2',
        primaryTextSelectionsReady: true,
        selectedSourceIdentityKey: sourceIdentityKey,
      },
    }, tabId, context.url);
    await waitForFetchCount(2);

    assert.equal(fetchRecords[0]?.signal?.aborted, true);
    await sendRequest<void>({
      action: 'CANCEL_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS',
      params: {
        requestId: 'handler-late-exact-cancel-a1',
        selectedSourceIdentityKey: sourceIdentityKey,
      },
    }, tabId, context.url);
    assert.equal(fetchRecords[1]?.signal?.aborted, false);

    fetchRecords[1]?.resolve(response());
    const secondResponse = await secondGeneration;
    const firstResponse = await firstGeneration;

    assert.equal(firstResponse.success, true);
    assert.equal(firstResponse.data?.status, 'cancelled');
    assert.equal(secondResponse.success, true);
    assert.equal(secondResponse.data?.status, 'ready');
    assert.equal(secondResponse.data?.requestId, 'handler-late-exact-cancel-a2');
    const cachedRows = await db.currentVideoSummaryHighlights.toArray();
    assert.equal(cachedRows.length, 1);
    assert.equal(cachedRows[0]?.requestAudit.requestId, 'handler-late-exact-cancel-a2');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('combined generation disable during preflight makes zero network calls', async () => {
  resetChromeHarness();
  await resetTranscriptDb();
  await db.currentVideoSummaryHighlights.clear();
  const tabId = 18_617;
  const context = handlerVideoContext('BV1PreflightDisable', 4817);
  const evidence = await seedHandlerTranscript(
    context,
    tabId,
    'preflight-disable-source',
    'preflight disable must stop before any outbound summary request',
  );
  const sourceIdentityKey = evidence.sourceRecord.identityKey;
  storageValues[CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY] = {
    [handlerPartKey(context)]: sourceIdentityKey,
  };
  setTabs([{ id: tabId, url: context.url, active: true, lastAccessed: 8_817 }]);
  await sendContentMessage({ action: 'CURRENT_VIDEO_CONTEXT_UPDATE', payload: context }, tabId, context.url);
  await confirmHandlerTranscriptCurrent(context, tabId, evidence);
  await sendRequest<void>({
    action: 'UPDATE_CONFIG',
    params: {
      ai: {
        baseURL: 'https://example.invalid',
        apiKey: 'handler-test-key',
        chatModel: 'handler-test-model',
      },
      assistant: { currentVideoAiAssistantEnabled: true },
    },
  }, tabId, context.url);

  installGuardTestHook('before_segment_body_read', async () => {
    await sendRequest<void>({
      action: 'UPDATE_CONFIG',
      params: { assistant: { currentVideoAiAssistantEnabled: false } },
    }, tabId, context.url);
  });

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  try {
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(handlerSummaryHighlightsAiOutput()) } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const response = await sendRequest<CurrentVideoSummaryHighlightsResult>({
      action: 'GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS',
      params: {
        requestId: 'handler-preflight-disable-request',
        primaryTextSelectionsReady: true,
        selectedSourceIdentityKey: sourceIdentityKey,
      },
    }, tabId, context.url);

    assert.equal(response.success, true);
    assert.equal(response.data?.ai.status, 'disabled');
    assert.equal(response.data?.canGenerate, false);
    assert.equal(fetchCalls, 0);
    assert.equal(await db.currentVideoSummaryHighlights.count(), 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('combined generation rejects a late result after subtitle cache clear and does not repopulate cache', async () => {
  resetChromeHarness();
  await resetTranscriptDb();
  await db.currentVideoSummaryHighlights.clear();
  const tabId = 18_618;
  const context = handlerVideoContext('BV1LateClear', 4818);
  const evidence = await seedHandlerTranscript(
    context,
    tabId,
    'late-clear-source',
    'late subtitle cache clear must prevent derived summary cache repopulation',
  );
  const sourceIdentityKey = evidence.sourceRecord.identityKey;
  storageValues[CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY] = {
    [handlerPartKey(context)]: sourceIdentityKey,
  };
  setTabs([{ id: tabId, url: context.url, active: true, lastAccessed: 8_818 }]);
  await sendContentMessage({ action: 'CURRENT_VIDEO_CONTEXT_UPDATE', payload: context }, tabId, context.url);
  await confirmHandlerTranscriptCurrent(context, tabId, evidence);
  await sendRequest<void>({
    action: 'UPDATE_CONFIG',
    params: {
      ai: {
        baseURL: 'https://example.invalid',
        apiKey: 'handler-test-key',
        chatModel: 'handler-test-model',
      },
      assistant: { currentVideoAiAssistantEnabled: true },
    },
  }, tabId, context.url);

  const originalFetch = globalThis.fetch;
  let resolveFetch!: (response: Response) => void;
  let markFetchStarted!: () => void;
  const fetchStarted = new Promise<void>(resolve => { markFetchStarted = resolve; });
  const deferredFetch = new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  });
  try {
    globalThis.fetch = ((_input, _init) => {
      markFetchStarted();
      return deferredFetch;
    }) as typeof fetch;

    const generation = sendRequest<CurrentVideoSummaryHighlightsResult>({
      action: 'GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS',
      params: {
        requestId: 'handler-late-clear-request',
        primaryTextSelectionsReady: true,
        selectedSourceIdentityKey: sourceIdentityKey,
      },
    }, tabId, context.url);
    await fetchStarted;

    await sendRequest({
      action: 'CLEAR_CURRENT_VIDEO_SUBTITLE_CACHE',
      params: {},
    }, tabId, context.url);
    resolveFetch(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(handlerSummaryHighlightsAiOutput()) } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const response = await generation;
    assert.equal(response.success, true);
    assert.equal(response.data?.status, 'cancelled');
    assert.equal(await db.currentVideoTranscriptSegments.count(), 0);
    assert.equal(await db.currentVideoSummaryHighlights.count(), 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('background keeps an exact missing saved V1 selection inactive without touching active V2', async () => {
  resetChromeHarness();
  await resetTranscriptDb();

  const tabId = 18_606;
  const context = handlerVideoContext('BV1MissingV19', 4601, 1);
  const evidenceV2 = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 14, to: 19, content: 'persistent active V2 must not replace the missing saved V1 source' }] },
    {
      bvid: context.bvid,
      cid: context.cid as number,
      page: context.currentPart.page,
      language: 'zh-CN',
      sourceType: 'bilibili_player_wbi_v2',
      trackId: 'missing-v1-active-v2',
      trackUrlHost: 'aisubtitle.hdslb.com',
      fetchedAt: 11_400,
    },
  );
  await upsertCurrentVideoTranscriptEvidence(evidenceV2);
  await db.currentVideoTranscriptSources
    .where('identityKey')
    .equals(evidenceV2.sourceRecord.identityKey)
    .modify({ lastAccessedAt: 1_000 });
  const sourceBefore = await transcriptSource(evidenceV2.sourceRecord.identityKey);
  const missingV1Key = `primary-text:bilibili_subtitle:${context.bvid}:${context.cid}:1:zh-cn:saved-v1-missing`;

  setTabs([{ id: tabId, url: context.url, active: true, lastAccessed: 5_000 }]);
  await sendContentMessage({
    action: 'CURRENT_VIDEO_CONTEXT_UPDATE',
    payload: context,
  }, tabId, context.url);

  const selectedParams = {
    primaryTextSelectionsReady: true,
    selectedSourceIdentityKey: missingV1Key,
  };
  const knowledge = await sendRequest<VideoKnowledgeResult>({
    action: 'GET_VIDEO_KNOWLEDGE',
    params: selectedParams,
  }, tabId, context.url);
  const search = await sendRequest<CurrentVideoSegmentRetrievalResult>({
    action: 'SEARCH_CURRENT_VIDEO_SEGMENTS',
    params: {
      ...selectedParams,
      query: 'persistent active V2 must not replace',
    },
  }, tabId, context.url);
  const jump = await sendRequest<CurrentVideoTimestampJumpResponse>({
    action: 'REQUEST_CURRENT_VIDEO_SEGMENT_JUMP',
    params: {
      ...selectedParams,
      candidateId: 'missing-v1-candidate',
      query: 'persistent active V2 must not replace',
      confirmed: true,
    },
  }, tabId, context.url);

  assert.equal(knowledge.data?.sourceState.transcriptEvidence, false);
  assert.equal(knowledge.data?.nodes.some(node => node.source === 'transcript'), false);
  assert.equal(search.data?.status, 'no_evidence');
  assert.equal(search.data?.candidates.length, 0);
  assert.equal(search.data?.evidenceState.transcriptSegmentCount, 0);
  assert.notEqual(search.data?.aiRerank.status, 'generated');
  assert.notEqual(search.data?.qa.aiState.status, 'generated');
  assert.equal(jump.data?.ok, false);
  assert.equal(jump.data?.targetSeconds, null);

  const sourceAfter = await transcriptSource(evidenceV2.sourceRecord.identityKey);
  assert.equal(sourceAfter?.lastAccessedAt, sourceBefore?.lastAccessedAt);
});

test('background does not authorize active V2 when readiness is true without an exact source key', async () => {
  resetChromeHarness();
  await resetTranscriptDb();

  const tabId = 18_607;
  const context = handlerVideoContext('BV1NoExactKey9', 4701, 1);
  const evidenceV2 = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 20, to: 25, content: 'persistent V2 requires an exact primary text identity' }] },
    {
      bvid: context.bvid,
      cid: context.cid as number,
      page: context.currentPart.page,
      language: 'zh-CN',
      sourceType: 'bilibili_player_wbi_v2',
      trackId: 'no-exact-key-v2',
      trackUrlHost: 'aisubtitle.hdslb.com',
      fetchedAt: 11_500,
    },
  );
  await upsertCurrentVideoTranscriptEvidence(evidenceV2);
  await db.currentVideoTranscriptSources
    .where('identityKey')
    .equals(evidenceV2.sourceRecord.identityKey)
    .modify({ lastAccessedAt: 1_000 });
  const sourceBefore = await transcriptSource(evidenceV2.sourceRecord.identityKey);

  setTabs([{ id: tabId, url: context.url, active: true, lastAccessed: 6_000 }]);
  await sendContentMessage({
    action: 'CURRENT_VIDEO_CONTEXT_UPDATE',
    payload: context,
  }, tabId, context.url);

  const readyWithoutSource = { primaryTextSelectionsReady: true };
  const knowledge = await sendRequest<VideoKnowledgeResult>({
    action: 'GET_VIDEO_KNOWLEDGE',
    params: readyWithoutSource,
  }, tabId, context.url);
  const search = await sendRequest<CurrentVideoSegmentRetrievalResult>({
    action: 'SEARCH_CURRENT_VIDEO_SEGMENTS',
    params: {
      ...readyWithoutSource,
      query: 'persistent V2 requires an exact primary text identity',
    },
  }, tabId, context.url);
  const jump = await sendRequest<CurrentVideoTimestampJumpResponse>({
    action: 'REQUEST_CURRENT_VIDEO_SEGMENT_JUMP',
    params: {
      ...readyWithoutSource,
      candidateId: 'no-exact-key-candidate',
      query: 'persistent V2 requires an exact primary text identity',
      confirmed: true,
    },
  }, tabId, context.url);

  assert.equal(knowledge.data?.sourceState.transcriptEvidence, false);
  assert.equal(knowledge.data?.nodes.some(node => node.source === 'transcript'), false);
  assert.equal(search.data?.status, 'no_evidence');
  assert.equal(search.data?.candidates.length, 0);
  assert.equal(search.data?.evidenceState.transcriptSegmentCount, 0);
  assert.equal(jump.data?.ok, false);
  assert.equal(jump.data?.targetSeconds, null);

  const sourceAfter = await transcriptSource(evidenceV2.sourceRecord.identityKey);
  assert.equal(sourceAfter?.lastAccessedAt, sourceBefore?.lastAccessedAt);
});

test('protected handlers re-read persisted primary text authorization before touching exact transcript body', async () => {
  await runHandlerCase('saved replacement', async () => {
    resetChromeHarness();
    await resetTranscriptDb();
    const tabId = 18_609;
    const context = handlerVideoContext('BV1FreshSelectionA', 4901);
    const evidence = await seedHandlerTranscript(
      context,
      tabId,
      'fresh-selection-a',
      'fresh selection replacement must block this exact body',
    );
    storageValues[CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY] = {
      [`${context.bvid}:${context.cid}:1`]: 'replacement-source-key',
    };
    setTabs([{ id: tabId, url: context.url, active: true, lastAccessed: 9_000 }]);
    await sendContentMessage({ action: 'CURRENT_VIDEO_CONTEXT_UPDATE', payload: context }, tabId, context.url);
    await confirmHandlerTranscriptCurrent(context, tabId, evidence);
    await db.currentVideoTranscriptSources
      .where('identityKey')
      .equals(evidence.sourceRecord.identityKey)
      .modify({ lastAccessedAt: 1_000 });
    const sourceBefore = await transcriptSource(evidence.sourceRecord.identityKey);

    const response = await searchWithExactSource(
      tabId,
      context,
      evidence.sourceRecord.sourceIdentityKey,
      'fresh selection replacement',
    );
    const selectedParams = {
      primaryTextSelectionsReady: true,
      selectedSourceIdentityKey: evidence.sourceRecord.sourceIdentityKey,
    };
    const knowledge = await sendRequest<VideoKnowledgeResult>({
      action: 'GET_VIDEO_KNOWLEDGE',
      params: selectedParams,
    }, tabId, context.url);
    const jump = await sendRequest<CurrentVideoTimestampJumpResponse>({
      action: 'REQUEST_CURRENT_VIDEO_SEGMENT_JUMP',
      params: {
        ...selectedParams,
        candidateId: 'fresh-selection-replaced-candidate',
        query: 'fresh selection replacement',
        confirmed: true,
      },
    }, tabId, context.url);

    assert.equal(response.data?.status, 'no_evidence');
    assert.equal(response.data?.candidates.length, 0);
    assert.equal(knowledge.data?.nodes.length, 0);
    assert.equal(knowledge.data?.sourceState.transcriptEvidence, false);
    assert.equal(jump.data?.ok, false);
    assert.equal(jump.data?.targetSeconds, null);
    assert.ok(storageReadCount(CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY) >= 3);
    const sourceAfter = await transcriptSource(evidence.sourceRecord.identityKey);
    assert.equal(sourceAfter?.lastAccessedAt, sourceBefore?.lastAccessedAt);
  });

  await runHandlerCase('selection storage read rejection', async () => {
    resetChromeHarness();
    await resetTranscriptDb();
    const tabId = 18_610;
    const context = handlerVideoContext('BV1FreshSelectionB', 4902);
    const evidence = await seedHandlerTranscript(
      context,
      tabId,
      'fresh-selection-b',
      'rejected selection storage must not expose this body',
    );
    rejectPrimaryTextSelectionStorageReads = true;
    setTabs([{ id: tabId, url: context.url, active: true, lastAccessed: 9_100 }]);
    await sendContentMessage({ action: 'CURRENT_VIDEO_CONTEXT_UPDATE', payload: context }, tabId, context.url);
    await confirmHandlerTranscriptCurrent(context, tabId, evidence);
    await db.currentVideoTranscriptSources
      .where('identityKey')
      .equals(evidence.sourceRecord.identityKey)
      .modify({ lastAccessedAt: 1_000 });
    const sourceBefore = await transcriptSource(evidence.sourceRecord.identityKey);

    const response = await searchWithExactSource(
      tabId,
      context,
      evidence.sourceRecord.sourceIdentityKey,
      'rejected selection storage',
    );

    assert.equal(response.data?.status, 'no_evidence');
    assert.equal(response.data?.candidates.length, 0);
    assert.ok(storageReadCount(CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY) >= 1);
    const sourceAfter = await transcriptSource(evidence.sourceRecord.identityKey);
    assert.equal(sourceAfter?.lastAccessedAt, sourceBefore?.lastAccessedAt);
  });

  await runHandlerCase('unique current source', async () => {
    resetChromeHarness();
    await resetTranscriptDb();
    const tabId = 18_611;
    const context = handlerVideoContext('BV1FreshSelectionC', 4903);
    const evidence = await seedHandlerTranscript(
      context,
      tabId,
      'fresh-selection-c',
      'unique current exact source remains available without a saved choice',
    );
    setTabs([{ id: tabId, url: context.url, active: true, lastAccessed: 9_200 }]);
    await sendContentMessage({ action: 'CURRENT_VIDEO_CONTEXT_UPDATE', payload: context }, tabId, context.url);
    await confirmHandlerTranscriptCurrent(context, tabId, evidence);
    const currentOwner = retainTemporaryTranscriptOwnerForContextSnapshot(context, tabId);
    assert.ok(currentOwner);
    assert.deepEqual(getCurrentVideoCurrentOwnerTranscriptSourceIdentityKeys({
      bvid: context.bvid,
      cid: context.cid as number,
      page: context.currentPart.page,
    }, currentOwner), [evidence.sourceRecord.sourceIdentityKey]);
    const observedPhases: GuardTestPhase[] = [];
    (globalThis as typeof globalThis & {
      __biliBillCurrentVideoPrimaryTextGuardTestHook__?: (phase: GuardTestPhase) => Promise<void>;
    }).__biliBillCurrentVideoPrimaryTextGuardTestHook__ = async (phase) => {
      observedPhases.push(phase);
    };

    const response = await searchWithExactSource(
      tabId,
      context,
      evidence.sourceRecord.sourceIdentityKey,
      'unique current exact source',
    );

    assert.deepEqual(observedPhases, [
      'before_active_source_check',
      'before_evidence_bind',
      'before_segment_body_read',
      'after_segment_body_read',
    ]);
    assert.equal(response.data?.status, 'ready');
    assert.ok((response.data?.candidates.length ?? 0) > 0);
    assert.ok(storageReadCount(CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY) >= 1);
  });

  await runHandlerCase('old source key', async () => {
    resetChromeHarness();
    await resetTranscriptDb();
    const tabId = 18_612;
    const context = handlerVideoContext('BV1FreshSelectionD', 4904);
    const evidence = await seedHandlerTranscript(
      context,
      tabId,
      'fresh-selection-d',
      'only the current exact source is eligible without a saved choice',
    );
    setTabs([{ id: tabId, url: context.url, active: true, lastAccessed: 9_300 }]);
    await sendContentMessage({ action: 'CURRENT_VIDEO_CONTEXT_UPDATE', payload: context }, tabId, context.url);
    await confirmHandlerTranscriptCurrent(context, tabId, evidence);

    const response = await searchWithExactSource(
      tabId,
      context,
      `${evidence.sourceRecord.sourceIdentityKey}-old`,
      'only the current exact source',
    );

    assert.equal(response.data?.status, 'no_evidence');
    assert.equal(response.data?.candidates.length, 0);
    assert.ok(storageReadCount(CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY) >= 1);
  });

  await runHandlerCase('saved current source among cached sources', async () => {
    resetChromeHarness();
    await resetTranscriptDb();
    const tabId = 18_613;
    const context = handlerVideoContext('BV1FreshSelectionE', 4905);
    const chinese = await seedHandlerTranscript(
      context,
      tabId,
      'fresh-selection-e-zh',
      '中文旧来源不能在当前来源不明确时继续授权',
      'zh-CN',
    );
    const english = await seedHandlerTranscript(
      context,
      tabId,
      'fresh-selection-e-en',
      'an alternate language source is also active in persistent metadata',
      'en-US',
    );
    const currentOwner = retainTemporaryTranscriptOwnerForContextSnapshot(context, tabId);
    assert.ok(currentOwner);
    await upsertCurrentVideoTranscriptEvidence(chinese, { temporaryOwner: currentOwner });
    storageValues[CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY] = {
      [`${context.bvid}:${context.cid}:1`]: chinese.sourceRecord.sourceIdentityKey,
    };
    setTabs([{ id: tabId, url: context.url, active: true, lastAccessed: 9_400 }]);
    await sendContentMessage({ action: 'CURRENT_VIDEO_CONTEXT_UPDATE', payload: context }, tabId, context.url);
    await confirmHandlerTranscriptCurrent(context, tabId, chinese);

    const response = await searchWithExactSource(
      tabId,
      context,
      chinese.sourceRecord.sourceIdentityKey,
      '中文旧来源',
    );

    assert.equal(response.data?.status, 'ready');
    assert.ok((response.data?.candidates.length ?? 0) > 0);
    assert.ok(storageReadCount(CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY) >= 1);

    await db.currentVideoTranscriptSources
      .where('identityKey')
      .equals(english.sourceRecord.identityKey)
      .modify({ lastAccessedAt: 2_000 });
    const mismatch = await searchWithExactSource(
      tabId,
      context,
      english.sourceRecord.sourceIdentityKey,
      'alternate language source',
    );
    assert.equal(mismatch.data?.status, 'no_evidence');
    assert.equal(mismatch.data?.candidates.length, 0);
    assert.equal((await transcriptSource(english.sourceRecord.identityKey))?.lastAccessedAt, 2_000);
  });

  await runHandlerCase('non-current cached source', async () => {
    resetChromeHarness();
    await resetTranscriptDb();
    const tabId = 18_614;
    const context = handlerVideoContext('BV1FreshSelectionF', 4906);
    const chinese = await seedHandlerTranscript(
      context,
      tabId,
      'fresh-selection-f-zh',
      '无保存选择时多来源必须保持阻断',
      'zh-CN',
    );
    const english = await seedHandlerTranscript(
      context,
      tabId,
      'fresh-selection-f-en',
      'multiple active sources need an explicit saved choice',
      'en-US',
    );
    setTabs([{ id: tabId, url: context.url, active: true, lastAccessed: 9_500 }]);
    await sendContentMessage({ action: 'CURRENT_VIDEO_CONTEXT_UPDATE', payload: context }, tabId, context.url);
    await confirmHandlerTranscriptCurrent(context, tabId, english);
    await db.currentVideoTranscriptSources
      .where('identityKey')
      .equals(chinese.sourceRecord.identityKey)
      .modify({ lastAccessedAt: 1_000 });
    await db.currentVideoTranscriptSources
      .where('identityKey')
      .equals(english.sourceRecord.identityKey)
      .modify({ lastAccessedAt: 2_000 });

    const response = await searchWithExactSource(
      tabId,
      context,
      chinese.sourceRecord.sourceIdentityKey,
      '无保存选择时多来源',
    );

    assert.equal(response.data?.status, 'no_evidence');
    assert.equal(response.data?.candidates.length, 0);
    assert.equal((await transcriptSource(chinese.sourceRecord.identityKey))?.lastAccessedAt, 1_000);
    assert.equal((await transcriptSource(english.sourceRecord.identityKey))?.lastAccessedAt, 2_000);
  });

  await runHandlerCase('saved stale source', async () => {
    resetChromeHarness();
    await resetTranscriptDb();
    const tabId = 18_615;
    const context = handlerVideoContext('BV1FreshSelectionG', 4907);
    const stale = await seedHandlerTranscript(
      context,
      tabId,
      'fresh-selection-g-stale',
      'stale exact source must remain unavailable',
    );
    storageValues[CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY] = {
      [`${context.bvid}:${context.cid}:1`]: stale.sourceRecord.sourceIdentityKey,
    };
    setTabs([{ id: tabId, url: context.url, active: true, lastAccessed: 9_600 }]);
    await sendContentMessage({ action: 'CURRENT_VIDEO_CONTEXT_UPDATE', payload: context }, tabId, context.url);
    await confirmHandlerTranscriptCurrent(context, tabId, stale);
    await db.currentVideoTranscriptSources
      .where('identityKey')
      .equals(stale.sourceRecord.identityKey)
      .modify({ stale: true, lastAccessedAt: 1_000 });

    const response = await searchWithExactSource(
      tabId,
      context,
      stale.sourceRecord.sourceIdentityKey,
      'stale exact source',
    );

    assert.equal(response.data?.status, 'no_evidence');
    assert.equal(response.data?.candidates.length, 0);
    assert.equal((await transcriptSource(stale.sourceRecord.identityKey))?.lastAccessedAt, 1_000);
  });
});

test('protected actions require current-source confirmation after service-worker owner state resets', async () => {
  resetChromeHarness();
  await resetTranscriptDb();
  const tabId = 18_619;
  const context = handlerVideoContext('BV1WorkerRestart', 4999);
  const evidence = await seedHandlerTranscript(
    context,
    tabId,
    'worker-restart-source',
    'persisted old text must not become current again after service worker restart',
  );
  const sourceIdentityKey = evidence.sourceRecord.sourceIdentityKey;
  assert.ok(sourceIdentityKey);
  storageValues[CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY] = {
    [handlerPartKey(context)]: sourceIdentityKey,
  };
  setTabs([{ id: tabId, url: context.url, active: true, lastAccessed: 9_900 }]);
  await sendContentMessage({ action: 'CURRENT_VIDEO_CONTEXT_UPDATE', payload: context }, tabId, context.url);
  await confirmHandlerTranscriptCurrent(context, tabId, evidence);

  const beforeRestart = await searchWithExactSource(
    tabId,
    context,
    sourceIdentityKey,
    'persisted old text',
  );
  assert.equal(beforeRestart.data?.status, 'ready');

  clearTemporaryCurrentVideoTranscriptCache();
  const contentMessages: unknown[] = [];
  setTabMessageHandler(tabId, (message) => {
    contentMessages.push(message);
    return { ok: true };
  });

  const contextAfterRestart = await sendRequest<CurrentVideoContext>({
    action: 'GET_CURRENT_VIDEO_CONTEXT',
    params: {},
  }, tabId, context.url);
  assert.equal(contextAfterRestart.success, true);
  assert.equal(contextAfterRestart.data?.kind, 'video');
  assert.equal(
    contextAfterRestart.data?.kind === 'video'
      ? contextAfterRestart.data.transcriptEvidence?.active
      : null,
    false,
  );
  assert.equal(
    contextAfterRestart.data?.kind === 'video'
      ? contextAfterRestart.data.transcriptEvidence?.segmentCount
      : null,
    0,
  );
  assert.match(
    contextAfterRestart.data?.kind === 'video'
      ? contextAfterRestart.data.transcriptEvidence?.message ?? ''
      : '',
    /重新检测字幕/,
  );

  for (const action of ['knowledge', 'search', 'jump'] as const) {
    const response = await invokeProtectedHandlerAction(action, tabId, context, sourceIdentityKey);
    assertProtectedActionBlocked(action, response);
  }
  const returned = await sendRequest<CurrentVideoTimestampReturnResponse>({
    action: 'RETURN_CURRENT_VIDEO_SEGMENT_JUMP',
    params: {
      primaryTextSelectionsReady: true,
      selectedSourceIdentityKey: sourceIdentityKey,
    },
  }, tabId, context.url);
  assert.equal(returned.success, true);
  assert.equal(returned.data?.ok, false);
  assert.equal(contentMessages.length, 0);

  const currentOwner = retainTemporaryTranscriptOwnerForContextSnapshot(context, tabId);
  assert.ok(currentOwner);
  await upsertCurrentVideoTranscriptEvidence(evidence, { temporaryOwner: currentOwner });
  const afterRedetection = await searchWithExactSource(
    tabId,
    context,
    sourceIdentityKey,
    'persisted old text',
  );
  assert.equal(afterRedetection.data?.status, 'ready');
});

test('protected handlers drop in-flight work when the exact source changes before evidence binding', async () => {
  const actions = ['knowledge', 'search', 'jump'] as const;
  for (const [index, action] of actions.entries()) {
    resetChromeHarness();
    await resetTranscriptDb();
    const tabId = 18_620 + index;
    const context = handlerVideoContext(`BV1GuardEvidence${index}`, 5001 + index);
    const evidence = await seedHandlerTranscript(
      context,
      tabId,
      `guard-evidence-${index}`,
      `guard evidence ${action} body must not be consumed after source replacement`,
    );
    storageValues[CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY] = {
      [handlerPartKey(context)]: evidence.sourceRecord.sourceIdentityKey,
    };
    setTabs([{ id: tabId, url: context.url, active: true, lastAccessed: 10_000 + index }]);
    await sendContentMessage({ action: 'CURRENT_VIDEO_CONTEXT_UPDATE', payload: context }, tabId, context.url);
    await confirmHandlerTranscriptCurrent(context, tabId, evidence);
    await db.currentVideoTranscriptSources
      .where('identityKey')
      .equals(evidence.sourceRecord.identityKey)
      .modify({ lastAccessedAt: 1_000 });
    const sourceBefore = await transcriptSource(evidence.sourceRecord.identityKey);

    const seekMessages: unknown[] = [];
    setTabMessageHandler(tabId, (message) => {
      seekMessages.push(message);
      return {
        ok: true,
        message: 'mock seek should not run',
        candidateId: 'guard-candidate',
        targetSeconds: 2,
        targetTimeLabel: '0:02',
        returnPointSeconds: 1,
        sourceLabel: 'mock',
        confidence: 0.8,
      };
    });
    installGuardTestHook('before_evidence_bind', async () => {
      await sendRequest<SaveCurrentVideoPrimaryTextSelectionResult>({
        action: 'SAVE_CURRENT_VIDEO_PRIMARY_TEXT_SELECTION',
        params: {
          bvid: context.bvid,
          cid: context.cid,
          page: context.currentPart.page,
          selectedSourceIdentityKey: `${evidence.sourceRecord.sourceIdentityKey}:replacement`,
        },
      }, tabId, context.url);
    });

    const response = await invokeProtectedHandlerAction(action, tabId, context, evidence.sourceRecord.sourceIdentityKey);

    assertProtectedActionBlocked(action, response);
    assert.equal(seekMessages.length, 0);
    const sourceAfter = await transcriptSource(evidence.sourceRecord.identityKey);
    assert.equal(sourceAfter?.lastAccessedAt, sourceBefore?.lastAccessedAt);
  }
});

test('protected search fails closed when source changes during active-source and segment stages', async () => {
  for (const phase of ['before_active_source_check', 'before_segment_body_read'] as const) {
    resetChromeHarness();
    await resetTranscriptDb();
    const tabId = phase === 'before_active_source_check' ? 18_630 : 18_631;
    const context = handlerVideoContext(`BV1GuardPhase${tabId}`, 5100 + tabId);
    const evidence = await seedHandlerTranscript(
      context,
      tabId,
      `guard-phase-${phase}`,
      `guard phase ${phase} body must not produce a candidate`,
    );
    storageValues[CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY] = {
      [handlerPartKey(context)]: evidence.sourceRecord.sourceIdentityKey,
    };
    setTabs([{ id: tabId, url: context.url, active: true, lastAccessed: 11_000 }]);
    await sendContentMessage({ action: 'CURRENT_VIDEO_CONTEXT_UPDATE', payload: context }, tabId, context.url);
    await confirmHandlerTranscriptCurrent(context, tabId, evidence);
    installGuardTestHook(phase, async () => {
      await sendRequest<SaveCurrentVideoPrimaryTextSelectionResult>({
        action: 'SAVE_CURRENT_VIDEO_PRIMARY_TEXT_SELECTION',
        params: {
          bvid: context.bvid,
          cid: context.cid,
          page: context.currentPart.page,
          selectedSourceIdentityKey: `${evidence.sourceRecord.sourceIdentityKey}:replacement`,
        },
      }, tabId, context.url);
    });

    const search = await searchWithExactSource(
      tabId,
      context,
      evidence.sourceRecord.sourceIdentityKey,
      `guard phase ${phase}`,
    );

    assert.equal(search.success, true);
    assert.equal(search.data?.status, 'no_evidence');
    assert.equal(search.data?.candidates.length, 0);
    assert.equal(search.data?.evidenceState.transcriptSegmentCount, 0);
    assert.equal(search.data?.aiRerank.status, 'not_requested');
    assert.equal(search.data?.qa.aiState.status, 'not_requested');
  }
});

test('protected handlers block after transcript cache is cleared between binding and segment read', async () => {
  resetChromeHarness();
  await resetTranscriptDb();
  const tabId = 18_632;
  const context = handlerVideoContext('BV1GuardClear', 5201);
  const evidence = await seedHandlerTranscript(
    context,
    tabId,
    'guard-clear',
    'guard clear body must not fall back to description summary',
  );
  storageValues[CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY] = {
    [handlerPartKey(context)]: evidence.sourceRecord.sourceIdentityKey,
  };
  setTabs([{ id: tabId, url: context.url, active: true, lastAccessed: 12_000 }]);
  await sendContentMessage({ action: 'CURRENT_VIDEO_CONTEXT_UPDATE', payload: context }, tabId, context.url);
  await confirmHandlerTranscriptCurrent(context, tabId, evidence);
  await sendRequest<void>({
    action: 'UPDATE_CONFIG',
    params: {
      ai: {
        baseURL: 'https://example.invalid',
        apiKey: 'handler-test-key',
        chatModel: 'handler-test-model',
      },
      assistant: { currentVideoAiAssistantEnabled: true },
    },
  }, tabId, context.url);
  installGuardTestHook('before_segment_body_read', async () => {
    await sendRequest({
      action: 'CLEAR_CURRENT_VIDEO_SUBTITLE_CACHE',
      params: {},
    }, tabId, context.url);
  });

  const summaryHighlights = await sendRequest<CurrentVideoSummaryHighlightsResult>({
    action: 'GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS',
    params: {
      requestId: 'handler-guard-clear-combined',
      primaryTextSelectionsReady: true,
      selectedSourceIdentityKey: evidence.sourceRecord.sourceIdentityKey,
    },
  }, tabId, context.url);

  assert.equal(summaryHighlights.success, true);
  assert.equal(summaryHighlights.data?.status, 'cancelled');
  assert.equal(summaryHighlights.data?.highlights.length, 0);
  assert.equal(await db.currentVideoTranscriptSegments.count(), 0);
});

test('return request with stale exact source does not send a content seek message', async () => {
  resetChromeHarness();
  await resetTranscriptDb();
  const tabId = 18_633;
  const context = handlerVideoContext('BV1GuardReturn', 5301);
  const evidence = await seedHandlerTranscript(
    context,
    tabId,
    'guard-return',
    'guard return source binding',
  );
  storageValues[CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY] = {
    [handlerPartKey(context)]: evidence.sourceRecord.sourceIdentityKey,
  };
  setTabs([{ id: tabId, url: context.url, active: true, lastAccessed: 13_000 }]);
  await sendContentMessage({ action: 'CURRENT_VIDEO_CONTEXT_UPDATE', payload: context }, tabId, context.url);
  await confirmHandlerTranscriptCurrent(context, tabId, evidence);
  storageValues[CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY] = {
    [handlerPartKey(context)]: `${evidence.sourceRecord.sourceIdentityKey}:new`,
  };
  const contentMessages: unknown[] = [];
  setTabMessageHandler(tabId, (message) => {
    contentMessages.push(message);
    return {
      ok: true,
      message: 'mock return should not run',
      candidateId: null,
      returnPointSeconds: 1,
      targetSeconds: 2,
    };
  });

  const response = await sendRequest<CurrentVideoTimestampReturnResponse>({
    action: 'RETURN_CURRENT_VIDEO_SEGMENT_JUMP',
    params: {
      primaryTextSelectionsReady: true,
      selectedSourceIdentityKey: evidence.sourceRecord.sourceIdentityKey,
    },
  }, tabId, context.url);

  assert.equal(response.success, true);
  assert.equal(response.data?.ok, false);
  assert.equal(contentMessages.length, 0);
});

test('jump operation lease is denied when selection changes before content consumes delivery', async () => {
  resetChromeHarness();
  await resetTranscriptDb();
  const tabId = 18_634;
  const context = handlerVideoContext('BV1LeaseJump', 5401);
  const evidence = await seedHandlerTranscript(
    context,
    tabId,
    'lease-jump',
    'lease jump evidence must not seek after the source selection changes',
  );
  const sourceIdentityKey = evidence.sourceRecord.sourceIdentityKey;
  assert.ok(sourceIdentityKey);
  storageValues[CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY] = {
    [handlerPartKey(context)]: sourceIdentityKey,
  };
  setTabs([{ id: tabId, url: context.url, active: true, lastAccessed: 13_100 }]);
  await sendContentMessage({ action: 'CURRENT_VIDEO_CONTEXT_UPDATE', payload: context }, tabId, context.url);
  await confirmHandlerTranscriptCurrent(context, tabId, evidence);
  const search = await searchWithExactSource(
    tabId,
    context,
    sourceIdentityKey,
    'lease jump evidence',
  );
  const candidateId = search.data?.candidates[0]?.id;
  assert.ok(candidateId);

  let leaseAuthorized: boolean | null = null;
  let seekCount = 0;
  setTabMessageHandler(tabId, async (message) => {
    const payload = contentTimestampPayload(message, 'CURRENT_VIDEO_TIMESTAMP_JUMP');
    assert.equal(payload.returnAuthorizationKind, 'primary_text');
    await sendRequest<SaveCurrentVideoPrimaryTextSelectionResult>({
      action: 'SAVE_CURRENT_VIDEO_PRIMARY_TEXT_SELECTION',
      params: {
        bvid: context.bvid,
        cid: context.cid,
        page: context.currentPart.page,
        selectedSourceIdentityKey: `${sourceIdentityKey}:replacement`,
      },
    }, tabId, context.url);
    const consumed = await sendRequest<CurrentVideoTimestampOperationLeaseConsumeResult>({
      action: 'CONSUME_CURRENT_VIDEO_TIMESTAMP_OPERATION_LEASE',
      params: timestampLeaseConsumeParams(payload, 'jump'),
    }, tabId, context.url);
    leaseAuthorized = consumed.data?.authorized ?? false;
    if (leaseAuthorized) seekCount += 1;
    return blockedTimestampJumpMock(candidateId);
  });

  const jump = await sendRequest<CurrentVideoTimestampJumpResponse>({
    action: 'REQUEST_CURRENT_VIDEO_SEGMENT_JUMP',
    params: {
      primaryTextSelectionsReady: true,
      selectedSourceIdentityKey: sourceIdentityKey,
      candidateId,
      query: 'lease jump evidence',
      confirmed: true,
    },
  }, tabId, context.url);

  assert.equal(jump.success, true);
  assert.equal(leaseAuthorized, false);
  assert.equal(seekCount, 0);
});

test('return operation lease is denied when transcript cache clears before content consumes delivery', async () => {
  resetChromeHarness();
  await resetTranscriptDb();
  const tabId = 18_635;
  const context = handlerVideoContext('BV1LeaseReturn', 5402);
  const evidence = await seedHandlerTranscript(
    context,
    tabId,
    'lease-return',
    'lease return evidence must not seek after the subtitle cache is cleared',
  );
  const sourceIdentityKey = evidence.sourceRecord.sourceIdentityKey;
  assert.ok(sourceIdentityKey);
  storageValues[CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY] = {
    [handlerPartKey(context)]: sourceIdentityKey,
  };
  setTabs([{ id: tabId, url: context.url, active: true, lastAccessed: 13_200 }]);
  await sendContentMessage({ action: 'CURRENT_VIDEO_CONTEXT_UPDATE', payload: context }, tabId, context.url);
  await confirmHandlerTranscriptCurrent(context, tabId, evidence);

  let leaseAuthorized: boolean | null = null;
  let seekCount = 0;
  setTabMessageHandler(tabId, async (message) => {
    const payload = contentTimestampPayload(message, 'CURRENT_VIDEO_TIMESTAMP_RETURN');
    await sendRequest({ action: 'CLEAR_CURRENT_VIDEO_SUBTITLE_CACHE', params: {} }, tabId, context.url);
    const consumed = await sendRequest<CurrentVideoTimestampOperationLeaseConsumeResult>({
      action: 'CONSUME_CURRENT_VIDEO_TIMESTAMP_OPERATION_LEASE',
      params: timestampLeaseConsumeParams(payload, 'return'),
    }, tabId, context.url);
    leaseAuthorized = consumed.data?.authorized ?? false;
    if (leaseAuthorized) seekCount += 1;
    return {
      ok: false,
      message: '当前视频状态已变化，请重新预览并确认跳转。',
      candidateId: null,
      returnPointSeconds: null,
      targetSeconds: null,
    };
  });

  const returned = await sendRequest<CurrentVideoTimestampReturnResponse>({
    action: 'RETURN_CURRENT_VIDEO_SEGMENT_JUMP',
    params: {
      primaryTextSelectionsReady: true,
      selectedSourceIdentityKey: sourceIdentityKey,
    },
  }, tabId, context.url);

  assert.equal(returned.success, true);
  assert.equal(leaseAuthorized, false);
  assert.equal(seekCount, 0);
});

test('subtitle jump lease is denied when the exact viewing source is replaced before content consumes delivery', async () => {
  resetChromeHarness();
  await resetTranscriptDb();
  const tabId = 18_636;
  const context = handlerVideoContext('BV1SubtitleLeaseSource', 5403);
  const evidence = await seedHandlerTranscript(
    context,
    tabId,
    'subtitle-lease-source',
    'the original subtitle viewing source must remain exact until delivery',
  );
  setTabs([{ id: tabId, url: context.url, active: true, lastAccessed: 13_300 }]);
  await sendContentMessage({ action: 'CURRENT_VIDEO_CONTEXT_UPDATE', payload: context }, tabId, context.url);
  await confirmHandlerTranscriptCurrent(context, tabId, evidence);
  const view = await sendRequest<CurrentVideoSubtitleViewSourcesResult>({
    action: 'GET_CURRENT_VIDEO_SUBTITLE_VIEW_SOURCES',
    params: {},
  }, tabId, context.url);
  const source = view.data?.sources[0];
  const line = source?.lines[0];
  assert.equal(view.data?.status, 'ready');
  assert.ok(source);
  assert.ok(line);

  let leaseAuthorized: boolean | null = null;
  let seekCount = 0;
  setTabMessageHandler(tabId, async (message) => {
    const payload = contentTimestampPayload(message, 'CURRENT_VIDEO_TIMESTAMP_JUMP');
    assert.equal(payload.returnAuthorizationKind, 'subtitle_view');
    const replacement = await seedHandlerTranscript(
      context,
      tabId,
      'subtitle-lease-source-replacement',
      'a replacement subtitle body must invalidate the older viewing source',
    );
    await confirmHandlerTranscriptCurrent(context, tabId, replacement);
    assert.notEqual(replacement.sourceRecord.sourceIdentityKey, source.identity.sourceIdentityKey);
    const consumed = await sendRequest<CurrentVideoTimestampOperationLeaseConsumeResult>({
      action: 'CONSUME_CURRENT_VIDEO_TIMESTAMP_OPERATION_LEASE',
      params: timestampLeaseConsumeParams(payload, 'jump'),
    }, tabId, context.url);
    leaseAuthorized = consumed.data?.authorized ?? false;
    if (leaseAuthorized) seekCount += 1;
    return blockedTimestampJumpMock(line.lineId);
  });

  const jump = await sendRequest<CurrentVideoTimestampJumpResponse>({
    action: 'REQUEST_CURRENT_VIDEO_SUBTITLE_JUMP',
    params: {
      sourceIdentityKey: source.identity.sourceIdentityKey,
      lineId: line.lineId,
      lineBindingKey: line.lineBindingKey,
      confirmed: true,
    },
  }, tabId, context.url);

  assert.equal(jump.success, true);
  assert.equal(leaseAuthorized, false);
  assert.equal(seekCount, 0);
});

test('subtitle jump lease is denied when the current part changes before content consumes delivery', async () => {
  resetChromeHarness();
  await resetTranscriptDb();
  const tabId = 18_637;
  const context = handlerVideoContext('BV1SubtitleLeasePart', 5404, 1);
  const evidence = await seedHandlerTranscript(
    context,
    tabId,
    'subtitle-lease-part',
    'the subtitle jump belongs only to the original video part',
  );
  setTabs([{ id: tabId, url: context.url, active: true, lastAccessed: 13_400 }]);
  await sendContentMessage({ action: 'CURRENT_VIDEO_CONTEXT_UPDATE', payload: context }, tabId, context.url);
  await confirmHandlerTranscriptCurrent(context, tabId, evidence);
  const view = await sendRequest<CurrentVideoSubtitleViewSourcesResult>({
    action: 'GET_CURRENT_VIDEO_SUBTITLE_VIEW_SOURCES',
    params: {},
  }, tabId, context.url);
  const source = view.data?.sources[0];
  const line = source?.lines[0];
  assert.ok(source);
  assert.ok(line);

  let leaseAuthorized: boolean | null = null;
  let seekCount = 0;
  setTabMessageHandler(tabId, async (message) => {
    const payload = contentTimestampPayload(message, 'CURRENT_VIDEO_TIMESTAMP_JUMP');
    const nextContext = handlerVideoContext(context.bvid, 6404, 2);
    setTabs([{ id: tabId, url: nextContext.url, active: true, lastAccessed: 13_401 }]);
    emitTabUpdated(tabId, nextContext.url);
    await sendContentMessage(
      { action: 'CURRENT_VIDEO_CONTEXT_UPDATE', payload: nextContext },
      tabId,
      nextContext.url,
    );
    const consumed = await sendRequest<CurrentVideoTimestampOperationLeaseConsumeResult>({
      action: 'CONSUME_CURRENT_VIDEO_TIMESTAMP_OPERATION_LEASE',
      params: timestampLeaseConsumeParams(payload, 'jump'),
    }, tabId, nextContext.url);
    leaseAuthorized = consumed.data?.authorized ?? false;
    if (leaseAuthorized) seekCount += 1;
    return blockedTimestampJumpMock(line.lineId);
  });

  const jump = await sendRequest<CurrentVideoTimestampJumpResponse>({
    action: 'REQUEST_CURRENT_VIDEO_SUBTITLE_JUMP',
    params: {
      sourceIdentityKey: source.identity.sourceIdentityKey,
      lineId: line.lineId,
      lineBindingKey: line.lineBindingKey,
      confirmed: true,
    },
  }, tabId, context.url);

  assert.equal(jump.success, true);
  assert.equal(leaseAuthorized, false);
  assert.equal(seekCount, 0);
});

test('subtitle return lease is denied when the subtitle cache clears before content consumes delivery', async () => {
  resetChromeHarness();
  await resetTranscriptDb();
  const tabId = 18_638;
  const context = handlerVideoContext('BV1SubtitleLeaseReturn', 5405);
  const evidence = await seedHandlerTranscript(
    context,
    tabId,
    'subtitle-lease-return',
    'the subtitle return belongs to the exact cached viewing source',
  );
  setTabs([{ id: tabId, url: context.url, active: true, lastAccessed: 13_500 }]);
  await sendContentMessage({ action: 'CURRENT_VIDEO_CONTEXT_UPDATE', payload: context }, tabId, context.url);
  await confirmHandlerTranscriptCurrent(context, tabId, evidence);
  const view = await sendRequest<CurrentVideoSubtitleViewSourcesResult>({
    action: 'GET_CURRENT_VIDEO_SUBTITLE_VIEW_SOURCES',
    params: {},
  }, tabId, context.url);
  const source = view.data?.sources[0];
  assert.ok(source);

  let leaseAuthorized: boolean | null = null;
  let seekCount = 0;
  setTabMessageHandler(tabId, async (message) => {
    const payload = contentTimestampPayload(message, 'CURRENT_VIDEO_TIMESTAMP_RETURN');
    await sendRequest({ action: 'CLEAR_CURRENT_VIDEO_SUBTITLE_CACHE', params: {} }, tabId, context.url);
    const consumed = await sendRequest<CurrentVideoTimestampOperationLeaseConsumeResult>({
      action: 'CONSUME_CURRENT_VIDEO_TIMESTAMP_OPERATION_LEASE',
      params: timestampLeaseConsumeParams(payload, 'return'),
    }, tabId, context.url);
    leaseAuthorized = consumed.data?.authorized ?? false;
    if (leaseAuthorized) seekCount += 1;
    return {
      ok: false,
      message: '当前视频状态已变化，请重新预览并确认跳转。',
      candidateId: null,
      returnPointSeconds: null,
      targetSeconds: null,
    };
  });

  const returned = await sendRequest<CurrentVideoTimestampReturnResponse>({
    action: 'RETURN_CURRENT_VIDEO_SUBTITLE_JUMP',
    params: { sourceIdentityKey: source.identity.sourceIdentityKey },
  }, tabId, context.url);

  assert.equal(returned.success, true);
  assert.equal(leaseAuthorized, false);
  assert.equal(seekCount, 0);
});

function handlerVideoContext(bvid: string, cid: number, page = 1): CurrentVideoContext {
  return {
    kind: 'video',
    url: `https://www.bilibili.com/video/${bvid}?p=${page}`,
    collectedAt: Date.now(),
    bvid,
    aid: cid,
    cid,
    title: `Handler video ${cid} page ${page}`,
    authorName: 'Handler UP',
    authorMid: 42,
    durationSeconds: 120,
    currentPart: { page, title: `P${page}`, total: 2 },
    parts: [{ page, cid, title: `P${page}`, durationSeconds: 120 }],
    chapters: [],
    description: {
      availability: 'available',
      text: 'Handler context visible description.',
      length: 36,
    },
    sources: {
      metadata: 'available',
      description: 'available',
      pages: 'available',
      chapters: 'unknown',
      transcript: 'available',
      contentText: 'unavailable',
    },
    subtitleProbe: {
      status: 'unsupported',
      available: false,
      checkedAt: Date.now(),
      bvid,
      cid,
      page,
      sourceType: 'none',
      sourceDomain: null,
      sourcePath: null,
      needLoginSubtitle: null,
      trackCount: 0,
      segmentCount: null,
      coverageStartSeconds: null,
      coverageEndSeconds: null,
      languages: [],
      tracks: [],
      reason: 'handler_test',
      message: 'Handler test does not probe remote subtitle sources.',
      warnings: [],
    },
    transcriptEvidence: null,
    warnings: ['transcript_probe_pending'],
  };
}

function handlerSummaryHighlightsAiOutput() {
  return {
    summarySentences: [
      { text: '本段说明关闭授权时必须取消请求。', evidenceLineNumbers: [1] },
      { text: '取消后的结果不得写入本地缓存。', evidenceLineNumbers: [1] },
    ],
    keyPoints: [
      { text: '先启动生成请求。', evidenceLineNumbers: [1] },
      { text: '再关闭完整文本授权。', evidenceLineNumbers: [1] },
      { text: '最后确认缓存为空。', evidenceLineNumbers: [1] },
    ],
    highlights: [
      { title: '启动请求', description: '开始发送一次完整正文请求。', startSeconds: 2, endSeconds: 3, evidenceLineNumbers: [1] },
      { title: '关闭授权', description: '设置更新会使请求失效。', startSeconds: 3, endSeconds: 4, evidenceLineNumbers: [1] },
      { title: '中止网络', description: '旧请求的网络信号被中止。', startSeconds: 4, endSeconds: 5, evidenceLineNumbers: [1] },
      { title: '拒绝写入', description: '迟到结果不会进入本地缓存。', startSeconds: 5, endSeconds: 6, evidenceLineNumbers: [1] },
    ],
  };
}

async function seedHandlerTranscript(
  context: CurrentVideoContext,
  tabId: number,
  trackId: string,
  content: string,
  language = 'zh-CN',
) {
  const evidence = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 2, to: 7, content }] },
    {
      bvid: context.bvid,
      cid: context.cid as number,
      page: context.currentPart.page,
      language,
      sourceType: 'bilibili_player_wbi_v2',
      trackId,
      trackUrlHost: 'aisubtitle.hdslb.com',
      fetchedAt: 12_000,
    },
  );
  const owner = retainTemporaryTranscriptOwnerForContextSnapshot(context, tabId);
  assert.ok(owner);
  await upsertCurrentVideoTranscriptEvidence(evidence, { temporaryOwner: owner });
  return evidence;
}

async function confirmHandlerTranscriptCurrent(
  context: CurrentVideoContext,
  tabId: number,
  evidence: Awaited<ReturnType<typeof seedHandlerTranscript>>,
): Promise<void> {
  const owner = retainTemporaryTranscriptOwnerForContextSnapshot(context, tabId);
  assert.ok(owner);
  const state = await upsertCurrentVideoTranscriptEvidence(evidence, { temporaryOwner: owner });
  assert.equal(state.active, true);
}

async function runHandlerCase(name: string, callback: () => Promise<void>): Promise<void> {
  try {
    await callback();
  } catch (error) {
    if (error instanceof Error) {
      error.message = `[${name}] ${error.message}`;
    }
    throw error;
  }
}

async function searchWithExactSource(
  tabId: number,
  context: CurrentVideoContext,
  sourceIdentityKey: string | undefined,
  query: string,
): Promise<BiliVizResponse<CurrentVideoSegmentRetrievalResult>> {
  assert.ok(sourceIdentityKey);
  return await sendRequest<CurrentVideoSegmentRetrievalResult>({
    action: 'SEARCH_CURRENT_VIDEO_SEGMENTS',
    params: {
      query,
      primaryTextSelectionsReady: true,
      selectedSourceIdentityKey: sourceIdentityKey,
    },
  }, tabId, context.url);
}

type ProtectedHandlerAction = 'knowledge' | 'search' | 'jump';
type GuardTestPhase =
  | 'before_active_source_check'
  | 'before_evidence_bind'
  | 'before_segment_body_read'
  | 'after_segment_body_read'
  | 'before_full_text_qa_session_write'
  | 'before_full_text_qa_network'
  | 'before_timestamp_message';

async function invokeProtectedHandlerAction(
  action: ProtectedHandlerAction,
  tabId: number,
  context: CurrentVideoContext,
  sourceIdentityKey: string | undefined,
): Promise<BiliVizResponse<unknown>> {
  assert.ok(sourceIdentityKey);
  const params = {
    primaryTextSelectionsReady: true,
    selectedSourceIdentityKey: sourceIdentityKey,
  };
  if (action === 'knowledge') {
    return await sendRequest<VideoKnowledgeResult>({
      action: 'GET_VIDEO_KNOWLEDGE',
      params,
    }, tabId, context.url);
  }
  if (action === 'search') {
    return await sendRequest<CurrentVideoSegmentRetrievalResult>({
      action: 'SEARCH_CURRENT_VIDEO_SEGMENTS',
      params: {
        ...params,
        query: 'guard evidence body',
      },
    }, tabId, context.url);
  }
  return await sendRequest<CurrentVideoTimestampJumpResponse>({
    action: 'REQUEST_CURRENT_VIDEO_SEGMENT_JUMP',
    params: {
      ...params,
      candidateId: 'guard-candidate',
      query: 'guard evidence body',
      confirmed: true,
    },
  }, tabId, context.url);
}

function assertProtectedActionBlocked(
  action: ProtectedHandlerAction,
  response: BiliVizResponse<unknown>,
): void {
  assert.equal(response.success, true);
  if (action === 'knowledge') {
    const data = response.data as VideoKnowledgeResult;
    assert.equal(data.nodes.length, 0);
    assert.equal(data.sourceState.transcriptEvidence, false);
    return;
  }
  if (action === 'search') {
    const data = response.data as CurrentVideoSegmentRetrievalResult;
    assert.equal(data.status, 'no_evidence');
    assert.equal(data.candidates.length, 0);
    assert.equal(data.evidenceState.transcriptSegmentCount, 0);
    assert.equal(data.aiRerank.status, 'not_requested');
    assert.equal(data.qa.aiState.status, 'not_requested');
    return;
  }
  const data = response.data as CurrentVideoTimestampJumpResponse;
  assert.equal(data.ok, false);
  assert.equal(data.targetSeconds, null);
}

function handlerPartKey(context: CurrentVideoContext): string {
  assert.ok(context.cid);
  return `${context.bvid}:${context.cid}:${context.currentPart.page}`;
}

function contentTimestampPayload(message: unknown, expectedAction: string): Record<string, unknown> {
  assert.ok(message && typeof message === 'object');
  const record = message as Record<string, unknown>;
  assert.equal(record.action, expectedAction);
  assert.ok(record.payload && typeof record.payload === 'object');
  return record.payload as Record<string, unknown>;
}

function timestampLeaseConsumeParams(
  payload: Record<string, unknown>,
  operationKind: 'jump' | 'return',
): Record<string, unknown> {
  return {
    operationLeaseId: payload.operationLeaseId,
    operationKind,
    contextBvid: payload.contextBvid,
    contextCid: payload.contextCid,
    contextPage: payload.contextPage,
    sourceIdentityKey: payload.sourceIdentityKey,
  };
}

function blockedTimestampJumpMock(candidateId: string): CurrentVideoTimestampJumpResponse {
  return {
    ok: false,
    message: '当前视频状态已变化，请重新预览并确认跳转。',
    candidateId,
    targetSeconds: null,
    targetTimeLabel: null,
    returnPointSeconds: null,
    sourceLabel: '可定位字幕证据',
    confidence: 0,
  };
}

function installGuardTestHook(
  expectedPhase: GuardTestPhase,
  callback: () => Promise<void>,
): void {
  let used = false;
  (globalThis as typeof globalThis & {
    __biliBillCurrentVideoPrimaryTextGuardTestHook__?: (phase: GuardTestPhase) => Promise<void>;
  }).__biliBillCurrentVideoPrimaryTextGuardTestHook__ = async (phase) => {
    if (used || phase !== expectedPhase) return;
    used = true;
    await callback();
  };
}

function installChromeFake(): void {
  (globalThis as typeof globalThis & { chrome: unknown }).chrome = {
    runtime: {
      onMessage: {
        addListener(listener: RuntimeListener) {
          runtimeListeners.push(listener);
        },
      },
    },
    tabs: {
      get(tabId: number) {
        const tab = tabs.find(item => item.id === tabId);
        return tab ? Promise.resolve({ ...tab }) : Promise.reject(new Error('tab_missing'));
      },
      onRemoved: {
        addListener(listener: RemovedListener) {
          removedListeners.push(listener);
        },
      },
      onUpdated: {
        addListener(listener: UpdatedListener) {
          updatedListeners.push(listener);
        },
      },
      sendMessage(tabId: number, message: unknown) {
        const handler = tabMessageHandlers.get(tabId);
        if (!handler) {
          return Promise.reject(new Error(`No fake tab message handler for ${tabId}`));
        }
        return Promise.resolve(handler(message));
      },
    },
    windows: {
      getAll() {
        return Promise.resolve([{ tabs: tabs.map(tab => ({ ...tab })) }]);
      },
    },
    storage: {
      local: {
        get(keys: string | string[] | Record<string, unknown> | null | undefined) {
          recordStorageGet(keys);
          if (rejectPrimaryTextSelectionStorageReads && readsStorageKey(
            keys,
            CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY,
          )) {
            return Promise.reject(new Error('PRIMARY_TEXT_SELECTION_STORAGE_READ_FAILED'));
          }
          let result: Record<string, unknown>;
          if (typeof keys === 'string') {
            result = { [keys]: storageValues[keys] };
          } else if (Array.isArray(keys)) {
            result = Object.fromEntries(keys.map(key => [key, storageValues[key]]));
          } else if (keys && typeof keys === 'object') {
            result = Object.fromEntries(
              Object.entries(keys).map(([key, fallback]) => [key, storageValues[key] ?? fallback]),
            );
          } else {
            result = { ...storageValues };
          }
          const gate = primaryTextSelectionStorageGetGate;
          if (gate && readsStorageKey(keys, CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY)) {
            return gate.then(() => result);
          }
          const localSettingsGate = storageGetGate;
          if (localSettingsGate && readsStorageKey(keys, localSettingsGate.key)) {
            localSettingsGate.reached();
            return localSettingsGate.release.then(() => result);
          }
          return Promise.resolve(result);
        },
        async set(values: Record<string, unknown>) {
          const gate = storageSetGate;
          if (gate && Object.hasOwn(values, gate.key)) {
            gate.reached();
            await gate.release;
          }
          Object.assign(storageValues, values);
        },
        async remove(keys: string | string[]) {
          const normalizedKeys = Array.isArray(keys) ? keys : [keys];
          const gate = storageRemoveGate;
          if (gate && normalizedKeys.includes(gate.key)) {
            gate.reached();
            await gate.release;
          }
          for (const key of normalizedKeys) {
            delete storageValues[key];
          }
        },
        clear() {
          for (const key of Object.keys(storageValues)) {
            delete storageValues[key];
          }
          return Promise.resolve();
        },
      },
    },
  };
}

function resetChromeHarness(): void {
  tabs.length = 0;
  tabMessageHandlers.clear();
  delete (globalThis as typeof globalThis & {
    __biliBillCurrentVideoPrimaryTextGuardTestHook__?: unknown;
  }).__biliBillCurrentVideoPrimaryTextGuardTestHook__;
  delete (globalThis as typeof globalThis & {
    __biliBillHistoryAggregateTestHook__?: unknown;
  }).__biliBillHistoryAggregateTestHook__;
  for (const key of Object.keys(storageValues)) {
    delete storageValues[key];
  }
  storageGetCounts.clear();
  rejectPrimaryTextSelectionStorageReads = false;
  primaryTextSelectionStorageGetGate = null;
  storageRemoveGate = null;
  storageSetGate = null;
  storageGetGate = null;
}

function setTabs(nextTabs: FakeTab[]): void {
  tabs.length = 0;
  tabs.push(...nextTabs);
}

function setTabMessageHandler(tabId: number, handler: (message: unknown) => Promise<unknown> | unknown): void {
  tabMessageHandlers.set(tabId, handler);
}

function emitTabUpdated(tabId: number, url: string): void {
  for (const listener of updatedListeners) {
    listener(tabId, { url });
  }
}

async function sendContentMessage(
  message: unknown,
  tabId: number,
  senderUrl: string,
): Promise<BiliVizResponse> {
  return await sendRuntimeMessage(message, tabId, senderUrl);
}

async function sendRequest<T>(
  request: BiliVizRequest,
  tabId: number,
  senderUrl: string,
): Promise<BiliVizResponse<T>> {
  let guardedRequest = request;
  if (request.action === 'UPDATE_CONFIG'
      && (!request.params?.expectedConfig
        || typeof request.params.expectedConfigRevision !== 'string')) {
    const snapshot = await sendRuntimeMessage<BiliVizResponse<{
      config: Record<string, unknown>;
      revision: string;
    }>>({ action: 'GET_CONFIG_SNAPSHOT' }, tabId, senderUrl);
    if (!snapshot.success || !snapshot.data) return snapshot as BiliVizResponse<T>;
    guardedRequest = {
      ...request,
      params: {
        ...(request.params ?? {}),
        expectedConfig: snapshot.data.config,
        expectedConfigRevision: snapshot.data.revision,
      },
    };
  }
  return await sendRuntimeMessage<BiliVizResponse<T>>(guardedRequest, tabId, senderUrl);
}

async function sendPopupRequest<T>(request: BiliVizRequest): Promise<BiliVizResponse<T>> {
  const listener = runtimeListeners[0];
  assert.ok(listener, 'message handler was not registered');
  return await new Promise<BiliVizResponse<T>>((resolve, reject) => {
    let settled = false;
    const keepOpen = listener(request, {}, (response) => {
      settled = true;
      resolve(response as BiliVizResponse<T>);
    });
    if (keepOpen !== true && !settled) {
      reject(new Error('Fake popup runtime listener did not respond synchronously or keep the channel open'));
    }
  });
}

async function sendRuntimeMessage<T>(
  message: unknown,
  tabId: number,
  senderUrl: string,
): Promise<T> {
  const listener = runtimeListeners[0];
  assert.ok(listener, 'message handler was not registered');
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const keepOpen = listener(
      message,
      { tab: { id: tabId, url: senderUrl } },
      (response) => {
        settled = true;
        resolve(response as T);
      },
    );
    if (keepOpen !== true && !settled) {
      reject(new Error('Fake runtime listener did not respond synchronously or keep the channel open'));
    }
  });
}

async function resetTranscriptDb(): Promise<void> {
  clearTemporaryCurrentVideoTranscriptCache();
  await db.currentVideoTranscriptSegments.clear();
  await db.currentVideoTranscriptSources.clear();
}

async function transcriptSource(identityKey: string | undefined) {
  assert.ok(identityKey);
  return await db.currentVideoTranscriptSources
    .where('identityKey')
    .equals(identityKey)
    .first();
}

function recordStorageGet(keys: string | string[] | Record<string, unknown> | null | undefined): void {
  const recordKey = (key: string) => {
    storageGetCounts.set(key, (storageGetCounts.get(key) ?? 0) + 1);
  };
  if (typeof keys === 'string') {
    recordKey(keys);
  } else if (Array.isArray(keys)) {
    for (const key of keys) recordKey(key);
  } else if (keys && typeof keys === 'object') {
    for (const key of Object.keys(keys)) recordKey(key);
  }
}

function storageReadCount(key: string): number {
  return storageGetCounts.get(key) ?? 0;
}

function readsStorageKey(
  keys: string | string[] | Record<string, unknown> | null | undefined,
  expectedKey: string,
): boolean {
  if (typeof keys === 'string') return keys === expectedKey;
  if (Array.isArray(keys)) return keys.includes(expectedKey);
  if (keys && typeof keys === 'object') return expectedKey in keys;
  return true;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function installHistoryAggregateTestHook(
  hook: (phase: 'before_daily_aggregate_write') => Promise<void>,
): void {
  (globalThis as typeof globalThis & {
    __biliBillHistoryAggregateTestHook__?: typeof hook;
  }).__biliBillHistoryAggregateTestHook__ = hook;
}

function qaSessionNearByteLimit(sessionId: string): CurrentVideoQaSessionRecord {
  const now = 20_000;
  const sizingRecord: CurrentVideoQaSessionRecord = {
    id: Number.MAX_SAFE_INTEGER,
    sessionId,
    title: '容量边界会话',
    customTitle: null,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    turns: [{
      turnId: 'handler-qa-limit-existing-turn',
      requestId: 'handler-qa-limit-existing-request',
      question: '已有问题',
      status: 'ready',
      answer: '',
      message: '已有回答',
      citations: [],
      canRetry: true,
      ai: { status: 'generated', model: 'handler-test-model', note: '', errorCode: null },
      source: null,
      rollingContext: null,
      createdAt: now,
      updatedAt: now,
      submittedAt: now,
      generatedAt: now,
    }],
  };
  const padding = CURRENT_VIDEO_QA_SESSION_MAX_BYTES - serializedTestBytes([sizingRecord]) - 64;
  assert.ok(padding > 0);
  sizingRecord.turns[0]!.answer = 'a'.repeat(padding);
  delete sizingRecord.id;
  return sizingRecord;
}

function serializedTestBytes(rows: unknown[]): number {
  return rows.reduce(
    (total, row) => total + new TextEncoder().encode(JSON.stringify(row)).byteLength,
    0,
  );
}

async function importBundledMessageHandlers(): Promise<{
  setupMessageHandlers: () => void;
  clearTemporaryCurrentVideoTranscriptCache: typeof import('../src/background/current-video-temporary-transcript-cache.ts').clearTemporaryCurrentVideoTranscriptCache;
  computeDailyAggregate: typeof import('../src/background/analytics/engine.ts').computeDailyAggregate;
  computeStoredHistoryAggregates: typeof import('../src/background/analytics/engine.ts').computeStoredHistoryAggregates;
  db: typeof import('../src/background/storage/db.ts').db;
  getCurrentVideoCurrentOwnerTranscriptSourceIdentityKeys: typeof import('../src/background/storage/current-video-transcript-repo.ts').getCurrentVideoCurrentOwnerTranscriptSourceIdentityKeys;
  getTemporaryCurrentVideoTranscriptSegments: typeof import('../src/background/current-video-temporary-transcript-cache.ts').getTemporaryCurrentVideoTranscriptSegments;
  invalidateCurrentVideoFullTextQaSources: typeof import('../src/background/current-video-full-text-qa.ts').invalidateCurrentVideoFullTextQaSources;
  normalizeBilibiliTranscriptEvidence: typeof import('../src/shared/current-video-transcript-cache.ts').normalizeBilibiliTranscriptEvidence;
  putTemporaryCurrentVideoTranscriptEvidence: typeof import('../src/background/current-video-temporary-transcript-cache.ts').putTemporaryCurrentVideoTranscriptEvidence;
  retainTemporaryTranscriptOwnerForContextSnapshot: typeof import('../src/background/current-video-transcript-owner.ts').retainTemporaryTranscriptOwnerForContextSnapshot;
  upsertCurrentVideoTranscriptEvidence: typeof import('../src/background/storage/current-video-transcript-repo.ts').upsertCurrentVideoTranscriptEvidence;
}> {
  const { build } = await import('esbuild');
  const outdir = await mkdtemp(join(tmpdir(), 'bili-bill-handlers-'));
  const outfile = join(outdir, 'handlers.mjs');
  await build({
    stdin: {
      contents: [
        "export { setupMessageHandlers } from './src/background/messages/handlers.ts';",
        "export { computeDailyAggregate, computeStoredHistoryAggregates } from './src/background/analytics/engine.ts';",
        "export { clearTemporaryCurrentVideoTranscriptCache, getTemporaryCurrentVideoTranscriptSegments, putTemporaryCurrentVideoTranscriptEvidence } from './src/background/current-video-temporary-transcript-cache.ts';",
        "export { retainTemporaryTranscriptOwnerForContextSnapshot } from './src/background/current-video-transcript-owner.ts';",
        "export { invalidateCurrentVideoFullTextQaSources } from './src/background/current-video-full-text-qa.ts';",
        "export { db } from './src/background/storage/db.ts';",
        "export { getCurrentVideoCurrentOwnerTranscriptSourceIdentityKeys, upsertCurrentVideoTranscriptEvidence } from './src/background/storage/current-video-transcript-repo.ts';",
        "export { normalizeBilibiliTranscriptEvidence } from './src/shared/current-video-transcript-cache.ts';",
      ].join('\n'),
      loader: 'ts',
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
      sourcefile: 'current-video-message-handlers-test-entry.ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    outfile,
    logLevel: 'silent',
  });
  return await import(pathToFileURL(outfile).href);
}
