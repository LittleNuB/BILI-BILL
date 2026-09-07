import type {
  CurrentVideoChapter,
  CurrentVideoContext,
  CurrentVideoNoContext,
  CurrentVideoPart,
} from '../../shared/types/current-video-context';

const DESCRIPTION_LIMIT = 2000;
const BILIBILI_API_BASE = 'https://api.bilibili.com';
const VIEW_INFO_PATH = '/x/web-interface/view';
const PAGE_RUNTIME_REQUEST_TYPE = 'BILI_BILL_PAGE_RUNTIME_REQUEST';
const PAGE_RUNTIME_RESPONSE_TYPE = 'BILI_BILL_PAGE_RUNTIME_RESPONSE';
const PAGE_RUNTIME_SOURCE = 'bili-bill-page-runtime';
const PAGE_RUNTIME_TIMEOUT_MS = 650;

type UnknownRecord = Record<string, unknown>;
type CidSource = 'initial_state' | 'player_info' | 'view_api';

interface BiliInitialState {
  aid?: number;
  avid?: number;
  bvid?: string;
  cid?: number;
  p?: number;
  page?: number;
  currentPart?: { page?: number; cid?: number; part?: string; title?: string; duration?: number };
  videoData?: BiliVideoData;
  upData?: { mid?: number; name?: string };
}

interface BiliVideoData {
  aid?: number;
  avid?: number;
  bvid?: string;
  cid?: number;
  p?: number;
  page?: number;
  title?: string;
  duration?: number;
  desc?: string;
  description?: string;
  owner?: { mid?: number; name?: string };
  currentPart?: { page?: number; cid?: number; part?: string; title?: string; duration?: number };
  pages?: Array<{ page?: number; cid?: number; part?: string; title?: string; duration?: number }>;
  chapters?: Array<{ title?: string; start?: number; startSeconds?: number; start_time?: number }>;
  ugc_season?: {
    sections?: Array<{
      episodes?: Array<{ title?: string; bvid?: string; cid?: number; page?: number; duration?: number }>;
    }>;
  };
}

interface BiliPlayerVideoInfo {
  aid?: number;
  avid?: number;
  bvid?: string;
  cid?: number;
  p?: number;
  page?: number;
  title?: string;
  duration?: number;
  pages?: Array<{ page?: number; cid?: number; part?: string; title?: string; duration?: number }>;
  currentPart?: { page?: number; cid?: number; part?: string; title?: string; duration?: number };
  videoData?: BiliVideoData;
}

interface BiliViewInfo {
  aid?: number;
  avid?: number;
  bvid?: string;
  cid?: number;
  title?: string;
  duration?: number;
  desc?: string;
  description?: string;
  owner?: { mid?: number; name?: string };
  pages?: Array<{ page?: number; cid?: number; part?: string; title?: string; duration?: number }>;
  chapters?: Array<{ title?: string; start?: number; startSeconds?: number; start_time?: number }>;
  ugc_season?: BiliVideoData['ugc_season'];
}

export interface BiliPageRuntimeSnapshot {
  initialState?: BiliInitialState | null;
  playerInfo?: BiliPlayerVideoInfo | null;
}

export type CurrentVideoViewInfoFetcher = (bvid: string) => Promise<BiliViewInfo | null>;
export type CurrentVideoPageRuntimeReader = () => Promise<BiliPageRuntimeSnapshot | null>;

export interface CollectCurrentVideoContextOptions {
  now?: () => number;
  fetchViewInfo?: CurrentVideoViewInfoFetcher;
  readPageRuntime?: CurrentVideoPageRuntimeReader;
}

export function isVideoPage(): boolean {
  return location.pathname.startsWith('/video/');
}

