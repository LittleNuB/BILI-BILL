import type {
  CurrentVideoContext,
  CurrentVideoContextResult,
  CurrentVideoSubtitleSourceType,
} from '../shared/types/current-video-context';
import type {
  CurrentVideoTranscriptEvidenceState,
  CurrentVideoTranscriptEvidenceWrite,
} from '../shared/types/current-video-transcript';
import {
  buildCurrentVideoTranscriptEvidenceState,
  normalizeBilibiliTranscriptEvidence,
} from '../shared/current-video-transcript-cache.ts';
import type {
  CurrentVideoSubtitlePlayerInfoFetcher,
  PlayerInfoFetchOptions,
} from '../shared/current-video-subtitle-state';
import type { CurrentVideoTemporaryTranscriptOwner } from './current-video-temporary-transcript-cache.ts';
import {
  canUseCurrentVideoTranscriptClearGeneration,
  getCurrentVideoTranscriptClearState,
} from './current-video-transcript-clear-epoch.ts';
import { biliGet } from './api/client.ts';
import { subtitleLanguagePriority } from '../shared/automatic-subtitles.ts';
import { upsertCurrentVideoTranscriptEvidence } from './storage/current-video-transcript-repo.ts';

const SUBTITLE_FETCH_TIMEOUT_MS = 30_000;
const PLAYER_INFO_ATTEMPTS: Array<PlayerInfoFetchOptions> = [
  {
    sourceType: 'bilibili_player_wbi_v2',
    sourcePath: '/x/player/wbi/v2',
  },
  {
    sourceType: 'bilibili_player_v2',
    sourcePath: '/x/player/v2',
  },
];

const inFlightTranscriptCaches = new Map<string, Promise<CurrentVideoTranscriptEvidenceState>>();

export interface CacheCurrentVideoTranscriptOptions {
  now?: number;
  requestedLanguage?: string | null;
  fetchPlayerInfo?: CurrentVideoSubtitlePlayerInfoFetcher;
  fetchSubtitleJson?: (url: string) => Promise<unknown>;
  protectedSourceIdentityKeys?: Iterable<string>;
  temporaryOwner?: CurrentVideoTemporaryTranscriptOwner;
  upsertEvidence?: (
    evidence: CurrentVideoTranscriptEvidenceWrite,
    options?: {
      protectedSourceIdentityKeys?: Iterable<string>;
      temporaryOwner?: CurrentVideoTemporaryTranscriptOwner;
      expectedClearGeneration?: number;
    },
  ) => Promise<CurrentVideoTranscriptEvidenceState>;
}

export async function cacheCurrentVideoTranscriptEvidence(
  context: CurrentVideoContextResult,
  options: CacheCurrentVideoTranscriptOptions = {},
): Promise<CurrentVideoTranscriptEvidenceState> {
  const now = options.now ?? Date.now();
  if (context.kind !== 'video') {
    return buildCurrentVideoTranscriptEvidenceState({
      status: 'unsupported',
      target: { bvid: null, cid: null, page: null, language: options.requestedLanguage ?? null },
      now,
      reason: 'no_current_video_context',
      message: '当前没有可缓存字幕正文证据的 B 站视频上下文；仍使用元数据和简介作为本地证据结果。',
      warnings: ['no_current_video_context'],
    });
  }

  if (!context.cid) {
    return buildCurrentVideoTranscriptEvidenceState({
      status: 'unsupported',
      target: {
        bvid: context.bvid,
        cid: context.cid,
        page: context.currentPart.page,
        language: options.requestedLanguage ?? null,
      },
      now,
      reason: 'missing_cid',
      message: '当前视频缺少 CID，无法读取字幕正文证据；仍使用元数据和简介作为本地证据结果。',
      warnings: ['cid_unknown'],
    });
  }

  const clearState = getCurrentVideoTranscriptClearState();
  if (clearState.clearing) {
    return transcriptClearedDuringRequestState({
      bvid: context.bvid,
      cid: context.cid,
      page: context.currentPart.page,
      language: options.requestedLanguage ?? null,
    }, now, 'bilibili_player_v2');
  }
  const expectedClearGeneration = clearState.generation;
  const key = [
    context.bvid,
    context.cid,
    context.currentPart.page,
    normalizeLanguage(options.requestedLanguage) ?? 'auto',
    expectedClearGeneration,
    options.temporaryOwner
      ? `${options.temporaryOwner.ownerTabId}:${options.temporaryOwner.navigationGeneration}`
      : 'persistent',
  ].join(':');
  const existing = inFlightTranscriptCaches.get(key);
  if (existing) return existing;

  const request = cacheCurrentVideoTranscriptEvidenceInner(context, {
    ...options,
    now,
    expectedClearGeneration,
  }).finally(() => {
    inFlightTranscriptCaches.delete(key);
  });
  inFlightTranscriptCaches.set(key, request);
  return request;
}

