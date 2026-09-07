import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import Dexie from 'dexie';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { cacheCurrentVideoTranscriptEvidence } from '../src/background/current-video-transcript-cache.ts';
import {
  CURRENT_VIDEO_TRANSCRIPT_CACHE_MAX_BYTES,
  CURRENT_VIDEO_TRANSCRIPT_CACHE_MAX_SOURCE_IDENTITIES,
  buildTranscriptEvidenceStateFromCache,
  measureTranscriptPersistentBytes,
  normalizeBilibiliTranscriptEvidence,
  planTranscriptEvidenceUpsert,
  withTranscriptEvidenceState,
} from '../src/shared/current-video-transcript-cache.ts';
import {
  clearTemporaryCurrentVideoTranscriptCache,
  clearTemporaryCurrentVideoTranscriptCacheForTab,
  CURRENT_VIDEO_TEMPORARY_TRANSCRIPT_MAX_SOURCES,
  getTemporaryCurrentVideoTranscriptEvidenceState,
  getTemporaryCurrentVideoTranscriptSegments,
  putTemporaryCurrentVideoTranscriptEvidence,
  retainTemporaryCurrentVideoTranscriptOwner,
} from '../src/background/current-video-temporary-transcript-cache.ts';
import {
  getCurrentVideoTranscriptClearState,
  runCurrentVideoTranscriptClearCoordinator,
} from '../src/background/current-video-transcript-clear-epoch.ts';
import {
  coordinateBlindBoxDrawHistoryClear,
  recordBlindBoxDrawnBvids,
  type BlindBoxDrawHistoryStorage,
} from '../src/background/storage/blind-box-draw-history-repo.ts';
import { clearLegacyCurrentVideoTranscriptCache } from '../src/background/storage/current-video-transcript-migration.ts';
import {
  assertAssistantPayloadAudit,
  auditAssistantPayload,
  currentVideoSummaryPayloadContract,
} from '../src/shared/assistant-payload-audit.ts';
import {
  buildCurrentVideoSummaryAiPayload,
  buildLocalCurrentVideoSummary,
} from '../src/shared/current-video-summary.ts';
import { searchCurrentVideoSegments } from '../src/shared/current-video-segment-retrieval.ts';
import { buildVideoKnowledgeResult } from '../src/shared/video-knowledge.ts';
import type { CurrentVideoContext } from '../src/shared/types/current-video-context.ts';
import type {
  CurrentVideoTranscriptEvidenceState,
  CurrentVideoTranscriptEvidenceWrite,
  CurrentVideoTranscriptSegment,
  CurrentVideoTranscriptSourceRecord,
} from '../src/shared/types/current-video-transcript.ts';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!specifier.startsWith('.') || /\.[cm]?[jt]sx?$/.test(specifier)) throw error;
      for (const candidate of [`${specifier}.ts`, `${specifier}.tsx`, `${specifier}/index.ts`]) {
        try {
          return nextResolve(candidate, context);
        } catch {
          // Try the next TypeScript source shape.
        }
      }
      throw error;
    }
  },
});

type CurrentVideoTranscriptTestDb = typeof import('../src/background/storage/db.ts').db;

test('normalizes Bilibili subtitle rows into stable transcript segments', () => {
  const evidence = normalizeBilibiliTranscriptEvidence(
    {
      body: [
        { from: 0, to: 1.25, content: '  hello transcript  ' },
        { from: 1.25, to: 3, content: 'second line' },
        { from: 4, to: 3, content: 'bad time' },
        { from: 5, to: 6, content: '   ' },
      ],
    },
    baseNormalizeOptions(),
  );

  assert.equal(evidence.sourceRecord.status, 'cached');
  assert.equal(evidence.sourceRecord.segmentCount, 2);
  assert.equal(evidence.sourceRecord.coverageStartSeconds, 0);
  assert.equal(evidence.sourceRecord.coverageEndSeconds, 3);
  assert.deepEqual(evidence.sourceRecord.warnings, ['transcript_segments_filtered']);
  assert.equal(evidence.segments.length, 2);
  assert.equal(evidence.segments[0].text, 'hello transcript');
  assert.equal(evidence.segments[0].bvid, 'BV1Transcript00');
  assert.equal(evidence.segments[0].cid, 101);
  assert.equal(evidence.segments[0].page, 1);
  assert.equal(evidence.segments[0].language, 'zh-CN');
  assert.equal(evidence.segments[0].source, 'bilibili_subtitle');
  assert.equal(evidence.segments[0].sourceHash, evidence.sourceRecord.sourceHash);
  assert.equal(evidence.segments[0].sourceIdentityKey, evidence.sourceRecord.sourceIdentityKey);
  assert.ok(evidence.sourceRecord.sourceIdentityKey?.startsWith('primary-text:bilibili_subtitle:BV1Transcript00:101:1:zh-cn:'));
  assert.ok(evidence.sourceRecord.bodyHash);
  assert.ok(evidence.sourceRecord.timelineHash);
  assert.notEqual(evidence.sourceRecord.bodyHash, evidence.sourceRecord.timelineHash);
  assert.match(evidence.sourceRecord.sourceHash, /^[a-f0-9]{64}$/);
  assert.match(evidence.sourceRecord.bodyHash, /^[a-f0-9]{64}$/);
  assert.match(evidence.sourceRecord.timelineHash, /^[a-f0-9]{64}$/);
  assert.match(evidence.sourceRecord.sourceIdentityKey ?? '', /:[a-f0-9]{64}$/);
  assert.match(evidence.segments[0].segmentId, /^transcript:BV1Transcript00:101:1:zh-cn:/);
});

test('upserts and reads transcript evidence without destructive unrelated changes', () => {
  const store = memoryStore();
  const evidence = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 0, to: 2, content: 'cached line' }] },
    baseNormalizeOptions(),
  );
  const state = store.upsert(evidence);

  assert.equal(state.status, 'cached');
  assert.equal(state.active, true);
  assert.equal(state.segmentCount, 1);
  assert.equal(store.sources.length, 1);
  assert.equal(store.segments.length, 1);

  const read = buildTranscriptEvidenceStateFromCache(
    { bvid: 'BV1Transcript00', cid: 101, page: 1 },
    store.sources,
    store.segments,
    2000,
  );
  assert.equal(read.status, 'cached');
  assert.equal(read.active, true);
  assert.equal(read.segmentCount, 1);
});

test('source identity key does not override current-video part identity', () => {
  const partOne = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 0, to: 2, content: '第一分 P 字幕不能被第二分 P 读取。' }] },
    baseNormalizeOptions({ bvid: 'BV1SameBvid00', cid: 101, page: 1, fetchedAt: 1100 }),
  );
  const spoofedPartTwoSource: CurrentVideoTranscriptSourceRecord = {
    ...partOne.sourceRecord,
    cid: 202,
    page: 2,
    partIdentityKey: 'subtitle-part:BV1SameBvid00:202:2:zh-cn',
  };
  const state = buildTranscriptEvidenceStateFromCache(
    {
      bvid: 'BV1SameBvid00',
      cid: 202,
      page: 2,
      language: 'zh-CN',
      sourceIdentityKey: partOne.sourceRecord.sourceIdentityKey,
      sourceHash: partOne.sourceRecord.sourceHash,
    },
    [partOne.sourceRecord],
    partOne.segments,
    1200,
  );
  const spoofedState = buildTranscriptEvidenceStateFromCache(
    {
      bvid: 'BV1SameBvid00',
      cid: 202,
      page: 2,
      language: 'zh-CN',
      sourceIdentityKey: partOne.sourceRecord.sourceIdentityKey,
      sourceHash: partOne.sourceRecord.sourceHash,
    },
    [spoofedPartTwoSource],
    partOne.segments.map(segment => ({ ...segment, cid: 202, page: 2 })),
    1200,
  );

  assert.equal(state.active, false);
  assert.notEqual(state.status, 'cached');
  assert.equal(spoofedState.active, true);
  assert.equal(spoofedState.cid, 202);
  assert.equal(spoofedState.page, 2);
});

test('keeps text and timeline changes as separate source identities', () => {
  const store = memoryStore();
  const first = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 0, to: 2, content: 'first version' }] },
    baseNormalizeOptions({ fetchedAt: 1000 }),
  );
  const second = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 0, to: 2, content: 'second version' }] },
    baseNormalizeOptions({ fetchedAt: 2000 }),
  );
  const retimed = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 0.5, to: 2.5, content: 'second version' }] },
    baseNormalizeOptions({ fetchedAt: 3000 }),
  );

  store.upsert(first);
  store.upsert(second);
  const state = store.upsert(retimed);

  assert.equal(state.status, 'cached');
  assert.equal(state.segmentCount, 1);
  assert.equal(state.staleSegmentCount, 0);
  assert.equal(store.sources.length, 3);
  assert.equal(store.segments.filter(segment => segment.stale).length, 0);
  assert.equal(store.segments.filter(segment => !segment.stale).length, 3);
  assert.notEqual(first.sourceRecord.sourceHash, second.sourceRecord.sourceHash);
  assert.equal(second.sourceRecord.bodyHash, retimed.sourceRecord.bodyHash);
  assert.notEqual(second.sourceRecord.timelineHash, retimed.sourceRecord.timelineHash);
  assert.notEqual(second.sourceRecord.sourceIdentityKey, retimed.sourceRecord.sourceIdentityKey);
  assert.equal(state.sourceIdentityKey, retimed.sourceRecord.sourceIdentityKey);
});

test('does not silently switch when the requested source identity is missing', () => {
  const first = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 0, to: 2, content: 'first version' }] },
    baseNormalizeOptions({ fetchedAt: 1000 }),
  );
  const second = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 0, to: 2, content: 'second version' }] },
    baseNormalizeOptions({ fetchedAt: 2000 }),
  );

  const state = buildTranscriptEvidenceStateFromCache(
    {
      bvid: 'BV1Transcript00',
      cid: 101,
      page: 1,
      language: 'zh-CN',
      sourceIdentityKey: first.sourceRecord.sourceIdentityKey,
      sourceHash: first.sourceRecord.sourceHash,
    },
    [second.sourceRecord],
    second.segments,
    3000,
  );

  assert.equal(state.status, 'stale');
  assert.equal(state.active, false);
  assert.equal(state.sourceIdentityKey, first.sourceRecord.sourceIdentityKey);
  assert.ok(state.warnings.includes('transcript_identity_mismatch'));
});

test('keeps same BVID but different CID/page from becoming active evidence', () => {
  const store = memoryStore();
  store.upsert(normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 0, to: 2, content: 'page one' }] },
    baseNormalizeOptions({ cid: 101, page: 1 }),
  ));

  const wrongPart = buildTranscriptEvidenceStateFromCache(
    { bvid: 'BV1Transcript00', cid: 202, page: 2 },
    store.sources,
    store.segments,
    3000,
  );
  assert.equal(wrongPart.status, 'stale');
  assert.equal(wrongPart.active, false);

  store.upsert(normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 0, to: 2, content: 'page two' }] },
    baseNormalizeOptions({ cid: 202, page: 2 }),
  ));
  const pageOne = buildTranscriptEvidenceStateFromCache(
    { bvid: 'BV1Transcript00', cid: 101, page: 1 },
    store.sources,
    store.segments,
    4000,
  );
  const pageTwo = buildTranscriptEvidenceStateFromCache(
    { bvid: 'BV1Transcript00', cid: 202, page: 2 },
    store.sources,
    store.segments,
    4000,
  );
  assert.equal(pageOne.status, 'cached');
  assert.equal(pageTwo.status, 'cached');
  assert.equal(pageOne.segmentCount, 1);
  assert.equal(pageTwo.segmentCount, 1);
});

test('evicts subtitle source identities by LRU when count limit is exceeded', () => {
  const store = memoryStore();
  for (let index = 0; index < CURRENT_VIDEO_TRANSCRIPT_CACHE_MAX_SOURCE_IDENTITIES; index += 1) {
    store.upsert(normalizeBilibiliTranscriptEvidence(
      { body: [{ from: index, to: index + 1, content: `line ${index}` }] },
      baseNormalizeOptions({ bvid: `BV1Lru${String(index).padStart(2, '0')}`, cid: 1000 + index, fetchedAt: 1000 + index }),
    ));
  }
  const oldestKey = store.sources[0].sourceIdentityKey;

  store.upsert(normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 80, to: 81, content: 'new lru line' }] },
    baseNormalizeOptions({ bvid: 'BV1LruNew', cid: 3000, fetchedAt: 3000 }),
  ));

  assert.equal(store.sources.length, CURRENT_VIDEO_TRANSCRIPT_CACHE_MAX_SOURCE_IDENTITIES);
  assert.equal(store.segments.length, CURRENT_VIDEO_TRANSCRIPT_CACHE_MAX_SOURCE_IDENTITIES);
  assert.equal(store.sources.some(source => source.sourceIdentityKey === oldestKey), false);
  assert.equal(store.sources.some(source => source.bvid === 'BV1LruNew'), true);
});

test('evicts by serialized byte limit without evicting protected identities', () => {
  const protectedEvidence = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 0, to: 1, content: 'protected current view' }] },
    baseNormalizeOptions({ bvid: 'BV1Protected', cid: 4001, fetchedAt: 1000 }),
  );
  const oldEvidence = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 0, to: 1, content: 'old large cache '.repeat(200) }] },
    baseNormalizeOptions({ bvid: 'BV1OldLarge', cid: 4002, fetchedAt: 1100 }),
  );
  const nextEvidence = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 0, to: 1, content: 'new write' }] },
    baseNormalizeOptions({ bvid: 'BV1NewLarge', cid: 4003, fetchedAt: 1200 }),
  );
  const sources = [
    { ...oldEvidence.sourceRecord, id: 1, lastAccessedAt: 1 },
    { ...protectedEvidence.sourceRecord, id: 2, lastAccessedAt: 2 },
  ];
  const segments = [
    { ...oldEvidence.segments[0], id: 11 },
    { ...protectedEvidence.segments[0], id: 12 },
  ];
  const maxBytes = measureTranscriptPersistentBytes(sources[1], [segments[1]])
    + measureTranscriptPersistentBytes(nextEvidence.sourceRecord, nextEvidence.segments);

  const plan = planTranscriptEvidenceUpsert(sources, segments, nextEvidence, {
    maxSourceIdentities: 50,
    maxBytes,
    protectedSourceIdentityKeys: [protectedEvidence.sourceRecord.sourceIdentityKey as string],
  });

  assert.deepEqual(plan.sourceIdsToDelete, [1]);
  assert.deepEqual(plan.segmentIdsToDelete, [11]);
  assert.equal(plan.sourceIdentityKeysToDelete.includes(protectedEvidence.sourceRecord.sourceIdentityKey as string), false);
  assert.equal(plan.skippedPersistentWrite, false);
  assert.ok(plan.finalRetainedBytes <= maxBytes);
  assert.ok(plan.finalRetainedSourceIdentityCount <= 50);
});