export async function collectCurrentVideoContext(
  options: CollectCurrentVideoContextOptions = {},
): Promise<CurrentVideoContext | CurrentVideoNoContext> {
  if (!isVideoPage()) {
    return buildNoContext('non_video_page', 'non_video', options.now?.() ?? Date.now());
  }

  const now = options.now?.() ?? Date.now();
  const runtime = await readRuntimeSnapshot(options.readPageRuntime);
  const state = runtime?.initialState ?? getInitialState();
  const playerInfo = runtime?.playerInfo ?? getPlayerVideoInfo();
  const urlBvid = extractBvidFromUrl();
  const stateBvid = bvidFromSource(state);
  const playerBvid = bvidFromSource(playerInfo);
  const bvid = urlBvid || playerBvid || stateBvid;

  if (!bvid) {
    return buildNoContext('video_context_unavailable', 'video', now);
  }

  const pageNumber = extractPageFromUrl();
  const canTrustState = canTrustRuntimeSource(urlBvid, stateBvid);
  const canTrustPlayer = canTrustRuntimeSource(urlBvid, playerBvid);
  const stateSource = canTrustState ? state : null;
  const playerSource = canTrustPlayer ? playerInfo : null;
  let viewInfo: BiliViewInfo | null = null;
  let viewFetchFailed = false;

  let resolution = resolveIdentity({
    pageNumber,
    sources: [
      { kind: 'initial_state', value: stateSource, allowPageAgnosticCid: false },
      { kind: 'player_info', value: playerSource, allowPageAgnosticCid: true },
    ],
  });

  if (!resolution.cid || resolution.parts.length === 0) {
    try {
      viewInfo = await (options.fetchViewInfo ?? fetchBilibiliViewInfo)(bvid);
    } catch {
      viewFetchFailed = true;
    }

    if (viewInfo && canTrustRuntimeSource(urlBvid, bvidFromSource(viewInfo))) {
      resolution = resolveIdentity({
        pageNumber,
        sources: [
          { kind: 'initial_state', value: stateSource, allowPageAgnosticCid: false },
          { kind: 'player_info', value: playerSource, allowPageAgnosticCid: true },
          { kind: 'view_api', value: viewInfo, allowPageAgnosticCid: false },
        ],
      });
    }
  }

  const parts = resolution.parts;
  const currentPart = resolution.currentPart;
  const cid = resolution.cid;
  const aid = firstNumber(
    aidFromSource(stateSource),
    aidFromSource(playerSource),
    aidFromSource(viewInfo),
  );
  const title = firstString(
    titleFromSource(stateSource),
    titleFromSource(playerSource),
    titleFromSource(viewInfo),
    collectTitleFromDocument(),
  );
  const authorName = firstString(
    ownerNameFromSource(stateSource),
    ownerNameFromSource(viewInfo),
  );
  const authorMid = firstNumber(
    ownerMidFromSource(stateSource),
    ownerMidFromSource(viewInfo),
  );
  const durationSeconds = firstNumber(
    currentPart?.durationSeconds,
    durationFromSource(stateSource),
    durationFromSource(playerSource),
    durationFromSource(viewInfo),
  );
  const descriptionText = firstString(
    descriptionFromSource(stateSource),
    descriptionFromSource(viewInfo),
    collectDescriptionFromDocument(),
  )?.slice(0, DESCRIPTION_LIMIT) ?? null;
  const chapters = firstNonEmptyArray(
    collectChapters(stateSource),
    collectChapters(viewInfo),
  );
  const descriptionAvailability = descriptionText ? 'available' : 'unavailable';
  const pagesAvailability = parts.length > 0 ? 'available' : 'unavailable';
  const chaptersAvailability = chapters.length > 0 ? 'available' : 'unknown';
  const warnings: string[] = [];

  if (urlBvid && stateBvid && stateBvid !== urlBvid) warnings.push('state_bvid_mismatch');
  if (urlBvid && playerBvid && playerBvid !== urlBvid) warnings.push('player_bvid_mismatch');
  if (viewFetchFailed) warnings.push('view_api_failed');
  if (resolution.cidSource) warnings.push(`cid_source_${resolution.cidSource}`);
  if (!cid) warnings.push('cid_unknown');
  if (!title) warnings.push('title_unknown');
  if (!authorName && !authorMid) warnings.push('author_unknown');
  if (!durationSeconds) warnings.push('duration_unknown');
  if (!descriptionText) warnings.push('description_unavailable');
  warnings.push('transcript_probe_pending');

  return {
    kind: 'video',
    url: location.href,
    collectedAt: now,
    bvid,
    aid,
    cid,
    title,
    authorName,
    authorMid,
    durationSeconds,
    currentPart: {
      page: pageNumber,
      title: currentPart?.title ?? null,
      total: parts.length > 0 ? parts.length : null,
    },
    parts,
    chapters,
    description: {
      availability: descriptionAvailability,
      text: descriptionText,
      length: descriptionText?.length ?? null,
    },
    sources: {
      metadata: 'available',
      description: descriptionAvailability,
      pages: pagesAvailability,
      chapters: chaptersAvailability,
      transcript: 'unknown',
      contentText: 'unavailable',
    },
    subtitleProbe: null,
    warnings,
  };
}

