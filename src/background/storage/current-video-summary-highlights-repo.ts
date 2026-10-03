import type { CurrentVideoTextSourceIdentity } from '../../shared/current-video-primary-text.ts';
import { stableDigestHex } from '../../shared/stable-digest.ts';
import { serializeCurrentVideoCanonicalRecord } from '../../shared/current-video-primary-text.ts';
import type {
  CurrentVideoSummaryHighlightsCacheRecord,
  CurrentVideoSummaryHighlightsResult,
} from '../../shared/types/current-video-summary.ts';
import {
  canUseCurrentVideoSummaryHighlightsClearGeneration,
  getCurrentVideoSummaryHighlightsClearState,
  runCurrentVideoSummaryHighlightsClearCoordinator,
} from '../current-video-summary-highlights-clear-epoch.ts';
import type { LocalDataCategoryRegistration } from '../../shared/local-data-category-contract.ts';
import { db } from './db.ts';

export const CURRENT_VIDEO_SUMMARY_HIGHLIGHTS_CACHE_MAX_RECORDS = 50;
export const CURRENT_VIDEO_SUMMARY_HIGHLIGHTS_CACHE_MAX_BYTES = 5 * 1024 * 1024;
export const CURRENT_VIDEO_SUMMARY_HIGHLIGHTS_CACHE_KEY_VERSION = 2;

export interface CurrentVideoSummaryHighlightsCacheUsage {
  count: number;
  usageBytes: number;
  latestGeneratedAt: number | null;
}

export interface PutCurrentVideoSummaryHighlightsCacheOptions {
  expectedClearGeneration?: number;
  beforeWrite?: () => Promise<void>;
  afterWrite?: () => Promise<void>;
  canWrite?: () => boolean;
}

class CurrentVideoSummaryHighlightsWriteRejected extends Error {
  readonly reason: 'cleared' | 'invalidated';

  constructor(reason: 'cleared' | 'invalidated') {
    super(`CURRENT_VIDEO_SUMMARY_HIGHLIGHTS_WRITE_${reason.toUpperCase()}`);
    this.reason = reason;
  }
}

export function buildCurrentVideoSummaryHighlightsCacheKey(input: {
  identity: Pick<CurrentVideoTextSourceIdentity, 'sourceIdentityKey'>;
  model: string;
  promptFingerprint?: string;
}): string {
  const digest = stableDigestHex(serializeCurrentVideoCanonicalRecord({
    version: CURRENT_VIDEO_SUMMARY_HIGHLIGHTS_CACHE_KEY_VERSION,
    kind: 'current-video-summary-highlights-cache-key',
    sourceIdentityKey: input.identity.sourceIdentityKey,
    model: normalizeModel(input.model),
    ...(input.promptFingerprint ? { promptFingerprint: input.promptFingerprint } : {}),
  }));
  return `cv-summary-highlights:v${CURRENT_VIDEO_SUMMARY_HIGHLIGHTS_CACHE_KEY_VERSION}:${digest}`;
}

export async function getCurrentVideoSummaryHighlightsCache(input: {
  identity: Pick<CurrentVideoTextSourceIdentity, 'sourceIdentityKey'>;
  model: string;
  promptFingerprint?: string;
  now?: number;
}): Promise<CurrentVideoSummaryHighlightsCacheRecord | null> {
  const cacheKey = buildCurrentVideoSummaryHighlightsCacheKey(input);
  const record = await db.currentVideoSummaryHighlights
    .where('cacheKey')
    .equals(cacheKey)
    .first();
  if (!record) return null;
  const lastAccessedAt = input.now ?? Date.now();
  const touched = withExactSerializedBytes({ ...record, lastAccessedAt });
  await db.currentVideoSummaryHighlights.update(record.id as number, {
    lastAccessedAt,
    serializedBytes: touched.serializedBytes,
  });
  return {
    ...touched,
    result: {
      ...record.result,
      cacheHit: true,
      cacheKey: record.cacheKey,
    },
  };
}