test('keeps existing cache intact when protected identities still exceed the budget with incoming', () => {
  const active = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 0, to: 1, content: 'active source' }] },
    baseNormalizeOptions({ bvid: 'BV1Active', cid: 4101, fetchedAt: 1000 }),
  );
  const selected = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 0, to: 1, content: 'selected source' }] },
    baseNormalizeOptions({ bvid: 'BV1Selected', cid: 4102, fetchedAt: 1100 }),
  );
  const evictable = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 0, to: 1, content: 'old unprotected source' }] },
    baseNormalizeOptions({ bvid: 'BV1Evictable', cid: 4103, fetchedAt: 900 }),
  );
  const incoming = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 0, to: 1, content: 'incoming source' }] },
    baseNormalizeOptions({ bvid: 'BV1Incoming', cid: 4104, fetchedAt: 1200 }),
  );
  const existingSources = [
    { ...active.sourceRecord, id: 1 },
    { ...selected.sourceRecord, id: 2 },
    { ...evictable.sourceRecord, id: 3 },
  ];
  const existingSegments = [
    { ...active.segments[0], id: 11 },
    { ...selected.segments[0], id: 12 },
    { ...evictable.segments[0], id: 13 },
  ];

  const plan = planTranscriptEvidenceUpsert(existingSources, existingSegments, incoming, {
    maxSourceIdentities: 2,
    maxBytes: Number.MAX_SAFE_INTEGER,
    protectedSourceIdentityKeys: [
      active.sourceRecord.sourceIdentityKey as string,
      selected.sourceRecord.sourceIdentityKey as string,
    ],
  });

  assert.equal(plan.skippedPersistentWrite, true);
  assert.equal(plan.state.temporary, true);
  assert.deepEqual(plan.sourcesToPut, []);
  assert.deepEqual(plan.segmentsToPut, []);
  assert.deepEqual(plan.sourceIdsToDelete, []);
  assert.deepEqual(plan.segmentIdsToDelete, []);
  assert.deepEqual(plan.sourceIdentityKeysToDelete, []);
  assert.equal(plan.finalRetainedSourceIdentityCount, existingSources.length);
  assert.ok(plan.finalRetainedBytes > 0);
});

test('keeps oversize subtitle source temporary without evicting existing cache', () => {
  const existing = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 0, to: 1, content: 'existing cache' }] },
    baseNormalizeOptions({ bvid: 'BV1Existing', cid: 5001, fetchedAt: 1000 }),
  );
  const oversize = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 0, to: 1, content: 'oversize cache' }] },
    baseNormalizeOptions({ bvid: 'BV1Oversize', cid: 5002, fetchedAt: 2000 }),
  );
  const oversizeBytes = measureTranscriptPersistentBytes(oversize.sourceRecord, oversize.segments);
  const plan = planTranscriptEvidenceUpsert(
    [existing.sourceRecord],
    existing.segments,
    oversize,
    { maxBytes: oversizeBytes - 1 },
  );

  assert.equal(plan.skippedPersistentWrite, true);
  assert.equal(plan.sourcesToPut.length, 0);
  assert.equal(plan.segmentsToPut.length, 0);
  assert.equal(plan.sourceIdsToDelete.length, 0);
  assert.equal(plan.segmentIdsToDelete.length, 0);
  assert.equal(plan.state.active, true);
  assert.equal(plan.state.temporary, true);
  assert.equal(plan.state.persistent, false);
  assert.ok(plan.state.warnings.includes('transcript_source_temporary_oversize'));
});

test('uses persisted source and segment records for byte limit boundary planning', () => {
  const evidence = normalizeBilibiliTranscriptEvidence(
    {
      body: [
        { from: 0, to: 1, content: '边界字幕正文🙂'.repeat(20) },
        { from: 1, to: 2, content: '第二段用于验证真实落库记录大小'.repeat(15) },
      ],
    },
    baseNormalizeOptions({ bvid: 'BV1ByteLimit', cid: 6101, fetchedAt: 9000 }),
  );
  const measured = measureTranscriptPersistentBytes(evidence.sourceRecord, evidence.segments);

  assert.equal(evidence.sourceRecord.serializedBytes, measured);
  assert.ok(measured > 0);

  const maxMinusOne = planTranscriptEvidenceUpsert([], [], evidence, {
    maxBytes: measured - 1,
  });
  assert.equal(maxMinusOne.skippedPersistentWrite, true);
  assert.equal(maxMinusOne.sourcesToPut.length, 0);
  assert.equal(maxMinusOne.segmentsToPut.length, 0);

  const exactMax = planTranscriptEvidenceUpsert([], [], evidence, {
    maxBytes: measured,
  });
  assert.equal(exactMax.skippedPersistentWrite, false);
  assert.equal(measureTranscriptPersistentBytes(exactMax.sourcesToPut[0], exactMax.segmentsToPut), measured);
  assert.ok(measureTranscriptPersistentBytes(exactMax.sourcesToPut[0], exactMax.segmentsToPut) <= measured);

  const maxPlusOne = planTranscriptEvidenceUpsert([], [], evidence, {
    maxBytes: measured + 1,
  });
  assert.equal(maxPlusOne.skippedPersistentWrite, false);
  assert.equal(maxPlusOne.state.active, true);
  assert.ok(CURRENT_VIDEO_TRANSCRIPT_CACHE_MAX_BYTES > measured);
});

test('keeps fake IndexedDB auto-id readback within MAX-1, MAX, and MAX+1 plans', async () => {
  const { db } = await import('../src/background/storage/db.ts');
  db.close();
  await db.delete();
  await db.open();

  try {
    const evidence = normalizeBilibiliTranscriptEvidence(
      {
        body: [
          { from: 0, to: 1, content: '自动主键边界🙂'.repeat(20) },
          { from: 1, to: 2, content: 'fake IndexedDB readback'.repeat(15) },
        ],
      },
      baseNormalizeOptions({ bvid: 'BV1FakeIdbLimit', cid: 6151, fetchedAt: 9050 }),
    );
    const max = measureTranscriptPersistentBytes(evidence.sourceRecord, evidence.segments);
    const maxMinusOne = planTranscriptEvidenceUpsert([], [], evidence, { maxBytes: max - 1 });
    const exactMax = planTranscriptEvidenceUpsert([], [], evidence, { maxBytes: max });
    const maxPlusOne = planTranscriptEvidenceUpsert([], [], evidence, { maxBytes: max + 1 });

    assert.equal(maxMinusOne.skippedPersistentWrite, true);
    assert.equal(exactMax.skippedPersistentWrite, false);
    assert.equal(maxPlusOne.skippedPersistentWrite, false);

    await db.transaction(
      'rw',
      db.currentVideoTranscriptSources,
      db.currentVideoTranscriptSegments,
      async () => {
        await db.currentVideoTranscriptSources.bulkPut(exactMax.sourcesToPut);
        await db.currentVideoTranscriptSegments.bulkPut(exactMax.segmentsToPut);
      },
    );
    const [storedSources, storedSegments] = await Promise.all([
      db.currentVideoTranscriptSources.toArray(),
      db.currentVideoTranscriptSegments.toArray(),
    ]);
    const actualBytes = storedSources.reduce((sum, row) => sum + utf8JsonBytes(row), 0)
      + storedSegments.reduce((sum, row) => sum + utf8JsonBytes(row), 0);

    assert.equal(storedSources.length, 1);
    assert.equal(storedSegments.length, 2);
    assert.equal(typeof storedSources[0].id, 'number');
    assert.ok(storedSegments.every(segment => typeof segment.id === 'number'));
    assert.ok(actualBytes <= max);
    assert.ok(actualBytes <= exactMax.finalRetainedBytes);
    assert.equal(exactMax.finalRetainedSourceIdentityCount, 1);
  } finally {
    db.close();
    await db.delete();
  }
});

test('keeps oversize subtitle body readable only in temporary source memory', () => {
  clearTemporaryCurrentVideoTranscriptCache();
  const oversize = normalizeBilibiliTranscriptEvidence(
    {
      body: [
        { from: 0, to: 3, content: '这段只允许本次临时使用，不能落库。' },
        { from: 3, to: 6, content: '切换来源或清理后必须读不到。' },
      ],
    },
    baseNormalizeOptions({ bvid: 'BV1Temporary', cid: 6201, fetchedAt: 9100 }),
  );
  const measured = measureTranscriptPersistentBytes(oversize.sourceRecord, oversize.segments);
  const plan = planTranscriptEvidenceUpsert([], [], oversize, {
    maxBytes: measured - 1,
  });
  assert.equal(plan.skippedPersistentWrite, true);

  const owner = temporaryOwner(71, oversize);
  assert.equal(putTemporaryCurrentVideoTranscriptEvidence(owner, oversize, 9200).status, 'stored');
  const identity = {
    bvid: 'BV1Temporary',
    cid: 6201,
    page: 1,
    language: 'zh-CN',
    sourceIdentityKey: oversize.sourceRecord.sourceIdentityKey,
    sourceHash: oversize.sourceRecord.sourceHash,
  };
  const state = getTemporaryCurrentVideoTranscriptEvidenceState(owner, identity, 9300);
  const segments = getTemporaryCurrentVideoTranscriptSegments(owner, identity, 9300);

  assert.equal(state.active, true);
  assert.equal(state.temporary, true);
  assert.equal(state.persistent, false);
  assert.equal(segments.length, 2);
  assert.match(segments.map(segment => segment.text).join('\n'), /本次临时使用/);

  const switched = getTemporaryCurrentVideoTranscriptEvidenceState(owner, {
    ...identity,
    sourceIdentityKey: 'primary-text:bilibili_subtitle:BV1Temporary:6201:1:zh-cn:other',
  }, 9400);
  assert.equal(switched.active, false);

  clearTemporaryCurrentVideoTranscriptCache();
  const cleared = getTemporaryCurrentVideoTranscriptSegments(owner, identity, 9500);
  assert.equal(cleared.length, 0);
});

test('rejects late temporary subtitle writes after tab generation is cleared', () => {
  clearTemporaryCurrentVideoTranscriptCache();
  const evidence = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 0, to: 2, content: '迟到的临时字幕不能复活。' }] },
    baseNormalizeOptions({ bvid: 'BV1LateOwner', cid: 6211, fetchedAt: 9520 }),
  );
  const identity = {
    bvid: evidence.sourceRecord.bvid,
    cid: evidence.sourceRecord.cid,
    page: evidence.sourceRecord.page,
    language: evidence.sourceRecord.language,
    sourceIdentityKey: evidence.sourceRecord.sourceIdentityKey,
    sourceHash: evidence.sourceRecord.sourceHash,
  };
  const oldOwner = temporaryOwner(72, evidence);

  clearTemporaryCurrentVideoTranscriptCacheForTab(oldOwner.ownerTabId);
  const returnedSameVideoOwner = temporaryOwner(72, evidence);

  assert.equal(putTemporaryCurrentVideoTranscriptEvidence(oldOwner, evidence, 9530).status, 'invalid_owner');
  assert.equal(getTemporaryCurrentVideoTranscriptSegments(returnedSameVideoOwner, identity, 9540).length, 0);

  assert.equal(putTemporaryCurrentVideoTranscriptEvidence(returnedSameVideoOwner, evidence, 9550).status, 'stored');
  assert.equal(getTemporaryCurrentVideoTranscriptSegments(returnedSameVideoOwner, identity, 9560).length, 1);
});

test('rejects late temporary subtitle writes after clear all invalidates owners', () => {
  clearTemporaryCurrentVideoTranscriptCache();
  const evidence = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 0, to: 2, content: '清理全部后的迟到正文也不能复活。' }] },
    baseNormalizeOptions({ bvid: 'BV1LateClearAll', cid: 6221, fetchedAt: 9570 }),
  );
  const identity = {
    bvid: evidence.sourceRecord.bvid,
    cid: evidence.sourceRecord.cid,
    page: evidence.sourceRecord.page,
    language: evidence.sourceRecord.language,
    sourceIdentityKey: evidence.sourceRecord.sourceIdentityKey,
    sourceHash: evidence.sourceRecord.sourceHash,
  };
  const oldOwner = temporaryOwner(73, evidence);

  clearTemporaryCurrentVideoTranscriptCache();
  const returnedSameVideoOwner = temporaryOwner(73, evidence);

  assert.equal(putTemporaryCurrentVideoTranscriptEvidence(oldOwner, evidence, 9580).status, 'invalid_owner');
  assert.equal(getTemporaryCurrentVideoTranscriptSegments(returnedSameVideoOwner, identity, 9590).length, 0);
});

test('isolates temporary transcript bodies by tab and releases only the navigating tab', () => {
  clearTemporaryCurrentVideoTranscriptCache();
  const evidence = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 0, to: 2, content: '两个标签页不能互相读取这段正文。' }] },
    baseNormalizeOptions({ bvid: 'BV1TwoTabs', cid: 6251, fetchedAt: 9600 }),
  );
  const identity = {
    bvid: evidence.sourceRecord.bvid,
    cid: evidence.sourceRecord.cid,
    page: evidence.sourceRecord.page,
    language: evidence.sourceRecord.language,
    sourceIdentityKey: evidence.sourceRecord.sourceIdentityKey,
    sourceHash: evidence.sourceRecord.sourceHash,
  };
  const tabOne = temporaryOwner(81, evidence);
  const tabTwo = temporaryOwner(82, evidence);

  assert.equal(putTemporaryCurrentVideoTranscriptEvidence(tabOne, evidence, 9700).status, 'stored');
  assert.equal(getTemporaryCurrentVideoTranscriptSegments(tabOne, identity, 9710).length, 1);
  assert.equal(getTemporaryCurrentVideoTranscriptSegments(tabTwo, identity, 9710).length, 0);

  assert.equal(putTemporaryCurrentVideoTranscriptEvidence(tabTwo, evidence, 9720).status, 'stored');
  assert.equal(getTemporaryCurrentVideoTranscriptSegments(tabOne, identity, 9730).length, 1);
  assert.equal(getTemporaryCurrentVideoTranscriptSegments(tabTwo, identity, 9730).length, 1);

  const replacement = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 0, to: 2, content: '同页新正文替换旧的临时来源。' }] },
    baseNormalizeOptions({ bvid: 'BV1TwoTabs', cid: 6251, fetchedAt: 9735 }),
  );
  const replacementIdentity = {
    ...identity,
    sourceIdentityKey: replacement.sourceRecord.sourceIdentityKey,
    sourceHash: replacement.sourceRecord.sourceHash,
  };
  assert.equal(putTemporaryCurrentVideoTranscriptEvidence(tabOne, replacement, 9735).status, 'stored');
  assert.equal(getTemporaryCurrentVideoTranscriptSegments(tabOne, identity, 9736).length, 0);
  assert.equal(getTemporaryCurrentVideoTranscriptSegments(tabOne, replacementIdentity, 9736).length, 1);
  assert.equal(getTemporaryCurrentVideoTranscriptSegments(tabTwo, identity, 9736).length, 1);

  retainTemporaryCurrentVideoTranscriptOwner({
    ownerTabId: tabOne.ownerTabId,
    bvid: 'BV1NextPage',
    cid: 6252,
    page: 2,
  });
  assert.equal(getTemporaryCurrentVideoTranscriptSegments(tabOne, identity, 9740).length, 0);
  assert.equal(getTemporaryCurrentVideoTranscriptSegments(tabTwo, identity, 9740).length, 1);

  clearTemporaryCurrentVideoTranscriptCacheForTab(tabTwo.ownerTabId);
  assert.equal(getTemporaryCurrentVideoTranscriptSegments(tabTwo, identity, 9750).length, 0);

  const returnedTabOne = temporaryOwner(tabOne.ownerTabId, evidence);
  assert.equal(putTemporaryCurrentVideoTranscriptEvidence(returnedTabOne, evidence, 9760).status, 'stored');
  clearTemporaryCurrentVideoTranscriptCache();
  const workerMemoryMissing = getTemporaryCurrentVideoTranscriptEvidenceState(returnedTabOne, identity, 9770);
  assert.equal(workerMemoryMissing.active, false);
  assert.equal(workerMemoryMissing.status, 'missing');
});