export function withVideoElementDuration(
  context: CurrentVideoContext,
  video: HTMLVideoElement,
): CurrentVideoContext {
  if (context.durationSeconds || !Number.isFinite(video.duration) || video.duration <= 0) {
    return context;
  }

  return {
    ...context,
    collectedAt: Date.now(),
    durationSeconds: Math.round(video.duration),
    warnings: context.warnings.filter(warning => warning !== 'duration_unknown'),
  };
}

function buildNoContext(
  reason: CurrentVideoNoContext['reason'],
  pageType: CurrentVideoNoContext['pageType'],
  now: number,
): CurrentVideoNoContext {
  return {
    kind: 'no_context',
    url: location.href,
    collectedAt: now,
    reason,
    pageType,
  };
}

async function readRuntimeSnapshot(
  reader?: CurrentVideoPageRuntimeReader,
): Promise<BiliPageRuntimeSnapshot | null> {
  if (reader) return await reader();

  const directInitialState = getInitialState();
  const directPlayerInfo = getPlayerVideoInfo();
  if (directInitialState || directPlayerInfo) {
    return { initialState: directInitialState, playerInfo: directPlayerInfo };
  }

  const scriptInitialState = getInitialStateFromScriptTag();
  const bridged = await readPageRuntimeSnapshotFromBridge();
  return {
    initialState: bridged?.initialState ?? scriptInitialState,
    playerInfo: bridged?.playerInfo ?? null,
  };
}

function getInitialState(): BiliInitialState | null {
  try {
    return ((window as unknown as { __INITIAL_STATE__?: BiliInitialState }).__INITIAL_STATE__) ?? null;
  } catch {
    return null;
  }
}

function getPlayerVideoInfo(): BiliPlayerVideoInfo | null {
  try {
    const player = (window as unknown as { player?: { getVideoInfo?: () => unknown } }).player;
    const info = player?.getVideoInfo?.();
    return asRecord(info) as BiliPlayerVideoInfo | null;
  } catch {
    return null;
  }
}