export async function putCurrentVideoSummaryHighlightsCache(
  record: Omit<CurrentVideoSummaryHighlightsCacheRecord, 'id' | 'serializedBytes'>,
  options: PutCurrentVideoSummaryHighlightsCacheOptions = {},
): Promise<{
  cached: boolean;
  cacheKey: string;
  serializedBytes: number;
  rejectedReason: 'cleared' | 'invalidated' | 'size_limit' | null;
}> {
  const expectedClearGeneration = options.expectedClearGeneration
    ?? getCurrentVideoSummaryHighlightsClearState().generation;
  await options.beforeWrite?.();
  let serializedBytes = 0;
  let rejectedReason: 'cleared' | 'invalidated' | 'size_limit' | null = null;
  let wrote = false;
  try {
    await db.transaction('rw', db.currentVideoSummaryHighlights, async () => {
      assertCurrentVideoSummaryHighlightsWriteAllowed(expectedClearGeneration, options.canWrite);
      const existing = await db.currentVideoSummaryHighlights
        .where('cacheKey')
        .equals(record.cacheKey)
        .first();
      assertCurrentVideoSummaryHighlightsWriteAllowed(expectedClearGeneration, options.canWrite);
      const initialRecord: CurrentVideoSummaryHighlightsCacheRecord = {
        ...record,
        ...(existing?.id === undefined ? {} : { id: existing.id }),
        serializedBytes: 0,
      };
      const id = await db.currentVideoSummaryHighlights.put(initialRecord);
      assertCurrentVideoSummaryHighlightsWriteAllowed(expectedClearGeneration, options.canWrite);
      const exactRecord = withExactSerializedBytes({ ...initialRecord, id: Number(id) });
      serializedBytes = exactRecord.serializedBytes;
      await db.currentVideoSummaryHighlights.update(Number(id), {
        serializedBytes: exactRecord.serializedBytes,
      });
      await options.afterWrite?.();
      assertCurrentVideoSummaryHighlightsWriteAllowed(expectedClearGeneration, options.canWrite);
      await pruneCurrentVideoSummaryHighlightsCache();
      assertCurrentVideoSummaryHighlightsWriteAllowed(expectedClearGeneration, options.canWrite);
      wrote = true;
    });
  } catch (error) {
    if (!(error instanceof CurrentVideoSummaryHighlightsWriteRejected)) throw error;
    rejectedReason = error.reason;
    serializedBytes = 0;
    wrote = false;
  }
  const cached = wrote && await db.currentVideoSummaryHighlights
    .where('cacheKey')
    .equals(record.cacheKey)
    .count() > 0;
  if (!cached && rejectedReason === null) rejectedReason = 'size_limit';
  return {
    cached,
    cacheKey: record.cacheKey,
    serializedBytes,
    rejectedReason,
  };
}

function assertCurrentVideoSummaryHighlightsWriteAllowed(
  expectedClearGeneration: number,
  canWrite: (() => boolean) | undefined,
): void {
  if (!canUseCurrentVideoSummaryHighlightsClearGeneration(expectedClearGeneration)) {
    throw new CurrentVideoSummaryHighlightsWriteRejected('cleared');
  }
  if (canWrite && !canWrite()) {
    throw new CurrentVideoSummaryHighlightsWriteRejected('invalidated');
  }
}

export async function clearCurrentVideoSummaryHighlightsCache(): Promise<{
  currentVideoSummaryHighlightParts: number;
  currentVideoSummaryHighlightBytes: number;
}> {
  return await runCurrentVideoSummaryHighlightsClearCoordinator(async () => {
    const usage = await collectCurrentVideoSummaryHighlightsCacheUsage();
    await db.currentVideoSummaryHighlights.clear();
    return {
      currentVideoSummaryHighlightParts: usage.count,
      currentVideoSummaryHighlightBytes: usage.usageBytes,
    };
  });
}

export async function collectCurrentVideoSummaryHighlightsCacheUsage(): Promise<CurrentVideoSummaryHighlightsCacheUsage> {
  const records = await db.currentVideoSummaryHighlights.toArray();
  return {
    count: records.length,
    usageBytes: records.reduce((sum, record) => sum + serializedSize(record), 0),
    latestGeneratedAt: records.reduce<number | null>((latest, record) => {
      const generatedAt = normalizeTimestamp(record.generatedAt);
      if (!generatedAt) return latest;
      return latest === null ? generatedAt : Math.max(latest, generatedAt);
    }, null),
  };
}