async function cacheCurrentVideoTranscriptEvidenceInner(
  context: CurrentVideoContext,
  options: CacheCurrentVideoTranscriptOptions & { now: number; expectedClearGeneration: number },
): Promise<CurrentVideoTranscriptEvidenceState> {
  const target = {
    bvid: context.bvid,
    cid: context.cid as number,
    page: context.currentPart.page,
    language: options.requestedLanguage ?? null,
  };
  const fetchPlayerInfo = options.fetchPlayerInfo ?? fetchBilibiliPlayerInfo;
  const fetchSubtitleJson = options.fetchSubtitleJson ?? defaultFetchSubtitleJson;
  const upsertEvidence = options.upsertEvidence ?? defaultUpsertEvidence;
  let sawLoginRequired = false;
  let lastError: string | null = null;
  let lastPreBodyFailure: CurrentVideoTranscriptEvidenceState | null = null;

  for (const attempt of PLAYER_INFO_ATTEMPTS) {
    try {
      const data = await fetchPlayerInfo(
        {
          bvid: context.bvid,
          aid: context.aid ?? null,
          cid: context.cid as number,
          page: context.currentPart.page,
        },
        attempt,
      );
      if (!canUseCurrentVideoTranscriptClearGeneration(options.expectedClearGeneration)) {
        return transcriptClearedDuringRequestState(target, options.now, attempt.sourceType);
      }
      const tracks = extractSubtitleTrackCandidates(data, attempt);

      if (tracks.status !== 'ok') {
        const state = buildCurrentVideoTranscriptEvidenceState({
          status: tracks.status,
          target,
          now: options.now,
          sourceType: attempt.sourceType,
          reason: tracks.reason,
          message: tracks.message,
          warnings: tracks.warnings,
        });
        if (attempt.sourceType === 'bilibili_player_wbi_v2') {
          lastPreBodyFailure = state;
          continue;
        }
        return state;
      }

      const selected = selectSubtitleTrack(tracks.tracks, options.requestedLanguage);
      if (!selected) {
        const state = buildCurrentVideoTranscriptEvidenceState({
          status: 'language_mismatch',
          target,
          now: options.now,
          sourceType: attempt.sourceType,
          reason: 'requested_language_not_found',
          message: '当前字幕来源没有匹配请求语言的字幕轨道；不会把其他语言字幕缓存为当前有效证据。',
          warnings: ['transcript_language_mismatch'],
        });
        if (attempt.sourceType === 'bilibili_player_wbi_v2') {
          lastPreBodyFailure = state;
          continue;
        }
        return state;
      }

      const url = normalizeSubtitleUrl(selected.url);
      if (!url || !isAllowedSubtitleHost(url.hostname)) {
        const state = buildCurrentVideoTranscriptEvidenceState({
          status: 'track_unavailable',
          target,
          now: options.now,
          sourceType: attempt.sourceType,
          reason: 'subtitle_host_unsupported',
          message: '字幕轨道地址不可用或不属于受限的 B 站字幕域名；未读取正文。',
          warnings: ['subtitle_track_host_unsupported'],
        });
        if (attempt.sourceType === 'bilibili_player_wbi_v2') {
          lastPreBodyFailure = state;
          continue;
        }
        return state;
      }

      const subtitleJson = await fetchSubtitleJson(url.toString());
      if (!canUseCurrentVideoTranscriptClearGeneration(options.expectedClearGeneration)) {
        return transcriptClearedDuringRequestState(target, options.now, selected.sourceType);
      }
      return await upsertEvidence(normalizeBilibiliTranscriptEvidence(
        subtitleJson,
        {
          bvid: context.bvid,
          cid: context.cid as number,
          page: context.currentPart.page,
          language: selected.language,
          sourceType: selected.sourceType,
          trackId: selected.id,
          trackUrlHost: url.hostname,
          fetchedAt: options.now,
        },
      ), {
        protectedSourceIdentityKeys: protectedTranscriptSourceIdentityKeys(
          context,
          options.protectedSourceIdentityKeys,
        ),
        temporaryOwner: options.temporaryOwner,
        expectedClearGeneration: options.expectedClearGeneration,
      });
    } catch (error) {
      const message = errorMessage(error);
      lastError = message;
      if (isLoginRequiredError(message)) {
        sawLoginRequired = true;
        continue;
      }
      if (attempt.sourceType === 'bilibili_player_wbi_v2') {
        continue;
      }
    }
  }

  if (sawLoginRequired) {
    return buildCurrentVideoTranscriptEvidenceState({
      status: 'login_required',
      target,
      now: options.now,
      sourceType: 'bilibili_player_v2',
      reason: 'login_required',
      message: 'B 站字幕正文接口需要当前浏览器会话权限；未读取本地 Cookie 或登录态文件，当前仍使用元数据和简介作为本地证据结果。',
      warnings: ['transcript_login_required'],
    });
  }

  if (!lastError && lastPreBodyFailure) {
    return lastPreBodyFailure;
  }

  return buildCurrentVideoTranscriptEvidenceState({
    status: 'endpoint_failed',
    target,
    now: options.now,
    sourceType: 'bilibili_player_v2',
    reason: lastError ?? 'endpoint_failed',
    message: 'B 站字幕正文请求失败；当前仍使用元数据和简介作为本地证据结果。',
    warnings: ['transcript_endpoint_failed'],
  });
}