function getInitialStateFromScriptTag(): BiliInitialState | null {
  const scripts = Array.from(document.querySelectorAll('script'));
  for (const script of scripts) {
    const text = script.textContent ?? '';
    if (!text.includes('__INITIAL_STATE__')) continue;
    const match = text.match(/(?:window\.)?__INITIAL_STATE__\s*=\s*(\{.*?\})\s*;\s*(?:\(function|\n|$)/s);
    if (!match?.[1]) continue;
    try {
      return JSON.parse(match[1]) as BiliInitialState;
    } catch {
      continue;
    }
  }
  return null;
}

export async function readPageRuntimeSnapshotFromBridge(): Promise<BiliPageRuntimeSnapshot | null> {
  if (typeof window === 'undefined' || typeof window.postMessage !== 'function') return null;

  const requestId = `bili-bill-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return await new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      window.clearTimeout(timer);
    };
    const finish = (value: BiliPageRuntimeSnapshot | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onMessage = (event: MessageEvent) => {
      const data = asRecord(event.data);
      if (
        event.source !== window
        || data?.source !== PAGE_RUNTIME_SOURCE
        || data?.type !== PAGE_RUNTIME_RESPONSE_TYPE
        || data?.requestId !== requestId
      ) {
        return;
      }
      finish(asRecord(data.payload) as BiliPageRuntimeSnapshot | null);
    };
    const timer = window.setTimeout(() => finish(null), PAGE_RUNTIME_TIMEOUT_MS);
    window.addEventListener('message', onMessage);
    window.postMessage({
      source: 'bili-bill-content-script',
      type: PAGE_RUNTIME_REQUEST_TYPE,
      requestId,
    }, '*');
  });
}

async function fetchBilibiliViewInfo(bvid: string): Promise<BiliViewInfo | null> {
  const url = new URL(VIEW_INFO_PATH, BILIBILI_API_BASE);
  url.searchParams.set('bvid', bvid);
  const response = await fetch(url.toString(), {
    credentials: 'include',
    referrer: 'https://www.bilibili.com/',
    headers: { Accept: 'application/json, text/plain, */*' },
  });
  const json = await response.json() as { code?: number; data?: unknown };
  if (json.code !== 0) return null;
  return asRecord(json.data) as BiliViewInfo | null;
}

function resolveIdentity(input: {
  pageNumber: number;
  sources: Array<{ kind: CidSource; value: unknown; allowPageAgnosticCid: boolean }>;
}): {
  parts: CurrentVideoPart[];
  currentPart: CurrentVideoPart | null;
  cid: number | null;
  cidSource: CidSource | null;
} {
  const candidates = input.sources
    .map(source => ({
      kind: source.kind,
      parts: collectParts(source.value),
      directCid: directCidFromSource(source.value, input.pageNumber, source.allowPageAgnosticCid),
    }))
    .filter(candidate => candidate.parts.length > 0 || candidate.directCid !== null);

  const partCandidate = candidates.find(candidate => selectCurrentPart(candidate.parts, input.pageNumber)?.cid)
    ?? candidates.find(candidate => candidate.parts.length > 0)
    ?? null;
  const parts = partCandidate?.parts ?? [];
  const currentPart = selectCurrentPart(parts, input.pageNumber);
  const cidFromPart = currentPart?.cid ?? null;
  if (cidFromPart) {
    return { parts, currentPart, cid: cidFromPart, cidSource: partCandidate?.kind ?? null };
  }

  const cidCandidate = candidates.find(candidate => candidate.directCid !== null);
  return {
    parts,
    currentPart,
    cid: cidCandidate?.directCid ?? null,
    cidSource: cidCandidate?.kind ?? null,
  };
}

function collectParts(source: unknown): CurrentVideoPart[] {
  const record = asRecord(source);
  if (!record) return [];

  const videoData = asRecord(record.videoData);
  const pageSources = [
    record.pages,
    videoData?.pages,
    record.currentPart ? [record.currentPart] : null,
    videoData?.currentPart ? [videoData.currentPart] : null,
  ];
  for (const candidate of pageSources) {
    if (Array.isArray(candidate) && candidate.length > 0) {
      return candidate.map((page, index) => normalizePart(page, index));
    }
  }

  const season = asRecord(videoData?.ugc_season ?? record.ugc_season);
  const sections = Array.isArray(season?.sections) ? season.sections : [];
  const episodes = sections.flatMap(section => {
    const sectionRecord = asRecord(section);
    return Array.isArray(sectionRecord?.episodes) ? sectionRecord.episodes : [];
  });
  return episodes.map((episode, index) => normalizePart(episode, index));
}

function normalizePart(value: unknown, index: number): CurrentVideoPart {
  const part = asRecord(value);
  return {
    page: normalizeNumber(part?.page) ?? index + 1,
    cid: normalizeNumber(part?.cid),
    title: normalizeString(part?.part ?? part?.title),
    durationSeconds: normalizeNumber(part?.duration),
  };
}

function selectCurrentPart(parts: CurrentVideoPart[], pageNumber: number): CurrentVideoPart | null {
  return parts.find(part => part.page === pageNumber) ?? parts[0] ?? null;
}

function directCidFromSource(
  source: unknown,
  pageNumber: number,
  allowPageAgnosticCid: boolean,
): number | null {
  const record = asRecord(source);
  if (!record) return null;
  const videoData = asRecord(record.videoData);
  const cid = normalizeNumber(record.cid ?? videoData?.cid);
  if (!cid) return null;

  const sourcePage = normalizeNumber(
    record.page
    ?? record.p
    ?? asRecord(record.currentPart)?.page
    ?? videoData?.page
    ?? videoData?.p
    ?? asRecord(videoData?.currentPart)?.page,
  );
  if (sourcePage !== null) return sourcePage === pageNumber ? cid : null;
  if (allowPageAgnosticCid) return cid;
  return pageNumber === 1 ? cid : null;
}

function collectChapters(source: unknown): CurrentVideoChapter[] {
  const record = asRecord(source);
  const videoData = asRecord(record?.videoData);
  const chapters = record?.chapters ?? videoData?.chapters;
  if (!Array.isArray(chapters)) return [];

  return chapters
    .map(chapter => {
      const item = asRecord(chapter);
      return {
        title: normalizeString(item?.title) ?? '',
        startSeconds: normalizeNumber(item?.startSeconds ?? item?.start ?? item?.start_time),
      };
    })
    .filter(chapter => chapter.title);
}

function bvidFromSource(source: unknown): string {
  const record = asRecord(source);
  const videoData = asRecord(record?.videoData);
  return normalizeString(record?.bvid ?? videoData?.bvid) ?? '';
}

function aidFromSource(source: unknown): number | null {
  const record = asRecord(source);
  const videoData = asRecord(record?.videoData);
  return normalizeNumber(record?.aid ?? record?.avid ?? videoData?.aid ?? videoData?.avid);
}

function titleFromSource(source: unknown): string | null {
  const record = asRecord(source);
  const videoData = asRecord(record?.videoData);
  return normalizeString(record?.title ?? videoData?.title);
}

function ownerNameFromSource(source: unknown): string | null {
  const record = asRecord(source);
  const videoData = asRecord(record?.videoData);
  const owner = asRecord(record?.owner ?? videoData?.owner);
  const upData = asRecord(record?.upData);
  return normalizeString(owner?.name ?? upData?.name);
}

function ownerMidFromSource(source: unknown): number | null {
  const record = asRecord(source);
  const videoData = asRecord(record?.videoData);
  const owner = asRecord(record?.owner ?? videoData?.owner);
  const upData = asRecord(record?.upData);
  return normalizeNumber(owner?.mid ?? upData?.mid);
}

function durationFromSource(source: unknown): number | null {
  const record = asRecord(source);
  const videoData = asRecord(record?.videoData);
  return normalizeNumber(record?.duration ?? videoData?.duration);
}

function descriptionFromSource(source: unknown): string | null {
  const record = asRecord(source);
  const videoData = asRecord(record?.videoData);
  return normalizeString(record?.desc ?? record?.description ?? videoData?.desc ?? videoData?.description);
}

function collectDescriptionFromDocument(): string | null {
  const fromMeta = normalizeString(
    document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content,
  );
  const fromDom = normalizeString(
    document.querySelector<HTMLElement>('.desc-info-text, .video-desc-container, #v_desc .desc-info')?.textContent,
  );
  return fromDom ?? fromMeta;
}

function collectTitleFromDocument(): string | null {
  const rawTitle = normalizeString(document.title);
  if (!rawTitle) return null;
  return rawTitle
    .replace(/_bilibili$/iu, '')
    .trim() || rawTitle;
}

function canTrustRuntimeSource(urlBvid: string, sourceBvid: string): boolean {
  return !urlBvid || !sourceBvid || sourceBvid === urlBvid;
}

function extractBvidFromUrl(): string {
  const match = location.pathname.match(/\/video\/(BV[A-Za-z0-9]+)/);
  return match?.[1] ?? '';
}

function extractPageFromUrl(): number {
  const page = Number(new URLSearchParams(location.search).get('p') ?? '1');
  return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
}

function firstString(...values: Array<string | null | undefined>): string | null {
  return values.find((value): value is string => Boolean(value)) ?? null;
}

function firstNumber(...values: Array<number | null | undefined>): number | null {
  return values.find((value): value is number => typeof value === 'number') ?? null;
}

function firstNonEmptyArray<T>(...values: T[][]): T[] {
  return values.find(value => value.length > 0) ?? [];
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' ? value as UnknownRecord : null;
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  return normalized || null;
}

function normalizeNumber(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.floor(numeric);
}