export async function readCurrentVideoSummaryHighlightsAfterClear(): Promise<CurrentVideoSummaryHighlightsCacheUsage & { empty: boolean }> {
  const usage = await collectCurrentVideoSummaryHighlightsCacheUsage();
  return {
    ...usage,
    empty: usage.count === 0 && usage.usageBytes === 0,
  };
}

export function getCurrentVideoSummaryHighlightsLocalDataCategoryRegistration(): LocalDataCategoryRegistration {
  return {
    id: 'currentVideoSummaryHighlights',
    label: '摘要与亮点',
    includeInClearAll: true,
    collectUsage: async () => {
      const usage = await collectCurrentVideoSummaryHighlightsCacheUsage();
      return {
        ...usage,
        details: {
          currentVideoSummaryHighlightParts: usage.count,
          currentVideoSummaryHighlightBytes: usage.usageBytes,
        },
      };
    },
    clear: async () => ({
      cleared: await clearCurrentVideoSummaryHighlightsCache(),
    }),
    readAfterClear: readCurrentVideoSummaryHighlightsAfterClear,
  };
}

export function withCurrentCacheHit(
  record: CurrentVideoSummaryHighlightsCacheRecord,
  current: boolean,
  options: { authorizationEnabled?: boolean; configured?: boolean } = {},
): CurrentVideoSummaryHighlightsResult {
  const authorizationEnabled = options.authorizationEnabled ?? true;
  const configured = options.configured ?? true;
  const priorGenerated = !authorizationEnabled;
  return {
    ...record.result,
    cacheHit: true,
    cacheKey: record.cacheKey,
    current,
    canGenerate: authorizationEnabled && configured,
    priorGenerated,
    generationBlockedMessage: !authorizationEnabled
      ? '要重新生成，请先在设置中开启“当前视频 AI 助手”。'
      : configured
        ? null
        : '要重新生成，请先完成 AI 服务配置。',
    message: current
      ? priorGenerated
        ? '已读取此前生成的摘要与亮点；关闭授权后仍可查看，但不能重新生成。'
        : '已读取本地缓存的摘要与亮点。'
      : '已读取对应视频缓存；当前页面已变化，因此没有覆盖当前视图。',
    ai: {
      ...record.result.ai,
      note: '已从本地缓存读取。',
    },
  };
}

async function pruneCurrentVideoSummaryHighlightsCache(): Promise<void> {
  let records = await db.currentVideoSummaryHighlights
    .orderBy('lastAccessedAt')
    .toArray();
  let usageBytes = records.reduce((sum, record) => sum + serializedSize(record), 0);
  const deleteIds: number[] = [];

  while (
    records.length > 0
    && (records.length > CURRENT_VIDEO_SUMMARY_HIGHLIGHTS_CACHE_MAX_RECORDS
      || usageBytes > CURRENT_VIDEO_SUMMARY_HIGHLIGHTS_CACHE_MAX_BYTES)
  ) {
    const [oldest, ...rest] = records;
    records = rest;
    usageBytes -= serializedSize(oldest);
    if (oldest.id !== undefined) {
      deleteIds.push(oldest.id);
    }
  }

  if (deleteIds.length > 0) {
    await db.currentVideoSummaryHighlights.bulkDelete(deleteIds);
  }
}

function normalizeModel(value: string): string {
  return value.trim() || 'unknown-model';
}

function normalizeTimestamp(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function serializedSize(value: unknown): number {
  const text = JSON.stringify(value ?? null);
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(text).byteLength;
  }
  return text.length;
}

function withExactSerializedBytes(
  record: CurrentVideoSummaryHighlightsCacheRecord,
): CurrentVideoSummaryHighlightsCacheRecord {
  let serializedBytes = Math.max(0, Math.floor(record.serializedBytes || 0));
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const next = serializedSize({ ...record, serializedBytes });
    if (next === serializedBytes) break;
    serializedBytes = next;
  }
  return { ...record, serializedBytes };
}