test('temporary transcript admission rejects a fifth live owner without evicting existing owners', () => {
  clearTemporaryCurrentVideoTranscriptCache();
  const stored: Array<{
    owner: ReturnType<typeof temporaryOwner>;
    identity: ReturnType<typeof transcriptIdentityFromEvidence>;
  }> = [];

  for (let index = 0; index < CURRENT_VIDEO_TEMPORARY_TRANSCRIPT_MAX_SOURCES; index += 1) {
    const evidence = normalizeBilibiliTranscriptEvidence(
      { body: [{ from: 0, to: 2, content: `保留第 ${index + 1} 个仍打开页面的临时字幕。` }] },
      baseNormalizeOptions({ bvid: `BV1TempLive${index}`, cid: 6300 + index, fetchedAt: 9800 + index }),
    );
    const owner = temporaryOwner(100 + index, evidence);
    assert.equal(putTemporaryCurrentVideoTranscriptEvidence(owner, evidence, 9810 + index).status, 'stored');
    stored.push({ owner, identity: transcriptIdentityFromEvidence(evidence) });
  }

  const fifth = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 0, to: 2, content: '第五个页面不能挤掉仍有效的旧页面。' }] },
    baseNormalizeOptions({ bvid: 'BV1TempLive4', cid: 6304, fetchedAt: 9820 }),
  );
  const fifthOwner = temporaryOwner(104, fifth);
  const rejected = putTemporaryCurrentVideoTranscriptEvidence(fifthOwner, fifth, 9821);
  assert.equal(rejected.status, 'capacity_exceeded');
  assert.equal(rejected.retainedSourceCount, CURRENT_VIDEO_TEMPORARY_TRANSCRIPT_MAX_SOURCES);
  assert.equal(getTemporaryCurrentVideoTranscriptSegments(fifthOwner, transcriptIdentityFromEvidence(fifth), 9822).length, 0);

  for (const entry of stored) {
    assert.equal(getTemporaryCurrentVideoTranscriptSegments(entry.owner, entry.identity, 9823).length, 1);
  }

  clearTemporaryCurrentVideoTranscriptCacheForTab(stored[0].owner.ownerTabId);
  assert.equal(putTemporaryCurrentVideoTranscriptEvidence(fifthOwner, fifth, 9824).status, 'stored');
  assert.equal(getTemporaryCurrentVideoTranscriptSegments(fifthOwner, transcriptIdentityFromEvidence(fifth), 9825).length, 1);
});

test('temporary transcript admission counts shared source identity once across owners', () => {
  clearTemporaryCurrentVideoTranscriptCache();
  const shared = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 0, to: 2, content: '同一字幕身份被两个打开页面复用。' }] },
    baseNormalizeOptions({ bvid: 'BV1TempSharedA', cid: 6501, fetchedAt: 9850 }),
  );
  const sharedIdentity = transcriptIdentityFromEvidence(shared);
  const sharedOwnerOne = temporaryOwner(171, shared);
  const sharedOwnerTwo = temporaryOwner(172, shared);

  assert.equal(putTemporaryCurrentVideoTranscriptEvidence(sharedOwnerOne, shared, 9860).status, 'stored');
  const sharedSecond = putTemporaryCurrentVideoTranscriptEvidence(sharedOwnerTwo, shared, 9861);
  assert.equal(sharedSecond.status, 'stored');
  assert.equal(sharedSecond.retainedSourceCount, 1);

  for (let index = 0; index < CURRENT_VIDEO_TEMPORARY_TRANSCRIPT_MAX_SOURCES - 1; index += 1) {
    const evidence = normalizeBilibiliTranscriptEvidence(
      { body: [{ from: 0, to: 2, content: `第 ${index + 2} 个唯一字幕身份。` }] },
      baseNormalizeOptions({ bvid: `BV1TempUnique${index}`, cid: 6510 + index, fetchedAt: 9862 + index }),
    );
    const owner = temporaryOwner(173 + index, evidence);
    const stored = putTemporaryCurrentVideoTranscriptEvidence(owner, evidence, 9862 + index);
    assert.equal(stored.status, 'stored');
    assert.equal(stored.retainedSourceCount, 2 + index);
  }

  const fifthUnique = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 0, to: 2, content: '第五个唯一字幕身份才应该被拒绝。' }] },
    baseNormalizeOptions({ bvid: 'BV1TempUniqueE', cid: 6520, fetchedAt: 9870 }),
  );
  const fifthOwner = temporaryOwner(180, fifthUnique);
  const rejected = putTemporaryCurrentVideoTranscriptEvidence(fifthOwner, fifthUnique, 9871);
  assert.equal(rejected.status, 'capacity_exceeded');
  assert.equal(rejected.retainedSourceCount, CURRENT_VIDEO_TEMPORARY_TRANSCRIPT_MAX_SOURCES);

  clearTemporaryCurrentVideoTranscriptCacheForTab(sharedOwnerOne.ownerTabId);
  assert.equal(getTemporaryCurrentVideoTranscriptSegments(sharedOwnerTwo, sharedIdentity, 9872).length, 1);
  assert.equal(putTemporaryCurrentVideoTranscriptEvidence(fifthOwner, fifthUnique, 9873).status, 'capacity_exceeded');

  clearTemporaryCurrentVideoTranscriptCacheForTab(sharedOwnerTwo.ownerTabId);
  assert.equal(getTemporaryCurrentVideoTranscriptSegments(sharedOwnerTwo, sharedIdentity, 9874).length, 0);
  assert.equal(putTemporaryCurrentVideoTranscriptEvidence(fifthOwner, fifthUnique, 9875).status, 'stored');
});

test('temporary transcript admission enforces cumulative bytes and single-source byte caps', () => {
  clearTemporaryCurrentVideoTranscriptCache();
  const first = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 0, to: 2, content: '第一份临时字幕'.repeat(32) }] },
    baseNormalizeOptions({ bvid: 'BV1TempBytesA', cid: 6401, fetchedAt: 9900 }),
  );
  const second = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 0, to: 2, content: '第二份临时字幕'.repeat(32) }] },
    baseNormalizeOptions({ bvid: 'BV1TempBytesB', cid: 6402, fetchedAt: 9901 }),
  );
  const firstOwner = temporaryOwner(111, first);
  const secondOwner = temporaryOwner(112, second);
  const firstBytes = measureTranscriptPersistentBytes(first.sourceRecord, first.segments);
  const secondBytes = measureTranscriptPersistentBytes(second.sourceRecord, second.segments);
  const cumulativeLimit = firstBytes + secondBytes - 1;

  assert.equal(putTemporaryCurrentVideoTranscriptEvidence(firstOwner, first, 9910, {
    maxSourceCount: 4,
    maxBytes: cumulativeLimit,
  }).status, 'stored');
  assert.equal(putTemporaryCurrentVideoTranscriptEvidence(secondOwner, second, 9911, {
    maxSourceCount: 4,
    maxBytes: cumulativeLimit,
  }).status, 'capacity_exceeded');
  assert.equal(getTemporaryCurrentVideoTranscriptSegments(firstOwner, transcriptIdentityFromEvidence(first), 9912).length, 1);
  assert.equal(getTemporaryCurrentVideoTranscriptSegments(secondOwner, transcriptIdentityFromEvidence(second), 9912).length, 0);

  const singleTooLarge = putTemporaryCurrentVideoTranscriptEvidence(secondOwner, second, 9913, {
    maxSourceCount: 4,
    maxBytes: secondBytes - 1,
  });
  assert.equal(singleTooLarge.status, 'source_too_large');
  assert.equal(getTemporaryCurrentVideoTranscriptSegments(firstOwner, transcriptIdentityFromEvidence(first), 9914).length, 1);
});

test('temporary transcript byte cap counts shared source identity once across owners', () => {
  clearTemporaryCurrentVideoTranscriptCache();
  const shared = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 0, to: 2, content: '同一字幕身份的正文体积不能因两个页面重复计量。'.repeat(16) }] },
    baseNormalizeOptions({ bvid: 'BV1TempSharedBytes', cid: 6531, fetchedAt: 9950 }),
  );
  const other = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 0, to: 2, content: '另一个唯一字幕身份仍应受总量上限限制。' }] },
    baseNormalizeOptions({ bvid: 'BV1TempSharedBytesB', cid: 6532, fetchedAt: 9951 }),
  );
  const sharedOwnerOne = temporaryOwner(181, shared);
  const sharedOwnerTwo = temporaryOwner(182, shared);
  const otherOwner = temporaryOwner(183, other);
  const sharedBytes = temporaryStoredBytes(shared, 9960);
  const otherBytes = temporaryStoredBytes(other, 9962);

  assert.equal(putTemporaryCurrentVideoTranscriptEvidence(sharedOwnerOne, shared, 9960, {
    maxSourceCount: CURRENT_VIDEO_TEMPORARY_TRANSCRIPT_MAX_SOURCES,
    maxBytes: sharedBytes,
  }).status, 'stored');
  const sharedSecond = putTemporaryCurrentVideoTranscriptEvidence(sharedOwnerTwo, shared, 9961, {
    maxSourceCount: CURRENT_VIDEO_TEMPORARY_TRANSCRIPT_MAX_SOURCES,
    maxBytes: sharedBytes,
  });
  assert.equal(sharedSecond.status, 'stored');
  assert.equal(sharedSecond.retainedBytes, sharedBytes);
  assert.equal(sharedSecond.retainedSourceCount, 1);

  const rejectedOther = putTemporaryCurrentVideoTranscriptEvidence(otherOwner, other, 9962, {
    maxSourceCount: CURRENT_VIDEO_TEMPORARY_TRANSCRIPT_MAX_SOURCES,
    maxBytes: sharedBytes + otherBytes - 1,
  });
  assert.equal(rejectedOther.status, 'capacity_exceeded');
  assert.equal(getTemporaryCurrentVideoTranscriptSegments(sharedOwnerOne, transcriptIdentityFromEvidence(shared), 9963).length, 1);
  assert.equal(getTemporaryCurrentVideoTranscriptSegments(sharedOwnerTwo, transcriptIdentityFromEvidence(shared), 9963).length, 1);
});

test('temporary source_too_large replacement clears only the same owner old body', () => {
  clearTemporaryCurrentVideoTranscriptCache();
  const oldBody = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 0, to: 2, content: '旧临时正文不能在新正文拒绝后复活。' }] },
    baseNormalizeOptions({ bvid: 'BV1TempReplaceLarge', cid: 6451, fetchedAt: 10_300 }),
  );
  const otherBody = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 0, to: 2, content: '另一个页面的临时正文仍然可读。' }] },
    baseNormalizeOptions({ bvid: 'BV1TempReplaceOtherA', cid: 6452, fetchedAt: 10_301 }),
  );
  const replacement = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 0, to: 2, content: '新正文超过单来源临时上限。'.repeat(16) }] },
    baseNormalizeOptions({ bvid: 'BV1TempReplaceLarge', cid: 6451, fetchedAt: 10_302 }),
  );
  const owner = temporaryOwner(121, oldBody);
  const otherOwner = temporaryOwner(122, otherBody);
  const otherBytes = temporaryStoredBytes(otherBody, 10_311);
  const replacementBytes = temporaryStoredBytes(replacement, 10_312);

  assert.equal(putTemporaryCurrentVideoTranscriptEvidence(owner, oldBody, 10_310).status, 'stored');
  assert.equal(putTemporaryCurrentVideoTranscriptEvidence(otherOwner, otherBody, 10_311).status, 'stored');

  const rejected = putTemporaryCurrentVideoTranscriptEvidence(owner, replacement, 10_312, {
    maxSourceCount: CURRENT_VIDEO_TEMPORARY_TRANSCRIPT_MAX_SOURCES,
    maxBytes: replacementBytes - 1,
  });

  assert.equal(rejected.status, 'source_too_large');
  assert.equal(rejected.sourceBytes, replacementBytes);
  assert.equal(rejected.retainedSourceCount, 1);
  assert.equal(rejected.retainedBytes, otherBytes);
  assert.equal(getTemporaryCurrentVideoTranscriptSegments(owner, {
    bvid: oldBody.sourceRecord.bvid,
    cid: oldBody.sourceRecord.cid,
    page: oldBody.sourceRecord.page,
    language: oldBody.sourceRecord.language,
  }, 10_313).length, 0);
  assert.equal(getTemporaryCurrentVideoTranscriptSegments(otherOwner, transcriptIdentityFromEvidence(otherBody), 10_313).length, 1);
});

test('temporary capacity_exceeded replacement clears only the same owner old body', () => {
  clearTemporaryCurrentVideoTranscriptCache();
  const oldBody = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 0, to: 2, content: '旧临时正文不能在容量拒绝后复活。' }] },
    baseNormalizeOptions({ bvid: 'BV1TempReplaceCap', cid: 6461, fetchedAt: 10_400 }),
  );
  const otherBody = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 0, to: 2, content: '容量拒绝不能驱逐这个仍有效页面。'.repeat(10) }] },
    baseNormalizeOptions({ bvid: 'BV1TempReplaceOtherB', cid: 6462, fetchedAt: 10_401 }),
  );
  const replacement = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 0, to: 2, content: '新正文单独可放入，但加上其他页面会超过总量。'.repeat(8) }] },
    baseNormalizeOptions({ bvid: 'BV1TempReplaceCap', cid: 6461, fetchedAt: 10_402 }),
  );
  const owner = temporaryOwner(123, oldBody);
  const otherOwner = temporaryOwner(124, otherBody);
  const otherBytes = temporaryStoredBytes(otherBody, 10_411);
  const replacementBytes = temporaryStoredBytes(replacement, 10_412);
  const maxBytes = replacementBytes + Math.max(1, Math.floor(otherBytes / 2));

  assert.ok(replacementBytes <= maxBytes);
  assert.ok(otherBytes + replacementBytes > maxBytes);
  assert.equal(putTemporaryCurrentVideoTranscriptEvidence(owner, oldBody, 10_410).status, 'stored');
  assert.equal(putTemporaryCurrentVideoTranscriptEvidence(otherOwner, otherBody, 10_411).status, 'stored');

  const rejected = putTemporaryCurrentVideoTranscriptEvidence(owner, replacement, 10_412, {
    maxSourceCount: CURRENT_VIDEO_TEMPORARY_TRANSCRIPT_MAX_SOURCES,
    maxBytes,
  });

  assert.equal(rejected.status, 'capacity_exceeded');
  assert.equal(rejected.sourceBytes, replacementBytes);
  assert.equal(rejected.retainedSourceCount, 1);
  assert.equal(rejected.retainedBytes, otherBytes);
  assert.equal(getTemporaryCurrentVideoTranscriptSegments(owner, {
    bvid: oldBody.sourceRecord.bvid,
    cid: oldBody.sourceRecord.cid,
    page: oldBody.sourceRecord.page,
    language: oldBody.sourceRecord.language,
  }, 10_413).length, 0);
  assert.equal(getTemporaryCurrentVideoTranscriptSegments(otherOwner, transcriptIdentityFromEvidence(otherBody), 10_413).length, 1);
});