async function defaultUpsertEvidence(
  evidence: CurrentVideoTranscriptEvidenceWrite,
  options: {
    protectedSourceIdentityKeys?: Iterable<string>;
    temporaryOwner?: CurrentVideoTemporaryTranscriptOwner;
    expectedClearGeneration?: number;
  } = {},
): Promise<CurrentVideoTranscriptEvidenceState> {
  return await upsertCurrentVideoTranscriptEvidence(evidence, options);
}

function transcriptClearedDuringRequestState(
  target: { bvid: string; cid: number; page: number; language: string | null },
  now: number,
  sourceType: CurrentVideoSubtitleSourceType,
): CurrentVideoTranscriptEvidenceState {
  return buildCurrentVideoTranscriptEvidenceState({
    status: 'missing',
    target,
    now,
    sourceType,
    reason: 'transcript_cache_cleared_during_request',
    message: '字幕缓存已在本次检测过程中被清理；请重新检测当前视频字幕正文。',
    warnings: ['transcript_cache_cleared_during_request'],
  });
}

const fetchBilibiliPlayerInfo: CurrentVideoSubtitlePlayerInfoFetcher = async (
  target,
  options,
) => {
  return await biliGet<unknown>(
    options.sourcePath,
    {
      bvid: target.bvid,
      cid: String(target.cid),
    },
    2,
    options.sourceType === 'bilibili_player_wbi_v2',
  );
};

async function defaultFetchSubtitleJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUBTITLE_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      credentials: 'include',
      referrer: 'https://www.bilibili.com/',
      signal: controller.signal,
      headers: {
        Accept: 'application/json, text/plain, */*',
      },
    });
    if (!response.ok) {
      throw new Error(`SUBTITLE_HTTP_${response.status}`);
    }
    return await response.json();
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('REQUEST_TIMEOUT');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

interface SubtitleTrackCandidate {
  id: string | null;
  language: string | null;
  languageLabel: string | null;
  url: string;
  sourceType: CurrentVideoSubtitleSourceType;
}