test('owner broad reads prefer active temporary body over stale persistent body', async () => {
  await withFreshTranscriptRepo(async (repo) => {
    const oldBody = normalizeBilibiliTranscriptEvidence(
      { body: [{ from: 0, to: 2, content: 'old persistent body' }] },
      baseNormalizeOptions({ bvid: 'BV1OwnerTempPref', cid: 6471, fetchedAt: 10_500 }),
    );
    const currentBody = normalizeBilibiliTranscriptEvidence(
      { body: [{ from: 0, to: 2, content: 'new temporary body' }] },
      baseNormalizeOptions({ bvid: 'BV1OwnerTempPref', cid: 6471, fetchedAt: 10_501 }),
    );
    const owner = temporaryOwner(131, currentBody);
    const otherOwner = temporaryOwner(132, oldBody);

    await repo.upsertCurrentVideoTranscriptEvidence(oldBody);
    assert.equal(putTemporaryCurrentVideoTranscriptEvidence(owner, currentBody, 10_510).status, 'stored');

    const ownerState = await repo.getCurrentVideoTranscriptEvidenceState({
      bvid: oldBody.sourceRecord.bvid,
      cid: oldBody.sourceRecord.cid,
      page: oldBody.sourceRecord.page,
    }, 10_520, owner);
    assert.equal(ownerState.active, true);
    assert.equal(ownerState.sourceIdentityKey, currentBody.sourceRecord.sourceIdentityKey);
    assert.equal(ownerState.temporary, true);

    const ownerSegments = await repo.getCurrentVideoTranscriptSegments({
      bvid: oldBody.sourceRecord.bvid,
      cid: oldBody.sourceRecord.cid,
      page: oldBody.sourceRecord.page,
      language: ownerState.language,
      sourceIdentityKey: ownerState.sourceIdentityKey,
      sourceHash: ownerState.sourceHash,
    }, owner);
    assert.deepEqual(ownerSegments.map(segment => segment.text), ['new temporary body']);

    const otherState = await repo.getCurrentVideoTranscriptEvidenceState({
      bvid: oldBody.sourceRecord.bvid,
      cid: oldBody.sourceRecord.cid,
      page: oldBody.sourceRecord.page,
    }, 10_530, otherOwner);
    assert.equal(otherState.active, true);
    assert.equal(otherState.sourceIdentityKey, oldBody.sourceRecord.sourceIdentityKey);
    assert.equal(otherState.persistent, true);
  });
});

test('repo fails closed when an explicit temporary owner was invalidated before read', async () => {
  await withFreshTranscriptRepo(async (repo) => {
    const persistentA = normalizeBilibiliTranscriptEvidence(
      { body: [{ from: 0, to: 2, content: 'persistent A before tab switch' }] },
      baseNormalizeOptions({ bvid: 'BV1InvalidOwnerA', cid: 6475, fetchedAt: 10_540 }),
    );
    const videoB = normalizeBilibiliTranscriptEvidence(
      { body: [{ from: 0, to: 2, content: 'video B after tab switch' }] },
      baseNormalizeOptions({ bvid: 'BV1InvalidOwnerB', cid: 6476, fetchedAt: 10_541 }),
    );
    const oldOwnerA = temporaryOwner(700, persistentA);

    await repo.upsertCurrentVideoTranscriptEvidence(persistentA);
    retainTemporaryCurrentVideoTranscriptOwner({
      ownerTabId: oldOwnerA.ownerTabId,
      bvid: videoB.sourceRecord.bvid,
      cid: videoB.sourceRecord.cid,
      page: videoB.sourceRecord.page,
    });

    const broadState = await repo.getCurrentVideoTranscriptEvidenceState({
      bvid: persistentA.sourceRecord.bvid,
      cid: persistentA.sourceRecord.cid,
      page: persistentA.sourceRecord.page,
    }, 10_550, oldOwnerA);
    assert.equal(broadState.active, false);
    assert.equal(broadState.reason, 'temporary_transcript_current_source_unavailable');
    assert.equal((await repo.getCurrentVideoTranscriptSegments({
      bvid: persistentA.sourceRecord.bvid,
      cid: persistentA.sourceRecord.cid,
      page: persistentA.sourceRecord.page,
    }, oldOwnerA)).length, 0);

    const explicitState = await repo.getCurrentVideoTranscriptEvidenceState(
      transcriptIdentityFromEvidence(persistentA),
      10_551,
      oldOwnerA,
    );
    assert.equal(explicitState.active, false);
    assert.equal(explicitState.reason, 'temporary_transcript_current_source_unavailable');
    assert.equal((await repo.getCurrentVideoTranscriptSegments(
      transcriptIdentityFromEvidence(persistentA),
      oldOwnerA,
    )).length, 0);

    const { db } = await import('../src/background/storage/db.ts');
    const sourceAfterInvalidRead = await db.currentVideoTranscriptSources
      .where('identityKey')
      .equals(persistentA.sourceRecord.identityKey)
      .first();
    assert.equal(sourceAfterInvalidRead?.lastAccessedAt, persistentA.sourceRecord.lastAccessedAt);

    const noOwnerState = await repo.getCurrentVideoTranscriptEvidenceState({
      bvid: persistentA.sourceRecord.bvid,
      cid: persistentA.sourceRecord.cid,
      page: persistentA.sourceRecord.page,
    }, 10_552);
    assert.equal(noOwnerState.active, true);
    assert.equal(noOwnerState.sourceIdentityKey, persistentA.sourceRecord.sourceIdentityKey);
    assert.equal(noOwnerState.persistent, true);

    const validOwnerA = temporaryOwner(701, persistentA);
    const validOwnerState = await repo.getCurrentVideoTranscriptEvidenceState({
      bvid: persistentA.sourceRecord.bvid,
      cid: persistentA.sourceRecord.cid,
      page: persistentA.sourceRecord.page,
    }, 10_553, validOwnerA);
    assert.equal(validOwnerState.active, true);
    assert.equal(validOwnerState.sourceIdentityKey, persistentA.sourceRecord.sourceIdentityKey);
    assert.deepEqual((await repo.getCurrentVideoTranscriptSegments(
      transcriptIdentityFromEvidence(persistentA),
      validOwnerA,
    )).map(segment => segment.text), ['persistent A before tab switch']);
  });
});

test('repo fails closed when owner changes while evidence state query is in flight', async () => {
  await withFreshTranscriptRepo(async (repo) => {
    const persistentA = normalizeBilibiliTranscriptEvidence(
      { body: [{ from: 0, to: 2, content: 'persistent A during state race' }] },
      baseNormalizeOptions({ bvid: 'BV1StateRaceA', cid: 6501, fetchedAt: 10_900 }),
    );
    const videoB = normalizeBilibiliTranscriptEvidence(
      { body: [{ from: 0, to: 2, content: 'video B during state race' }] },
      baseNormalizeOptions({ bvid: 'BV1StateRaceB', cid: 6502, fetchedAt: 10_901 }),
    );
    const owner = temporaryOwner(710, persistentA);

    await repo.upsertCurrentVideoTranscriptEvidence(persistentA);

    const { db } = await import('../src/background/storage/db.ts');
    const { result: state, switched } = await withOwnerSwitchAfterSourceBvidRead(
      db,
      persistentA.sourceRecord.bvid,
      () => moveTemporaryOwnerToEvidence(owner, videoB),
      () => repo.getCurrentVideoTranscriptEvidenceState({
        bvid: persistentA.sourceRecord.bvid,
        cid: persistentA.sourceRecord.cid,
        page: persistentA.sourceRecord.page,
      }, 10_910, owner),
    );

    assert.equal(switched, true);
    assert.equal(state.active, false);
    assert.equal(state.reason, 'temporary_transcript_current_source_unavailable');

    const sourceAfterRace = await db.currentVideoTranscriptSources
      .where('identityKey')
      .equals(persistentA.sourceRecord.identityKey)
      .first();
    assert.equal(sourceAfterRace?.lastAccessedAt, persistentA.sourceRecord.lastAccessedAt);
  });
});

test('repo returns no segments when owner changes while segment query is in flight', async () => {
  await withFreshTranscriptRepo(async (repo) => {
    const persistentA = normalizeBilibiliTranscriptEvidence(
      { body: [{ from: 0, to: 2, content: 'persistent A during segment race' }] },
      baseNormalizeOptions({ bvid: 'BV1SegmentRaceA', cid: 6503, fetchedAt: 10_920 }),
    );
    const videoB = normalizeBilibiliTranscriptEvidence(
      { body: [{ from: 0, to: 2, content: 'video B during segment race' }] },
      baseNormalizeOptions({ bvid: 'BV1SegmentRaceB', cid: 6504, fetchedAt: 10_921 }),
    );
    const owner = temporaryOwner(711, persistentA);

    await repo.upsertCurrentVideoTranscriptEvidence(persistentA);

    const { db } = await import('../src/background/storage/db.ts');
    const { result: segments, switched } = await withOwnerSwitchAfterSegmentIdentityRead(
      db,
      {
        bvid: persistentA.sourceRecord.bvid,
        cid: persistentA.sourceRecord.cid,
        page: persistentA.sourceRecord.page,
      },
      () => moveTemporaryOwnerToEvidence(owner, videoB),
      () => repo.getCurrentVideoTranscriptSegments(transcriptIdentityFromEvidence(persistentA), owner),
    );

    assert.equal(switched, true);
    assert.deepEqual(segments, []);
  });
});

test('repo fails closed when owner changes while persistent touch is in flight', async () => {
  await withFreshTranscriptRepo(async (repo) => {
    const persistentA = normalizeBilibiliTranscriptEvidence(
      { body: [{ from: 0, to: 2, content: 'persistent A during touch race' }] },
      baseNormalizeOptions({ bvid: 'BV1TouchRaceA', cid: 6505, fetchedAt: 10_930 }),
    );
    const videoB = normalizeBilibiliTranscriptEvidence(
      { body: [{ from: 0, to: 2, content: 'video B during touch race' }] },
      baseNormalizeOptions({ bvid: 'BV1TouchRaceB', cid: 6506, fetchedAt: 10_931 }),
    );
    const owner = temporaryOwner(712, persistentA);
    const sourceIdentityKey = persistentA.sourceRecord.sourceIdentityKey;
    assert.ok(sourceIdentityKey);

    await repo.upsertCurrentVideoTranscriptEvidence(persistentA);

    const { db } = await import('../src/background/storage/db.ts');
    const { result: state, switched } = await withOwnerSwitchBeforeSourceTouch(
      db,
      sourceIdentityKey,
      () => moveTemporaryOwnerToEvidence(owner, videoB),
      () => repo.getCurrentVideoTranscriptEvidenceState({
        bvid: persistentA.sourceRecord.bvid,
        cid: persistentA.sourceRecord.cid,
        page: persistentA.sourceRecord.page,
      }, 10_940, owner),
    );

    assert.equal(switched, true);
    assert.equal(state.active, false);
    assert.equal(state.reason, 'temporary_transcript_current_source_unavailable');

    const sourceAfterRace = await db.currentVideoTranscriptSources
      .where('identityKey')
      .equals(persistentA.sourceRecord.identityKey)
      .first();
    assert.equal(sourceAfterRace?.lastAccessedAt, persistentA.sourceRecord.lastAccessedAt);
  });
});

test('repo fails closed when an explicit temporary owner belongs to another video', async () => {
  await withFreshTranscriptRepo(async (repo) => {
    const persistentA = normalizeBilibiliTranscriptEvidence(
      { body: [{ from: 0, to: 2, content: 'persistent A before owner mismatch' }] },
      baseNormalizeOptions({ bvid: 'BV1OwnerMismatchA', cid: 6477, fetchedAt: 10_560 }),
    );
    const videoB = normalizeBilibiliTranscriptEvidence(
      { body: [{ from: 0, to: 2, content: 'valid owner belongs to B' }] },
      baseNormalizeOptions({ bvid: 'BV1OwnerMismatchB', cid: 6478, fetchedAt: 10_561 }),
    );
    const ownerB = temporaryOwner(702, videoB);

    await repo.upsertCurrentVideoTranscriptEvidence(persistentA);

    const broadState = await repo.getCurrentVideoTranscriptEvidenceState({
      bvid: persistentA.sourceRecord.bvid,
      cid: persistentA.sourceRecord.cid,
      page: persistentA.sourceRecord.page,
    }, 10_570, ownerB);
    assert.equal(broadState.active, false);
    assert.equal(broadState.reason, 'temporary_transcript_current_source_unavailable');
    assert.equal((await repo.getCurrentVideoTranscriptSegments({
      bvid: persistentA.sourceRecord.bvid,
      cid: persistentA.sourceRecord.cid,
      page: persistentA.sourceRecord.page,
    }, ownerB)).length, 0);

    const explicitState = await repo.getCurrentVideoTranscriptEvidenceState(
      transcriptIdentityFromEvidence(persistentA),
      10_571,
      ownerB,
    );
    assert.equal(explicitState.active, false);
    assert.equal(explicitState.reason, 'temporary_transcript_current_source_unavailable');
    assert.equal((await repo.getCurrentVideoTranscriptSegments(
      transcriptIdentityFromEvidence(persistentA),
      ownerB,
    )).length, 0);

    const noOwnerState = await repo.getCurrentVideoTranscriptEvidenceState({
      bvid: persistentA.sourceRecord.bvid,
      cid: persistentA.sourceRecord.cid,
      page: persistentA.sourceRecord.page,
    }, 10_572);
    assert.equal(noOwnerState.active, true);
    assert.equal(noOwnerState.sourceIdentityKey, persistentA.sourceRecord.sourceIdentityKey);
  });
});

test('owner rejected source_too_large marker blocks stale persistent fallback', async () => {
  await assertOwnerRejectedSourceBlocksPersistentFallback('source_too_large');
});

test('owner rejected capacity_exceeded marker blocks stale persistent fallback', async () => {
  await assertOwnerRejectedSourceBlocksPersistentFallback('capacity_exceeded');
});

test('owner current-source marker may be satisfied by exact persistent body', async () => {
  await withFreshTranscriptRepo(async (repo) => {
    const oldBody = normalizeBilibiliTranscriptEvidence(
      { body: [{ from: 0, to: 2, content: 'old exact persistent body' }] },
      baseNormalizeOptions({ bvid: 'BV1OwnerPersistB', cid: 6481, fetchedAt: 10_700 }),
    );
    const currentBody = normalizeBilibiliTranscriptEvidence(
      { body: [{ from: 0, to: 2, content: 'new exact persistent body' }] },
      baseNormalizeOptions({ bvid: 'BV1OwnerPersistB', cid: 6481, fetchedAt: 10_701 }),
    );
    const owner = temporaryOwner(151, currentBody);

    await repo.upsertCurrentVideoTranscriptEvidence(oldBody);
    await repo.upsertCurrentVideoTranscriptEvidence(currentBody, { temporaryOwner: owner });

    const broadState = await repo.getCurrentVideoTranscriptEvidenceState({
      bvid: oldBody.sourceRecord.bvid,
      cid: oldBody.sourceRecord.cid,
      page: oldBody.sourceRecord.page,
    }, 10_710, owner);
    assert.equal(broadState.active, true);
    assert.equal(broadState.sourceIdentityKey, currentBody.sourceRecord.sourceIdentityKey);
    assert.equal(broadState.persistent, true);

    const explicitOld = await repo.getCurrentVideoTranscriptEvidenceState(
      transcriptIdentityFromEvidence(oldBody),
      10_711,
      owner,
    );
    assert.equal(explicitOld.active, false);
    assert.equal(explicitOld.reason, 'requested_transcript_identity_not_current');
    assert.equal((await repo.getCurrentVideoTranscriptSegments(
      transcriptIdentityFromEvidence(oldBody),
      owner,
    )).length, 0);
  });
});

test('rejected owner marker may use exact persistent current body without reviving old body', async () => {
  await withFreshTranscriptRepo(async (repo) => {
    const oldBody = normalizeBilibiliTranscriptEvidence(
      { body: [{ from: 0, to: 2, content: 'old body before exact persistent current' }] },
      baseNormalizeOptions({ bvid: 'BV1RejectExactB', cid: 6482, fetchedAt: 10_750 }),
    );
    const currentBody = normalizeBilibiliTranscriptEvidence(
      { body: [{ from: 0, to: 2, content: 'already persisted current body' }] },
      baseNormalizeOptions({ bvid: 'BV1RejectExactB', cid: 6482, fetchedAt: 10_751 }),
    );
    const owner = temporaryOwner(152, currentBody);
    const otherOwner = temporaryOwner(153, oldBody);
    const sourceBytes = temporaryStoredBytes(currentBody, 10_760);

    await repo.upsertCurrentVideoTranscriptEvidence(oldBody);
    await repo.upsertCurrentVideoTranscriptEvidence(currentBody);
    assert.equal(putTemporaryCurrentVideoTranscriptEvidence(owner, currentBody, 10_760, {
      maxSourceCount: CURRENT_VIDEO_TEMPORARY_TRANSCRIPT_MAX_SOURCES,
      maxBytes: sourceBytes - 1,
    }).status, 'source_too_large');

    const ownerBroad = await repo.getCurrentVideoTranscriptEvidenceState({
      bvid: oldBody.sourceRecord.bvid,
      cid: oldBody.sourceRecord.cid,
      page: oldBody.sourceRecord.page,
    }, 10_761, owner);
    assert.equal(ownerBroad.active, true);
    assert.equal(ownerBroad.sourceIdentityKey, currentBody.sourceRecord.sourceIdentityKey);
    assert.equal(ownerBroad.persistent, true);

    const explicitOld = await repo.getCurrentVideoTranscriptEvidenceState(
      transcriptIdentityFromEvidence(oldBody),
      10_762,
      owner,
    );
    assert.equal(explicitOld.active, false);
    assert.equal(explicitOld.reason, 'temporary_transcript_source_too_large');

    const otherExplicitOld = await repo.getCurrentVideoTranscriptEvidenceState(
      transcriptIdentityFromEvidence(oldBody),
      10_763,
      otherOwner,
    );
    assert.equal(otherExplicitOld.active, true);
    assert.equal(otherExplicitOld.sourceIdentityKey, oldBody.sourceRecord.sourceIdentityKey);
  });
});

test('successful current-source write and owner release clear stale rejection marker', async () => {
  await withFreshTranscriptRepo(async (repo) => {
    const oldBody = normalizeBilibiliTranscriptEvidence(
      { body: [{ from: 0, to: 2, content: 'old marker release body' }] },
      baseNormalizeOptions({ bvid: 'BV1MarkerRelease', cid: 6491, fetchedAt: 10_800 }),
    );
    const currentBody = normalizeBilibiliTranscriptEvidence(
      { body: [{ from: 0, to: 2, content: 'new marker release body' }] },
      baseNormalizeOptions({ bvid: 'BV1MarkerRelease', cid: 6491, fetchedAt: 10_801 }),
    );
    const owner = temporaryOwner(161, currentBody);
    const sourceBytes = temporaryStoredBytes(currentBody, 10_810);

    await repo.upsertCurrentVideoTranscriptEvidence(oldBody);
    assert.equal(putTemporaryCurrentVideoTranscriptEvidence(owner, currentBody, 10_810, {
      maxSourceCount: CURRENT_VIDEO_TEMPORARY_TRANSCRIPT_MAX_SOURCES,
      maxBytes: sourceBytes - 1,
    }).status, 'source_too_large');
    assert.equal((await repo.getCurrentVideoTranscriptEvidenceState({
      bvid: oldBody.sourceRecord.bvid,
      cid: oldBody.sourceRecord.cid,
      page: oldBody.sourceRecord.page,
    }, 10_811, owner)).reason, 'temporary_transcript_source_too_large');

    await repo.upsertCurrentVideoTranscriptEvidence(currentBody, { temporaryOwner: owner });
    const resolved = await repo.getCurrentVideoTranscriptEvidenceState({
      bvid: oldBody.sourceRecord.bvid,
      cid: oldBody.sourceRecord.cid,
      page: oldBody.sourceRecord.page,
    }, 10_812, owner);
    assert.equal(resolved.active, true);
    assert.equal(resolved.sourceIdentityKey, currentBody.sourceRecord.sourceIdentityKey);

    retainTemporaryCurrentVideoTranscriptOwner({
      ownerTabId: owner.ownerTabId,
      bvid: 'BV1MarkerOther',
      cid: 6492,
      page: 1,
    });
    const returnedOwner = temporaryOwner(owner.ownerTabId, oldBody);
    const explicitOldAfterNavigation = await repo.getCurrentVideoTranscriptEvidenceState(
      transcriptIdentityFromEvidence(oldBody),
      10_813,
      returnedOwner,
    );
    assert.equal(explicitOldAfterNavigation.active, true);
    assert.equal(explicitOldAfterNavigation.sourceIdentityKey, oldBody.sourceRecord.sourceIdentityKey);

    const ownerToClear = temporaryOwner(162, currentBody);
    assert.equal(putTemporaryCurrentVideoTranscriptEvidence(ownerToClear, currentBody, 10_814, {
      maxSourceCount: CURRENT_VIDEO_TEMPORARY_TRANSCRIPT_MAX_SOURCES,
      maxBytes: sourceBytes - 1,
    }).status, 'source_too_large');
    clearTemporaryCurrentVideoTranscriptCacheForTab(ownerToClear.ownerTabId);
    const afterClearOwner = temporaryOwner(ownerToClear.ownerTabId, oldBody);
    const explicitOldAfterClear = await repo.getCurrentVideoTranscriptEvidenceState(
      transcriptIdentityFromEvidence(oldBody),
      10_815,
      afterClearOwner,
    );
    assert.equal(explicitOldAfterClear.active, true);
    assert.equal(explicitOldAfterClear.sourceIdentityKey, oldBody.sourceRecord.sourceIdentityKey);
  });
});

test('repo fails closed and skips owner current-source marker when clear generation changes after persistent commit', async () => {
  await withFreshTranscriptRepo(async (repo) => {
    const oldBody = normalizeBilibiliTranscriptEvidence(
      { body: [{ from: 0, to: 2, content: 'old body before post commit clear' }] },
      baseNormalizeOptions({ bvid: 'BV1PostCommitClear', cid: 6493, fetchedAt: 10_820 }),
    );
    const currentBody = normalizeBilibiliTranscriptEvidence(
      { body: [{ from: 0, to: 2, content: 'current body persisted before marker' }] },
      baseNormalizeOptions({ bvid: 'BV1PostCommitClear', cid: 6493, fetchedAt: 10_821 }),
    );
    const owner = temporaryOwner(163, currentBody);

    await repo.upsertCurrentVideoTranscriptEvidence(oldBody);

    const { db } = await import('../src/background/storage/db.ts');
    const originalTransaction = db.transaction;
    const runOriginalTransaction = originalTransaction.bind(db) as (...transactionArgs: unknown[]) => Promise<unknown>;
    let clearInjected = false;
    db.transaction = (async (...args: unknown[]) => {
      const result = await runOriginalTransaction(...args);
      if (!clearInjected) {
        clearInjected = true;
        await runCurrentVideoTranscriptClearCoordinator(async () => undefined);
      }
      return result;
    }) as typeof db.transaction;

    try {
      const currentState = await repo.upsertCurrentVideoTranscriptEvidence(currentBody, {
        temporaryOwner: owner,
      });
      assert.equal(clearInjected, true);
      assert.equal(currentState.active, false);
      assert.equal(currentState.reason, 'transcript_cache_cleared_during_request');
    } finally {
      db.transaction = originalTransaction;
    }

    const exactCurrent = await repo.getCurrentVideoTranscriptEvidenceState(
      transcriptIdentityFromEvidence(currentBody),
      10_822,
      owner,
    );
    assert.equal(exactCurrent.active, true);
    assert.equal(exactCurrent.sourceIdentityKey, currentBody.sourceRecord.sourceIdentityKey);

    const explicitOld = await repo.getCurrentVideoTranscriptEvidenceState(
      transcriptIdentityFromEvidence(oldBody),
      10_823,
      owner,
    );
    assert.equal(explicitOld.active, true);
    assert.equal(explicitOld.sourceIdentityKey, oldBody.sourceRecord.sourceIdentityKey);
  });
});

test('repo fails closed when temporary owner changes after persistent commit', async () => {
  await withFreshTranscriptRepo(async (repo) => {
    const oldBody = normalizeBilibiliTranscriptEvidence(
      { body: [{ from: 0, to: 2, content: 'old body before post commit owner switch' }] },
      baseNormalizeOptions({ bvid: 'BV1PostOwnerSwitch', cid: 6494, fetchedAt: 10_830 }),
    );
    const currentBody = normalizeBilibiliTranscriptEvidence(
      { body: [{ from: 0, to: 2, content: 'current body persisted before owner invalidation' }] },
      baseNormalizeOptions({ bvid: 'BV1PostOwnerSwitch', cid: 6494, fetchedAt: 10_831 }),
    );
    const owner = temporaryOwner(164, currentBody);

    await repo.upsertCurrentVideoTranscriptEvidence(oldBody);

    const { db } = await import('../src/background/storage/db.ts');
    const originalTransaction = db.transaction;
    const runOriginalTransaction = originalTransaction.bind(db) as (...transactionArgs: unknown[]) => Promise<unknown>;
    let ownerSwitched = false;
    db.transaction = (async (...args: unknown[]) => {
      const result = await runOriginalTransaction(...args);
      if (!ownerSwitched) {
        ownerSwitched = true;
        retainTemporaryCurrentVideoTranscriptOwner({
          ownerTabId: owner.ownerTabId,
          bvid: 'BV1PostOwnerOther',
          cid: 6495,
          page: 1,
        });
      }
      return result;
    }) as typeof db.transaction;

    try {
      const currentState = await repo.upsertCurrentVideoTranscriptEvidence(currentBody, {
        temporaryOwner: owner,
      });
      assert.equal(ownerSwitched, true);
      assert.equal(currentState.active, false);
      assert.equal(currentState.reason, 'temporary_transcript_owner_missing');
    } finally {
      db.transaction = originalTransaction;
    }

    const returnedOwner = temporaryOwner(owner.ownerTabId, oldBody);
    const explicitOld = await repo.getCurrentVideoTranscriptEvidenceState(
      transcriptIdentityFromEvidence(oldBody),
      10_832,
      returnedOwner,
    );
    assert.equal(explicitOld.active, true);
    assert.equal(explicitOld.sourceIdentityKey, oldBody.sourceRecord.sourceIdentityKey);
  });
});

test('Dexie 0.12 subtitle cache upgrade clears only transcript tables transactionally', async () => {
  const tables = {
    currentVideoTranscriptSources: [{ identityKey: 'legacy-source' }],
    currentVideoTranscriptSegments: [{ segmentId: 'legacy-segment' }],
    watchHistory: [{ id: 1 }],
    favoriteItems: [{ id: 2 }],
  };
  const cleared: string[] = [];
  await clearLegacyCurrentVideoTranscriptCache({
    table(name) {
      return {
        clear: async () => {
          cleared.push(name);
          tables[name] = [];
        },
      };
    },
  });

  assert.deepEqual(cleared, ['currentVideoTranscriptSegments', 'currentVideoTranscriptSources']);
  assert.deepEqual(tables.currentVideoTranscriptSources, []);
  assert.deepEqual(tables.currentVideoTranscriptSegments, []);
  assert.deepEqual(tables.watchHistory, [{ id: 1 }]);
  assert.deepEqual(tables.favoriteItems, [{ id: 2 }]);
});

test('real Dexie v9 to current upgrade clears legacy transcript rows and adds 0.13 tables', async () => {
  const { BiliAnalyticsDB } = await import('../src/background/storage/db.ts');
  const dbName = uniqueTestDbName('v9-v13');
  const legacy = new Dexie(dbName);
  legacy.version(9).stores(dexieV9Stores());
  await legacy.open();

  try {
    const legacyEvidence = normalizeBilibiliTranscriptEvidence(
      { body: [{ from: 0, to: 2, content: 'legacy transcript body must be cleared' }] },
      baseNormalizeOptions({ bvid: 'BV1RealV9Clear', cid: 6611, fetchedAt: 10_300 }),
    );
    await legacy.table('currentVideoTranscriptSources').bulkPut([legacyEvidence.sourceRecord]);
    await legacy.table('currentVideoTranscriptSegments').bulkPut(legacyEvidence.segments);
    await legacy.table('watchHistory').add(watchHistoryRecord('BV1MigrationKeep'));
    await legacy.table('favoriteItems').add(favoriteItemRecord('migration-favorite', 'BV1FavoriteKeep'));
    await legacy.table('dynamicBillItems').add(dynamicBillItemRecord('migration-dynamic-bill'));
  } finally {
    legacy.close();
  }

  const upgraded = new BiliAnalyticsDB(dbName);
  try {
    await upgraded.open();

    assert.equal(upgraded.verno, 14);
    assert.equal(await upgraded.lgAssets.count(), 0);
    assert.equal(await upgraded.lgMeta.count(), 0);
    assert.equal(await upgraded.currentVideoTranscriptSources.count(), 0);
    assert.equal(await upgraded.currentVideoTranscriptSegments.count(), 0);
    assert.equal((await upgraded.watchHistory.where('bvid').equals('BV1MigrationKeep').first())?.title, 'Kept history BV1MigrationKeep');
    assert.equal((await upgraded.favoriteItems.where('itemKey').equals('migration-favorite').first())?.bvid, 'BV1FavoriteKeep');
    assert.equal((await upgraded.dynamicBillItems.where('billKey').equals('migration-dynamic-bill').first())?.status, 'unopened');
    assert.equal(await upgraded.currentVideoTranscriptSources.where('sourceIdentityKey').equals('missing').count(), 0);
    assert.equal(await upgraded.currentVideoTranscriptSegments.where('sourceIdentityKey').equals('missing').count(), 0);
    assert.equal(await upgraded.dynamicBillFeedbackActions.count(), 0);
    assert.equal(await upgraded.dynamicBillCreatorFeedbackCounts.count(), 0);
    assert.equal(await upgraded.dynamicBillCreatorReviewPrompts.count(), 0);
    assert.equal(await upgraded.currentVideoSummaryHighlights.count(), 0);
    assert.equal(await upgraded.currentVideoQaSessions.count(), 0);
  } finally {
    upgraded.close();
    await Dexie.delete(dbName);
  }
});