type TrackExtractionResult =
  | { status: 'ok'; tracks: SubtitleTrackCandidate[] }
  | {
      status: 'malformed' | 'track_unavailable' | 'unsupported';
      reason: string;
      message: string;
      warnings: string[];
    };

function extractSubtitleTrackCandidates(
  data: unknown,
  options: PlayerInfoFetchOptions,
): TrackExtractionResult {
  const root = asRecord(data);
  const subtitle = asRecord(root?.subtitle);
  if (!subtitle) {
    return {
      status: 'unsupported',
      reason: 'subtitle_field_missing',
      message: '播放器接口没有返回字幕字段；无法缓存字幕正文证据。',
      warnings: ['subtitle_field_missing'],
    };
  }

  if (!Array.isArray(subtitle.subtitles)) {
    return {
      status: 'malformed',
      reason: 'subtitle_tracks_not_array',
      message: '播放器字幕列表结构异常；未读取或缓存字幕正文证据。',
      warnings: ['subtitle_malformed'],
    };
  }

  if (subtitle.subtitles.length === 0) {
    return {
      status: 'track_unavailable',
      reason: 'subtitle_tracks_empty',
      message: '当前视频没有可用字幕轨道；仍使用元数据和简介作为本地证据结果。',
      warnings: ['transcript_unavailable'],
    };
  }

  const tracks = subtitle.subtitles
    .map((item): SubtitleTrackCandidate | null => {
      const track = asRecord(item);
      if (!track) return null;
      const url = normalizeText(track.subtitle_url ?? track.url);
      if (!url) return null;
      return {
        id: normalizeText(track.id ?? track.ai_type ?? track.type),
        language: normalizeText(track.lan ?? track.lang ?? track.language),
        languageLabel: normalizeText(track.lan_doc ?? track.language_label ?? track.label),
        url,
        sourceType: options.sourceType,
      };
    })
    .filter((track): track is SubtitleTrackCandidate => Boolean(track));

  if (tracks.length === 0) {
    return {
      status: 'track_unavailable',
      reason: 'subtitle_track_url_missing',
      message: '播放器返回了字幕轨道，但没有可读取的字幕正文地址；未缓存字幕正文证据。',
      warnings: ['subtitle_track_url_unavailable'],
    };
  }

  return { status: 'ok', tracks };
}

function selectSubtitleTrack(
  tracks: SubtitleTrackCandidate[],
  requestedLanguage: string | null | undefined,
): SubtitleTrackCandidate | null {
  const normalizedRequest = normalizeLanguage(requestedLanguage);
  if (normalizedRequest) {
    return tracks.find(track => normalizeLanguage(track.language) === normalizedRequest) ?? null;
  }

  return [...tracks].sort((a, b) => subtitleLanguagePriority(a.language) - subtitleLanguagePriority(b.language))[0] ?? null;
}

function protectedTranscriptSourceIdentityKeys(
  context: CurrentVideoContext,
  extraKeys: Iterable<string> | undefined,
): string[] {
  const keys = new Set<string>();
  const addKey = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) {
      keys.add(value.trim());
    }
  };

  addKey(context.transcriptEvidence?.sourceIdentityKey);
  if (extraKeys) {
    for (const key of extraKeys) {
      addKey(key);
    }
  }
  return Array.from(keys);
}

function normalizeSubtitleUrl(value: string): URL | null {
  try {
    const withProtocol = value.startsWith('//') ? `https:${value}` : value;
    const url = new URL(withProtocol);
    if (url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

function isAllowedSubtitleHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'bilibili.com'
    || host.endsWith('.bilibili.com')
    || host === 'hdslb.com'
    || host.endsWith('.hdslb.com');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text || null;
}

function normalizeLanguage(value: unknown): string | null {
  return normalizeText(value)?.toLowerCase() ?? null;
}

function isLoginRequiredError(message: string): boolean {
  return message === 'NOT_LOGGED_IN'
    || /-101/.test(message)
    || /-403/.test(message)
    || /SUBTITLE_HTTP_40[13]/.test(message)
    || /\b40[13]\b/.test(message);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