test('production current-video subtitle clear removes source-only records and transcript bodies only', async () => {
  const { db } = await import('../src/background/storage/db.ts');
  const { upsertCurrentVideoTranscriptEvidence } = await import('../src/background/storage/current-video-transcript-repo.ts');
  const { clearCurrentVideoSubtitleCache } = await import('../src/background/storage/local-data-privacy-repo.ts');
  const { getRegisteredLocalDataCategories } = await import('../src/background/storage/local-data-category-registry.ts');
  db.close();
  await db.delete();
  await db.open();
  clearTemporaryCurrentVideoTranscriptCache();

  try {
    const persistent = normalizeBilibiliTranscriptEvidence(
      { body: [{ from: 0, to: 2, content: 'persistent subtitle body must be cleared' }] },
      baseNormalizeOptions({ bvid: 'BV1ProductionClear', cid: 6621, fetchedAt: 10_400 }),
    );
    const temporary = normalizeBilibiliTranscriptEvidence(
      { body: [{ from: 2, to: 4, content: 'temporary subtitle body must be cleared' }] },
      baseNormalizeOptions({ bvid: 'BV1ProductionTemp', cid: 6622, fetchedAt: 10_401 }),
    );
    const sourceOnly = normalizeBilibiliTranscriptEvidence(
      { body: [] },
      baseNormalizeOptions({ bvid: 'BV1ProductionEmpty', cid: 6623, fetchedAt: 10_402 }),
    );
    await upsertCurrentVideoTranscriptEvidence(persistent);
    await upsertCurrentVideoTranscriptEvidence(sourceOnly);
    const owner = temporaryOwner(171, temporary);
    assert.equal(putTemporaryCurrentVideoTranscriptEvidence(owner, temporary, 10_410).status, 'stored');
    assert.equal(getTemporaryCurrentVideoTranscriptSegments(owner, transcriptIdentityFromEvidence(temporary), 10_411).length, 1);

    await db.watchHistory.add(watchHistoryRecord('BV1ClearKeepHistory'));
    await db.favoriteItems.add(favoriteItemRecord('clear-favorite', 'BV1ClearKeepFavorite'));
    await db.dynamicBillItems.add(dynamicBillItemRecord('clear-dynamic-bill'));

    const subtitleCategory = getRegisteredLocalDataCategories()
      .find(category => category.id === 'currentVideoSubtitles');
    assert.ok(subtitleCategory);
    const usageBefore = await subtitleCategory.collectUsage();
    assert.equal(usageBefore.count, 2);
    assert.equal(usageBefore.details?.currentVideoSubtitleSources, 2);
    assert.equal(usageBefore.details?.currentVideoSubtitleSegments, 1);
    assert.ok(usageBefore.usageBytes > 0);

    const result = await clearCurrentVideoSubtitleCache();
    assert.equal(result.cleared.currentVideoSubtitleSources, 2);
    assert.equal(result.cleared.currentVideoSubtitleSegments, 1);
    assert.equal(await db.currentVideoTranscriptSources.count(), 0);
    assert.equal(await db.currentVideoTranscriptSegments.count(), 0);
    assert.equal(getTemporaryCurrentVideoTranscriptSegments(owner, transcriptIdentityFromEvidence(temporary), 10_412).length, 0);

    const readback = await subtitleCategory.readAfterClear();
    assert.deepEqual(readback, {
      count: 0,
      usageBytes: 0,
      empty: true,
      details: {
        currentVideoSubtitleSources: 0,
        currentVideoSubtitleSegments: 0,
      },
    });
    assert.equal((await db.watchHistory.where('bvid').equals('BV1ClearKeepHistory').first())?.title, 'Kept history BV1ClearKeepHistory');
    assert.equal((await db.favoriteItems.where('itemKey').equals('clear-favorite').first())?.bvid, 'BV1ClearKeepFavorite');
    assert.equal((await db.dynamicBillItems.where('billKey').equals('clear-dynamic-bill').first())?.status, 'unopened');
  } finally {
    db.close();
    await db.delete();
    clearTemporaryCurrentVideoTranscriptCache();
  }
});

test('records empty and malformed transcript states without active segments', () => {
  const empty = normalizeBilibiliTranscriptEvidence(
    { body: [] },
    baseNormalizeOptions(),
  );
  const malformed = normalizeBilibiliTranscriptEvidence(
    { body: [{ from: 'bad', to: 3, content: 'no start' }] },
    baseNormalizeOptions({ fetchedAt: 2000 }),
  );

  assert.equal(empty.sourceRecord.status, 'empty');
  assert.equal(empty.segments.length, 0);
  assert.equal(malformed.sourceRecord.status, 'malformed');
  assert.equal(malformed.segments.length, 0);

  const store = memoryStore();
  const emptyState = store.upsert(empty);
  assert.equal(emptyState.status, 'empty');
  assert.equal(emptyState.active, false);
});

test('background cache fetch keeps raw subtitle URL internal and reports language/track diagnostics', async () => {
  const store = memoryStore();
  let fetchedUrl = '';
  let protectedKeys: string[] = [];
  let temporaryOwnerSeen: unknown = null;
  const protectedIdentityKey = 'primary-text:bilibili_subtitle:BV1Protected:202:1:zh-cn:protected';
  const temporaryOwnerScope = retainTemporaryCurrentVideoTranscriptOwner({
    ownerTabId: 91,
    bvid: 'BV1Transcript00',
    cid: 101,
    page: 1,
  });
  assert.ok(temporaryOwnerScope);
  const fetchTargets: Array<{ bvid: string; aid?: number | null; cid: number; page: number | null }> = [];
  const context = {
    ...videoContext(),
    transcriptEvidence: transcriptEvidenceState(protectedIdentityKey),
  };
  const state = await cacheCurrentVideoTranscriptEvidence(context, {
    now: 5000,
    temporaryOwner: temporaryOwnerScope,
    fetchPlayerInfo: async (target) => {
      fetchTargets.push(target);
      return {
        subtitle: {
          subtitles: [
            {
              id: 7,
              lan: 'zh-CN',
              lan_doc: 'Chinese',
              subtitle_url: '//aisubtitle.hdslb.com/bfs/ai_subtitle/private-track.json?token=secret',
            },
          ],
        },
      };
    },
    fetchSubtitleJson: async (url) => {
      fetchedUrl = url;
      return { body: [{ from: 0, to: 2, content: 'background fetched text' }] };
    },
    upsertEvidence: async (evidence, options) => {
      protectedKeys = Array.from(options?.protectedSourceIdentityKeys ?? []);
      temporaryOwnerSeen = options?.temporaryOwner ?? null;
      return store.upsert(evidence);
    },
  });

  assert.equal(state.status, 'cached');
  assert.equal(state.language, 'zh-CN');
  assert.equal(state.segmentCount, 1);
  assert.deepEqual(fetchTargets[0], { bvid: 'BV1Transcript00', aid: 8800, cid: 101, page: 1 });
  assert.deepEqual(protectedKeys, [protectedIdentityKey]);
  assert.deepEqual(temporaryOwnerSeen, temporaryOwnerScope);
  assert.match(fetchedUrl, /^https:\/\/aisubtitle\.hdslb\.com\//);
  assert.doesNotMatch(JSON.stringify(state), /private-track|subtitle_url|token=secret|SESSDATA|Key\.txt/i);
});

test('background cache falls back from WBI missing or empty tracks to v2 cached body', async () => {
  const scenarios = [
    { label: 'missing', wbiData: {} },
    { label: 'empty', wbiData: { subtitle: { subtitles: [] } } },
  ];

  for (const scenario of scenarios) {
    const store = memoryStore();
    const attempts: Array<{ sourceType: string; sourcePath: string }> = [];
    const fetchedUrls: string[] = [];
    let upsertCount = 0;
    const context = videoContext({
      bvid: `BV1Fallback${scenario.label}`,
      cid: scenario.label === 'missing' ? 6601 : 6602,
    });
    const state = await cacheCurrentVideoTranscriptEvidence(context, {
      now: scenario.label === 'missing' ? 10_500 : 10_600,
      requestedLanguage: 'zh-CN',
      fetchPlayerInfo: async (_target, options) => {
        attempts.push({ sourceType: options.sourceType, sourcePath: options.sourcePath });
        if (options.sourceType === 'bilibili_player_wbi_v2') return scenario.wbiData;
        return {
          subtitle: {
            subtitles: [
              {
                id: 'v2-track',
                lan: 'zh-CN',
                subtitle_url: `//aisubtitle.hdslb.com/bfs/ai_subtitle/${scenario.label}-v2.json?token=secret`,
              },
            ],
          },
        };
      },
      fetchSubtitleJson: async (url) => {
        fetchedUrls.push(url);
        return { body: [{ from: 0, to: 2, content: `${scenario.label} fallback body` }] };
      },
      upsertEvidence: async (evidence) => {
        upsertCount += 1;
        return store.upsert(evidence);
      },
    });

    assert.deepEqual(attempts, [
      { sourceType: 'bilibili_player_wbi_v2', sourcePath: '/x/player/wbi/v2' },
      { sourceType: 'bilibili_player_v2', sourcePath: '/x/player/v2' },
    ]);
    assert.equal(state.status, 'cached');
    assert.equal(state.active, true);
    assert.equal(state.sourceType, 'bilibili_player_v2');
    assert.equal(state.language, 'zh-CN');
    assert.equal(fetchedUrls.length, 1);
    assert.equal(upsertCount, 1);
    assert.doesNotMatch(JSON.stringify(state), /subtitle_url|token=secret|aisubtitle|fallback-(missing|empty)-v2/i);
  }
});

test('background cache falls back from WBI language mismatch to v2 requested language body', async () => {
  const store = memoryStore();
  const attempts: Array<{ sourceType: string; sourcePath: string }> = [];
  const fetchedUrls: string[] = [];
  let upsertCount = 0;
  const state = await cacheCurrentVideoTranscriptEvidence(videoContext({
    bvid: 'BV1FallbackLang',
    cid: 6611,
  }), {
    now: 10_700,
    requestedLanguage: 'en-US',
    fetchPlayerInfo: async (_target, options) => {
      attempts.push({ sourceType: options.sourceType, sourcePath: options.sourcePath });
      if (options.sourceType === 'bilibili_player_wbi_v2') {
        return {
          subtitle: {
            subtitles: [
              {
                id: 'wbi-zh',
                lan: 'zh-CN',
                subtitle_url: '//aisubtitle.hdslb.com/bfs/ai_subtitle/wbi-zh.json?token=secret',
              },
            ],
          },
        };
      }
      return {
        subtitle: {
          subtitles: [
            {
              id: 'v2-en',
              lan: 'en-US',
              subtitle_url: '//aisubtitle.hdslb.com/bfs/ai_subtitle/v2-en.json?token=secret',
            },
          ],
        },
      };
    },
    fetchSubtitleJson: async (url) => {
      fetchedUrls.push(url);
      return { body: [{ from: 0, to: 2, content: 'requested language fallback body' }] };
    },
    upsertEvidence: async (evidence) => {
      upsertCount += 1;
      return store.upsert(evidence);
    },
  });

  assert.deepEqual(attempts, [
    { sourceType: 'bilibili_player_wbi_v2', sourcePath: '/x/player/wbi/v2' },
    { sourceType: 'bilibili_player_v2', sourcePath: '/x/player/v2' },
  ]);
  assert.equal(state.status, 'cached');
  assert.equal(state.active, true);
  assert.equal(state.sourceType, 'bilibili_player_v2');
  assert.equal(state.language, 'en-US');
  assert.equal(fetchedUrls.length, 1);
  assert.equal(upsertCount, 1);
  assert.doesNotMatch(JSON.stringify(state), /subtitle_url|token=secret|aisubtitle|wbi-zh|v2-en/i);
});

test('background cache scopes in-flight temporary subtitle fetches by tab generation', async () => {
  clearTemporaryCurrentVideoTranscriptCache();
  const context = videoContext();
  const ownerOne = retainTemporaryCurrentVideoTranscriptOwner({
    ownerTabId: 92,
    bvid: context.bvid,
    cid: context.cid as number,
    page: context.currentPart.page,
  });
  const ownerTwo = retainTemporaryCurrentVideoTranscriptOwner({
    ownerTabId: 93,
    bvid: context.bvid,
    cid: context.cid as number,
    page: context.currentPart.page,
  });
  assert.ok(ownerOne);
  assert.ok(ownerTwo);
  const ownersSeen: number[] = [];
  let fetchCount = 0;
  const fetchPlayerInfo = async () => ({
    subtitle: {
      subtitles: [
        {
          id: 7,
          lan: 'zh-CN',
          subtitle_url: '//aisubtitle.hdslb.com/bfs/ai_subtitle/shared.json',
        },
      ],
    },
  });
  const fetchSubtitleJson = async () => {
    fetchCount += 1;
    return { body: [{ from: 0, to: 2, content: `tab scoped body ${fetchCount}` }] };
  };
  const upsertEvidence = async (
    evidence: CurrentVideoTranscriptEvidenceWrite,
    options?: { temporaryOwner?: typeof ownerOne },
  ) => {
    const owner = options?.temporaryOwner;
    assert.ok(owner);
    ownersSeen.push(owner.ownerTabId);
    assert.equal(putTemporaryCurrentVideoTranscriptEvidence(owner, evidence).status, 'stored');
    return getTemporaryCurrentVideoTranscriptEvidenceState(owner, {
      bvid: evidence.sourceRecord.bvid,
      cid: evidence.sourceRecord.cid,
      page: evidence.sourceRecord.page,
      language: evidence.sourceRecord.language,
      sourceIdentityKey: evidence.sourceRecord.sourceIdentityKey,
      sourceHash: evidence.sourceRecord.sourceHash,
    });
  };

  await Promise.all([
    cacheCurrentVideoTranscriptEvidence(context, {
      now: 5420,
      temporaryOwner: ownerOne,
      fetchPlayerInfo,
      fetchSubtitleJson,
      upsertEvidence,
    }),
    cacheCurrentVideoTranscriptEvidence(context, {
      now: 5420,
      temporaryOwner: ownerTwo,
      fetchPlayerInfo,
      fetchSubtitleJson,
      upsertEvidence,
    }),
  ]);

  assert.deepEqual(ownersSeen.sort((a, b) => a - b), [92, 93]);
  assert.equal(fetchCount, 2);
});

test('clear coordinator rejects subtitle fetches started before and during clearing, then allows fresh fetches', async () => {
  const context = videoContext({ bvid: 'BV1ClearGen0', cid: 6501 });
  const store = memoryStore();
  const writes: string[] = [];
  const beforeFetchStarted = deferred<void>();
  const releaseBeforeFetch = deferred<void>();
  const fetchPlayerInfo = async () => ({
    subtitle: {
      subtitles: [
        {
          id: 7,
          lan: 'zh-CN',
          subtitle_url: '//aisubtitle.hdslb.com/bfs/ai_subtitle/clear-generation.json',
        },
      ],
    },
  });
  const upsertEvidence = async (evidence: CurrentVideoTranscriptEvidenceWrite) => {
    writes.push(evidence.segments.map(segment => segment.text).join('\n'));
    return store.upsert(evidence);
  };

  const beforeClear = cacheCurrentVideoTranscriptEvidence(context, {
    now: 10_000,
    fetchPlayerInfo,
    fetchSubtitleJson: async () => {
      beforeFetchStarted.resolve();
      await releaseBeforeFetch.promise;
      return { body: [{ from: 0, to: 2, content: '清理前开始的请求不能写回。' }] };
    },
    upsertEvidence,
  });
  await beforeFetchStarted.promise;

  await runCurrentVideoTranscriptClearCoordinator(async () => {
    const duringClear = await cacheCurrentVideoTranscriptEvidence(context, {
      now: 10_010,
      fetchPlayerInfo,
      fetchSubtitleJson: async () => ({ body: [{ from: 0, to: 2, content: '清理期间的新请求不能写回。' }] }),
      upsertEvidence,
    });
    assert.equal(duringClear.active, false);
    assert.equal(duringClear.reason, 'transcript_cache_cleared_during_request');

    releaseBeforeFetch.resolve();
    const beforeClearResult = await beforeClear;
    assert.equal(beforeClearResult.active, false);
    assert.equal(beforeClearResult.reason, 'transcript_cache_cleared_during_request');
    assert.deepEqual(writes, []);
  });

  const afterClear = await cacheCurrentVideoTranscriptEvidence(context, {
    now: 10_020,
    fetchPlayerInfo,
    fetchSubtitleJson: async () => ({ body: [{ from: 0, to: 2, content: '清理完成后的新请求可以写入。' }] }),
    upsertEvidence,
  });

  assert.equal(afterClear.status, 'cached');
  assert.equal(afterClear.active, true);
  assert.deepEqual(writes, ['清理完成后的新请求可以写入。']);
});

test('repo writes require current generation and no active clearing window', async () => {
  const { db } = await import('../src/background/storage/db.ts');
  const { upsertCurrentVideoTranscriptEvidence } = await import('../src/background/storage/current-video-transcript-repo.ts');
  db.close();
  await db.delete();
  await db.open();

  try {
    const evidence = normalizeBilibiliTranscriptEvidence(
      { body: [{ from: 0, to: 2, content: '清理窗口内不能直接落库。' }] },
      baseNormalizeOptions({ bvid: 'BV1RepoClear0', cid: 6511, fetchedAt: 10_100 }),
    );
    await runCurrentVideoTranscriptClearCoordinator(async () => {
      const blocked = await upsertCurrentVideoTranscriptEvidence(evidence);
      assert.equal(blocked.active, false);
      assert.equal(blocked.reason, 'transcript_cache_cleared_during_request');
    });

    assert.equal(await db.currentVideoTranscriptSources.count(), 0);
    assert.equal(await db.currentVideoTranscriptSegments.count(), 0);

    const stored = await upsertCurrentVideoTranscriptEvidence(evidence);
    assert.equal(stored.status, 'cached');
    assert.equal(await db.currentVideoTranscriptSources.count(), 1);
    assert.equal(await db.currentVideoTranscriptSegments.count(), 1);
  } finally {
    db.close();
    await db.delete();
  }
});

test('clear coordinator remains active while blind-box draw-history clear waits in the queue', async () => {
  const storage = delayedBlindBoxStorage();
  const queuedMutation = recordBlindBoxDrawnBvids(['BV1QUEUE01'], storage);
  await storage.setStarted.promise;

  const clearPromise = runCurrentVideoTranscriptClearCoordinator(async () =>
    coordinateBlindBoxDrawHistoryClear(async () => 'cleared', storage));
  await Promise.resolve();
  assert.equal(getCurrentVideoTranscriptClearState().clearing, true);

  let writes = 0;
  const duringQueue = await cacheCurrentVideoTranscriptEvidence(videoContext({ bvid: 'BV1QueueClear', cid: 6521 }), {
    now: 10_200,
    fetchPlayerInfo: async () => ({
      subtitle: {
        subtitles: [
          {
            lan: 'zh-CN',
            subtitle_url: '//aisubtitle.hdslb.com/bfs/ai_subtitle/queue-clear.json',
          },
        ],
      },
    }),
    fetchSubtitleJson: async () => ({ body: [{ from: 0, to: 2, content: '排队清理期间不能写回。' }] }),
    upsertEvidence: async (evidence) => {
      writes += 1;
      return memoryStore().upsert(evidence);
    },
  });
  assert.equal(duringQueue.active, false);
  assert.equal(duringQueue.reason, 'transcript_cache_cleared_during_request');
  assert.equal(writes, 0);

  storage.releaseSet.resolve();
  await queuedMutation;
  assert.equal(await clearPromise, 'cleared');
  assert.equal(getCurrentVideoTranscriptClearState().clearing, false);
});

test('background cache blocks unsupported subtitle hosts before fetching body', async () => {
  let fetched = false;
  const state = await cacheCurrentVideoTranscriptEvidence(videoContext(), {
    now: 5100,
    fetchPlayerInfo: async () => ({
      subtitle: {
        subtitles: [
          {
            id: 7,
            lan: 'zh-CN',
            subtitle_url: 'https://evil.example.invalid/private-track.json?token=secret',
          },
        ],
      },
    }),
    fetchSubtitleJson: async () => {
      fetched = true;
      return { body: [{ from: 0, to: 2, content: 'should not fetch' }] };
    },
  });

  assert.equal(state.status, 'track_unavailable');
  assert.equal(state.reason, 'subtitle_host_unsupported');
  assert.equal(fetched, false);
  assert.doesNotMatch(JSON.stringify(state), /evil\.example|private-track|token=secret|subtitle_url/i);
});

test('background cache distinguishes fetch failure from subtitle access failure', async () => {
  const endpointFailed = await cacheCurrentVideoTranscriptEvidence(videoContext(), {
    now: 5200,
    fetchPlayerInfo: async () => ({
      subtitle: {
        subtitles: [
          {
            lan: 'zh-CN',
            subtitle_url: '//aisubtitle.hdslb.com/bfs/ai_subtitle/zh.json',
          },
        ],
      },
    }),
    fetchSubtitleJson: async () => {
      throw new Error('NETWORK_DOWN');
    },
  });
  assert.equal(endpointFailed.status, 'endpoint_failed');
  assert.equal(endpointFailed.active, false);
  assert.ok(endpointFailed.warnings.includes('transcript_endpoint_failed'));

  const accessFailure = await cacheCurrentVideoTranscriptEvidence(videoContext(), {
    now: 5300,
    fetchPlayerInfo: async () => ({
      subtitle: {
        subtitles: [
          {
            lan: 'zh-CN',
            subtitle_url: '//aisubtitle.hdslb.com/bfs/ai_subtitle/private.json',
          },
        ],
      },
    }),
    fetchSubtitleJson: async () => {
      throw new Error('SUBTITLE_HTTP_403');
    },
  });
  assert.equal(accessFailure.status, 'login_required');
  assert.equal(accessFailure.active, false);
  assert.ok(accessFailure.warnings.includes('transcript_login_required'));
});

test('background cache reports language mismatch and unavailable track states', async () => {
  const mismatch = await cacheCurrentVideoTranscriptEvidence(videoContext(), {
    now: 6000,
    requestedLanguage: 'en-US',
    fetchPlayerInfo: async () => ({
      subtitle: {
        subtitles: [
          {
            lan: 'zh-CN',
            subtitle_url: '//aisubtitle.hdslb.com/bfs/ai_subtitle/zh.json',
          },
        ],
      },
    }),
  });
  assert.equal(mismatch.status, 'language_mismatch');
  assert.equal(mismatch.active, false);

  const unavailable = await cacheCurrentVideoTranscriptEvidence(videoContext(), {
    now: 7000,
    fetchPlayerInfo: async () => ({ subtitle: { subtitles: [{ lan: 'zh-CN' }] } }),
  });
  assert.equal(unavailable.status, 'track_unavailable');
  assert.equal(unavailable.active, false);
});

test('privacy audit keeps cached transcript text out of current video AI payload', () => {
  const store = memoryStore();
  const state = store.upsert(normalizeBilibiliTranscriptEvidence(
    {
      body: [
        { from: 0, to: 2, content: 'SECRET TRANSCRIPT BODY SHOULD STAY LOCAL' },
      ],
    },
    baseNormalizeOptions(),
  ));
  const context = withTranscriptEvidenceState(videoContext(), state);
  context.sources.transcript = 'available';

  const payload = buildCurrentVideoSummaryAiPayload(context);
  const rawPayload = JSON.stringify(payload);
  const audit = auditAssistantPayload(payload, currentVideoSummaryPayloadContract);

  assert.equal(context.transcriptEvidence?.active, true);
  assert.equal(payload.availableSources.transcript, 'available');
  assert.equal(payload.availableSources.contentText, 'available');
  assert.equal(audit.passed, true, JSON.stringify(audit.violations));
  assertAssistantPayloadAudit(payload, currentVideoSummaryPayloadContract);
  assert.doesNotMatch(
    rawPayload,
    /SECRET TRANSCRIPT BODY|segmentId|sourceHash|watchHistory|favorites|following|feedback|Cookie|Key\.txt|Chrome\\User Data/i,
  );
});

test('cached subtitle body becomes active evidence for summary, video knowledge, and segment search', () => {
  const store = memoryStore();
  const state = store.upsert(normalizeBilibiliTranscriptEvidence(
    {
      body: [
        { from: 0, to: 4, content: '模型架构从这里开始，介绍专家路由。' },
        { from: 4, to: 8, content: '这一段说明缓存后的字幕正文会作为本地证据。' },
      ],
    },
    baseNormalizeOptions(),
  ));
  const context = withTranscriptEvidenceState(videoContext(), state);
  context.sources.transcript = 'available';
  const summary = buildLocalCurrentVideoSummary(context, {
    transcriptSegments: store.segments,
    now: 8000,
  });
  const knowledge = buildVideoKnowledgeResult(context, {
    transcriptSegments: store.segments,
    now: 8000,
  });
  const search = searchCurrentVideoSegments(context, {
    query: '专家路由',
    transcriptSegments: store.segments,
    videoKnowledge: knowledge,
    now: 8000,
  });
  const raw = JSON.stringify({ summary, knowledge, search });

  assert.equal(context.transcriptEvidence?.active, true);
  assert.equal(summary.sourceTier, 'transcript_summary');
  assert.equal(knowledge.sourceState.transcriptEvidence, true);
  assert.ok(knowledge.nodes.some(node => node.source === 'transcript'));
  assert.equal(search.status, 'ready');
  assert.equal(search.candidates[0].binding.kind, 'transcript_segment');
  assert.doesNotMatch(raw, /subtitle_url|raw subtitle|watchHistory|favorites|following|feedback|Cookie|Key\.txt|Chrome\\User Data/i);
});

function baseNormalizeOptions(overrides: Partial<Parameters<typeof normalizeBilibiliTranscriptEvidence>[1]> = {}) {
  return {
    bvid: 'BV1Transcript00',
    cid: 101,
    page: 1,
    language: 'zh-CN',
    sourceType: 'bilibili_player_wbi_v2' as const,
    trackId: '7',
    trackUrlHost: 'aisubtitle.hdslb.com',
    fetchedAt: 1000,
    ...overrides,
  };
}

function uniqueTestDbName(suffix: string): string {
  return `BiliAnalyticsDB-test-${suffix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function dexieV9Stores(): Record<string, string> {
  return {
    watchHistory:
      '++id, kid, &sessionKey, avid, bvid, [avid+cid+viewAt], authorMid, tagName, viewAt, dt',
    playerEvents:
      '++id, [bvid+cid], eventType, timestamp, tabId',
    dailyAggregates:
      '++id, &date',
    favoriteFolders:
      '++id, &mediaId, title, syncedAt',
    favoriteItems:
      '++id, &itemKey, mediaId, avid, bvid, authorMid, tagName, favTime, syncedAt',
    smartFavoriteIndex:
      '++id, &itemKey, status, indexedAt, contentHash',
    followedCreators:
      '++id, &mid, followedAt, followAgeKnown, isActive, firstSeenAt, syncedAt, lastSeenAt',
    followedVideoUpdates:
      '++id, &updateKey, dynamicId, bvid, authorMid, dynamicTime, pubtime, syncedAt',
    dynamicBillItems:
      '++id, &billKey, column, status, creatorMid, updateKey, generatedAt, localRank',
    dynamicBillFeedback:
      '++id, [scope+key], scope, key, creatorMid, billKey, column, createdAt',
    dynamicBillExplanations:
      '++id, &billKey, status, generatedAt, model, contentHash',
    dynamicBillCreatorPauses:
      '++id, &creatorMid, expiresAt, startedAt, source, updatedAt',
    dynamicBillRotationRecords:
      '++id, &creatorMid, lastShownAt, lastColumn, updatedAt',
    dynamicBillMigrations:
      '++id, &version, completedAt',
    currentVideoTranscriptSources:
      '++id, &identityKey, bvid, [bvid+cid+page], [bvid+cid+page+language], sourceHash, stale, updatedAt',
    currentVideoTranscriptSegments:
      '++id, &segmentId, bvid, [bvid+cid+page], [bvid+cid+page+language], sourceHash, stale, updatedAt',
  };
}

function watchHistoryRecord(bvid: string) {
  return {
    sessionKey: `${bvid}:1`,
    kid: 1,
    avid: 1,
    bvid,
    cid: 1,
    title: `Kept history ${bvid}`,
    authorName: 'Migration UP',
    authorMid: 101,
    tagName: '科技',
    tags: ['测试'],
    cover: '',
    viewAt: 1_700_000_000,
    progress: 60,
    duration: 120,
    actualCompletion: 0.5,
    deviceType: 2,
    isFavorite: false,
    business: 'archive',
    dt: 2,
    syncedAt: 1_700_000_100,
  };
}

function favoriteItemRecord(itemKey: string, bvid: string) {
  return {
    itemKey,
    mediaId: 7,
    folderTitle: 'Migration Favorites',
    avid: 2,
    bvid,
    title: `Kept favorite ${bvid}`,
    intro: 'favorite row kept across transcript migration',
    authorName: 'Favorite UP',
    authorMid: 202,
    tagName: '知识',
    tags: ['测试'],
    cover: '',
    duration: 180,
    pubtime: 1_699_000_000,
    favTime: 1_700_000_200,
    syncedAt: 1_700_000_300,
  };
}

function dynamicBillItemRecord(billKey: string) {
  return {
    billKey,
    column: 'buried_follow',
    status: 'unopened',
    updateKey: `${billKey}:update`,
    creatorMid: 303,
    creatorName: 'Dynamic UP',
    creatorFace: '',
    historyBvids: ['BV1DynamicKeep'],
    evidence: {},
    localRank: 1,
    score: 0.9,
    generatedAt: 1_700_000_400,
  };
}

async function withFreshTranscriptRepo<T>(
  callback: (repo: typeof import('../src/background/storage/current-video-transcript-repo.ts')) => Promise<T>,
): Promise<T> {
  clearTemporaryCurrentVideoTranscriptCache();
  const { db } = await import('../src/background/storage/db.ts');
  const repo = await import('../src/background/storage/current-video-transcript-repo.ts');
  db.close();
  await db.delete();
  await db.open();
  try {
    return await callback(repo);
  } finally {
    db.close();
    await db.delete();
    clearTemporaryCurrentVideoTranscriptCache();
  }
}

async function assertOwnerRejectedSourceBlocksPersistentFallback(
  status: 'source_too_large' | 'capacity_exceeded',
): Promise<void> {
  await withFreshTranscriptRepo(async (repo) => {
    const oldBody = normalizeBilibiliTranscriptEvidence(
      { body: [{ from: 0, to: 2, content: `old persistent ${status}` }] },
      baseNormalizeOptions({ bvid: `BV1Reject${status === 'source_too_large' ? 'Large' : 'Cap'}`, cid: status === 'source_too_large' ? 6472 : 6473, fetchedAt: 10_600 }),
    );
    const currentBody = normalizeBilibiliTranscriptEvidence(
      { body: [{ from: 0, to: 2, content: `new rejected ${status}` }] },
      baseNormalizeOptions({ bvid: oldBody.sourceRecord.bvid, cid: oldBody.sourceRecord.cid, fetchedAt: 10_601 }),
    );
    const owner = temporaryOwner(status === 'source_too_large' ? 141 : 142, currentBody);
    const otherOwner = temporaryOwner(status === 'source_too_large' ? 143 : 144, oldBody);

    await repo.upsertCurrentVideoTranscriptEvidence(oldBody);

    let result: ReturnType<typeof putTemporaryCurrentVideoTranscriptEvidence>;
    if (status === 'source_too_large') {
      const sourceBytes = temporaryStoredBytes(currentBody, 10_610);
      result = putTemporaryCurrentVideoTranscriptEvidence(owner, currentBody, 10_610, {
        maxSourceCount: CURRENT_VIDEO_TEMPORARY_TRANSCRIPT_MAX_SOURCES,
        maxBytes: sourceBytes - 1,
      });
    } else {
      const filler = normalizeBilibiliTranscriptEvidence(
        { body: [{ from: 0, to: 2, content: 'capacity filler temporary owner' }] },
        baseNormalizeOptions({ bvid: 'BV1RejectCapFill', cid: 6474, fetchedAt: 10_602 }),
      );
      const fillerOwner = temporaryOwner(145, filler);
      assert.equal(putTemporaryCurrentVideoTranscriptEvidence(fillerOwner, filler, 10_609).status, 'stored');
      const retainedBytes = temporaryStoredBytes(filler, 10_609);
      const sourceBytes = temporaryStoredBytes(currentBody, 10_610);
      result = putTemporaryCurrentVideoTranscriptEvidence(owner, currentBody, 10_610, {
        maxSourceCount: CURRENT_VIDEO_TEMPORARY_TRANSCRIPT_MAX_SOURCES,
        maxBytes: retainedBytes + sourceBytes - 1,
      });
    }
    assert.equal(result.status, status);

    const broadState = await repo.getCurrentVideoTranscriptEvidenceState({
      bvid: oldBody.sourceRecord.bvid,
      cid: oldBody.sourceRecord.cid,
      page: oldBody.sourceRecord.page,
    }, 10_620, owner);
    assert.equal(broadState.active, false);
    assert.equal(broadState.reason, status === 'source_too_large'
      ? 'temporary_transcript_source_too_large'
      : 'temporary_transcript_capacity_exceeded');

    const explicitOldState = await repo.getCurrentVideoTranscriptEvidenceState(
      transcriptIdentityFromEvidence(oldBody),
      10_621,
      owner,
    );
    assert.equal(explicitOldState.active, false);
    assert.equal(explicitOldState.reason, broadState.reason);
    assert.equal((await repo.getCurrentVideoTranscriptSegments(
      transcriptIdentityFromEvidence(oldBody),
      owner,
    )).length, 0);

    const otherState = await repo.getCurrentVideoTranscriptEvidenceState({
      bvid: oldBody.sourceRecord.bvid,
      cid: oldBody.sourceRecord.cid,
      page: oldBody.sourceRecord.page,
    }, 10_622, otherOwner);
    assert.equal(otherState.active, true);
    assert.equal(otherState.sourceIdentityKey, oldBody.sourceRecord.sourceIdentityKey);
  });
}

function temporaryOwner(ownerTabId: number, evidence: CurrentVideoTranscriptEvidenceWrite) {
  const owner = retainTemporaryCurrentVideoTranscriptOwner({
    ownerTabId,
    bvid: evidence.sourceRecord.bvid,
    cid: evidence.sourceRecord.cid,
    page: evidence.sourceRecord.page,
  });
  assert.ok(owner);
  return owner;
}

function moveTemporaryOwnerToEvidence(
  owner: ReturnType<typeof temporaryOwner>,
  evidence: CurrentVideoTranscriptEvidenceWrite,
): void {
  const moved = retainTemporaryCurrentVideoTranscriptOwner({
    ownerTabId: owner.ownerTabId,
    bvid: evidence.sourceRecord.bvid,
    cid: evidence.sourceRecord.cid,
    page: evidence.sourceRecord.page,
  });
  assert.ok(moved);
}

function transcriptIdentityFromEvidence(evidence: CurrentVideoTranscriptEvidenceWrite) {
  return {
    bvid: evidence.sourceRecord.bvid,
    cid: evidence.sourceRecord.cid,
    page: evidence.sourceRecord.page,
    language: evidence.sourceRecord.language,
    sourceIdentityKey: evidence.sourceRecord.sourceIdentityKey,
    sourceHash: evidence.sourceRecord.sourceHash,
  };
}

function temporaryStoredBytes(evidence: CurrentVideoTranscriptEvidenceWrite, now: number): number {
  const sourceIdentityKey = evidence.sourceRecord.sourceIdentityKey ?? evidence.sourceRecord.identityKey;
  return measureTranscriptPersistentBytes({
    ...evidence.sourceRecord,
    identityKey: sourceIdentityKey,
    sourceIdentityKey,
    partIdentityKey: evidence.sourceRecord.partIdentityKey,
    persistent: false,
    stale: false,
    lastAccessedAt: now,
  }, evidence.segments.map(segment => ({
    ...segment,
    sourceIdentityKey,
    stale: false,
  })));
}

async function withOwnerSwitchAfterSourceBvidRead<T>(
  db: CurrentVideoTranscriptTestDb,
  bvid: string,
  switchOwner: () => void,
  callback: () => Promise<T>,
): Promise<{ result: T; switched: boolean }> {
  const table = db.currentVideoTranscriptSources as any;
  const originalWhere = table.where;
  let switched = false;

  table.where = (index: unknown) => {
    const query = originalWhere.call(table, index);
    if (index !== 'bvid') return query;

    const originalEquals = query.equals.bind(query);
    query.equals = (key: unknown) => {
      const collection = originalEquals(key);
      if (key !== bvid) return collection;

      const originalToArray = collection.toArray.bind(collection);
      collection.toArray = async () => {
        const rows = await originalToArray();
        if (!switched) {
          switched = true;
          switchOwner();
        }
        return rows;
      };
      return collection;
    };
    return query;
  };

  try {
    return {
      result: await callback(),
      switched,
    };
  } finally {
    table.where = originalWhere;
  }
}

async function withOwnerSwitchAfterSegmentIdentityRead<T>(
  db: CurrentVideoTranscriptTestDb,
  identity: { bvid: string; cid: number; page: number },
  switchOwner: () => void,
  callback: () => Promise<T>,
): Promise<{ result: T; switched: boolean }> {
  const table = db.currentVideoTranscriptSegments as any;
  const originalWhere = table.where;
  let switched = false;

  table.where = (index: unknown) => {
    const query = originalWhere.call(table, index);
    if (index !== '[bvid+cid+page]') return query;

    const originalEquals = query.equals.bind(query);
    query.equals = (key: unknown) => {
      const collection = originalEquals(key);
      if (!matchesTranscriptIdentityTuple(key, identity)) return collection;

      const originalToArray = collection.toArray.bind(collection);
      collection.toArray = async () => {
        const rows = await originalToArray();
        if (!switched) {
          switched = true;
          switchOwner();
        }
        return rows;
      };
      return collection;
    };
    return query;
  };

  try {
    return {
      result: await callback(),
      switched,
    };
  } finally {
    table.where = originalWhere;
  }
}

async function withOwnerSwitchBeforeSourceTouch<T>(
  db: CurrentVideoTranscriptTestDb,
  sourceIdentityKey: string,
  switchOwner: () => void,
  callback: () => Promise<T>,
): Promise<{ result: T; switched: boolean }> {
  const table = db.currentVideoTranscriptSources as any;
  const originalWhere = table.where;
  let switched = false;

  table.where = (index: unknown) => {
    const query = originalWhere.call(table, index);
    if (index !== 'identityKey') return query;

    const originalEquals = query.equals.bind(query);
    query.equals = (key: unknown) => {
      const collection = originalEquals(key);
      if (key !== sourceIdentityKey) return collection;

      const originalModify = collection.modify.bind(collection);
      collection.modify = async (...args: unknown[]) => {
        if (!switched) {
          switched = true;
          switchOwner();
        }
        return await originalModify(...args);
      };
      return collection;
    };
    return query;
  };

  try {
    return {
      result: await callback(),
      switched,
    };
  } finally {
    table.where = originalWhere;
  }
}

function matchesTranscriptIdentityTuple(
  key: unknown,
  identity: { bvid: string; cid: number; page: number },
): boolean {
  return Array.isArray(key)
    && key[0] === identity.bvid
    && key[1] === identity.cid
    && key[2] === identity.page;
}

function memoryStore() {
  const sources: CurrentVideoTranscriptSourceRecord[] = [];
  const segments: CurrentVideoTranscriptSegment[] = [];
  return {
    sources,
    segments,
    upsert(evidence: CurrentVideoTranscriptEvidenceWrite): CurrentVideoTranscriptEvidenceState {
      const plan = planTranscriptEvidenceUpsert(sources, segments, evidence);
      deleteSources(sources, segments, plan.sourceIdentityKeysToDelete);
      putSources(sources, plan.sourcesToPut);
      putSegments(segments, plan.segmentsToPut);
      return plan.state;
    },
  };
}

function transcriptEvidenceState(sourceIdentityKey: string): CurrentVideoTranscriptEvidenceState {
  return {
    status: 'cached',
    active: true,
    checkedAt: 1000,
    bvid: 'BV1Protected',
    cid: 202,
    page: 1,
    language: 'zh-CN',
    source: 'bilibili_subtitle',
    sourceType: 'bilibili_player_wbi_v2',
    sourceIdentityKey,
    sourceHash: 'protected',
    bodyHash: 'protected-body',
    timelineHash: 'protected-timeline',
    segmentCount: 1,
    staleSegmentCount: 0,
    serializedBytes: 100,
    coverageStartSeconds: 0,
    coverageEndSeconds: 1,
    fetchedAt: 1000,
    updatedAt: 1000,
    lastAccessedAt: 1000,
    persistent: true,
    temporary: false,
    reason: 'cached',
    message: 'cached',
    warnings: [],
  };
}

function deleteSources(
  sources: CurrentVideoTranscriptSourceRecord[],
  segments: CurrentVideoTranscriptSegment[],
  sourceIdentityKeys: string[],
): void {
  for (const sourceIdentityKey of sourceIdentityKeys) {
    for (let index = sources.length - 1; index >= 0; index -= 1) {
      if ((sources[index].sourceIdentityKey ?? sources[index].identityKey) === sourceIdentityKey) {
        sources.splice(index, 1);
      }
    }
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      if (segments[index].sourceIdentityKey === sourceIdentityKey) {
        segments.splice(index, 1);
      }
    }
  }
}

function putSources(
  target: CurrentVideoTranscriptSourceRecord[],
  values: CurrentVideoTranscriptSourceRecord[],
): void {
  for (const value of values) {
    const index = target.findIndex(item => item.identityKey === value.identityKey);
    if (index >= 0) {
      target[index] = value;
    } else {
      target.push(value);
    }
  }
}

function putSegments(
  target: CurrentVideoTranscriptSegment[],
  values: CurrentVideoTranscriptSegment[],
): void {
  for (const value of values) {
    const index = target.findIndex(item => item.segmentId === value.segmentId);
    if (index >= 0) {
      target[index] = value;
    } else {
      target.push(value);
    }
  }
}

function utf8JsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function videoContext(options: {
  bvid?: string;
  cid?: number;
  page?: number;
} = {}): CurrentVideoContext {
  const bvid = options.bvid ?? 'BV1Transcript00';
  const cid = options.cid ?? 101;
  const page = options.page ?? 1;
  return {
    kind: 'video',
    url: `https://www.bilibili.com/video/${bvid}?p=${page}`,
    collectedAt: 1000,
    bvid,
    aid: 8800,
    cid,
    title: 'Transcript cache video',
    authorName: 'Cache UP',
    authorMid: 42,
    durationSeconds: 600,
    currentPart: {
      page,
      title: 'Main',
      total: 1,
    },
    parts: [{ page, cid, title: 'Main', durationSeconds: 600 }],
    chapters: [],
    description: {
      availability: 'available',
      text: 'Visible description remains the summary fallback.',
      length: 49,
    },
    sources: {
      metadata: 'available',
      description: 'available',
      pages: 'available',
      chapters: 'unknown',
      transcript: 'unknown',
      contentText: 'unavailable',
    },
    subtitleProbe: null,
    transcriptEvidence: null,
    warnings: ['transcript_probe_pending'],
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return {
    promise,
    resolve: (value?: T | PromiseLike<T>) => resolve(value as T),
    reject,
  };
}

function delayedBlindBoxStorage(): BlindBoxDrawHistoryStorage & {
  setStarted: ReturnType<typeof deferred<void>>;
  releaseSet: ReturnType<typeof deferred<void>>;
} {
  const values = new Map<string, unknown>();
  const setStarted = deferred<void>();
  const releaseSet = deferred<void>();
  return {
    setStarted,
    releaseSet,
    get: async keys => Object.fromEntries(keys.map(key => [key, values.get(key)])),
    set: async items => {
      setStarted.resolve();
      await releaseSet.promise;
      for (const [key, value] of Object.entries(items)) {
        values.set(key, value);
      }
    },
    remove: async keys => {
      for (const key of keys) {
        values.delete(key);
      }
    },
  };
}
