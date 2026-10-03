import { preferredTextIdentity } from './automatic-subtitles.ts';
export const CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY = 'currentVideoPrimaryTextSelections';

export type CurrentVideoPrimaryTextSelections = Record<string, string>;

export interface CurrentVideoPrimaryTextPartIdentity {
  bvid: string;
  cid: number | null;
  page: number;
}

export interface SaveCurrentVideoPrimaryTextSelectionResult {
  partKey: string;
  selectedSourceIdentityKey: string;
  selections: CurrentVideoPrimaryTextSelections;
}

export type CurrentVideoPrimaryTextSelectionReadStatus =
  | 'loading'
  | 'ready'
  | 'failed'
  | 'saving';

export interface CurrentVideoPrimaryTextSelectionReader {
  get(key: string): Promise<Record<string, unknown>>;
}

export type CurrentVideoPrimaryTextSelectionReadResult =
  | { status: 'ready'; selections: CurrentVideoPrimaryTextSelections }
  | { status: 'failed'; selections: CurrentVideoPrimaryTextSelections };

export interface CurrentVideoPrimaryTextAuthorizationInput {
  readStatus: CurrentVideoPrimaryTextSelectionReadStatus;
  identity: CurrentVideoPrimaryTextPartIdentity;
  selections: CurrentVideoPrimaryTextSelections;
  availableSourceIdentityKeys: string[];
}

export interface CurrentVideoPrimaryTextAuthorization {
  ready: boolean;
  source: 'saved' | 'single_available' | 'automatic' | null;
  selectedSourceIdentityKey: string | null;
  message: string | null;
  params: {
    primaryTextSelectionsReady: boolean;
    selectedSourceIdentityKey?: string;
  };
}

export function currentVideoPrimaryTextPartKey(
  identity: CurrentVideoPrimaryTextPartIdentity,
): string | null {
  const bvid = identity.bvid.trim();
  const cid = Number(identity.cid);
  const page = Number(identity.page);
  if (!bvid || !Number.isInteger(cid) || cid <= 0 || !Number.isInteger(page) || page <= 0) {
    return null;
  }
  return [bvid, cid, page].join(':');
}

export function normalizeCurrentVideoPrimaryTextSelections(
  value: unknown,
): CurrentVideoPrimaryTextSelections {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  const selections: CurrentVideoPrimaryTextSelections = {};
  for (const [partKey, sourceIdentityKey] of Object.entries(value as Record<string, unknown>)) {
    const normalizedPartKey = partKey.trim();
    const normalizedSourceIdentityKey = typeof sourceIdentityKey === 'string'
      ? sourceIdentityKey.trim()
      : '';
    if (normalizedPartKey && normalizedSourceIdentityKey) {
      selections[normalizedPartKey] = normalizedSourceIdentityKey;
    }
  }
  return selections;
}

export function normalizeCurrentVideoPrimaryTextSourceIdentityKeys(
  values: readonly unknown[],
): string[] {
  return Array.from(new Set(
    values
      .filter((value): value is string => typeof value === 'string')
      .map(value => value.trim())
      .filter(Boolean),
  ));
}

export async function readCurrentVideoPrimaryTextSelections(
  storage: CurrentVideoPrimaryTextSelectionReader,
): Promise<CurrentVideoPrimaryTextSelectionReadResult> {
  try {
    const stored = await storage.get(CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY);
    return {
      status: 'ready',
      selections: normalizeCurrentVideoPrimaryTextSelections(
        stored?.[CURRENT_VIDEO_PRIMARY_TEXT_SELECTIONS_STORAGE_KEY],
      ),
    };
  } catch {
    return { status: 'failed', selections: {} };
  }
}

export function resolveCurrentVideoPrimaryTextAuthorization(
  input: CurrentVideoPrimaryTextAuthorizationInput,
): CurrentVideoPrimaryTextAuthorization {
  if (input.readStatus === 'saving') {
    return blockedAuthorization('正在保存主要文本来源，请保存完成后再继续。');
  }
  if (input.readStatus === 'loading') {
    return blockedAuthorization('正在读取本页保存的主要文本来源选择，请稍等后再试。');
  }
  if (input.readStatus === 'failed') {
    return blockedAuthorization('保存的主要文本来源选择读取失败，请稍后重试。');
  }

  const partKey = currentVideoPrimaryTextPartKey(input.identity);
  if (!partKey) {
    return blockedAuthorization('当前视频分 P 身份信息不完整，请刷新视频页后重试。');
  }

  const selections = normalizeCurrentVideoPrimaryTextSelections(input.selections);
  const availableSourceIdentityKeys = normalizeCurrentVideoPrimaryTextSourceIdentityKeys(
    input.availableSourceIdentityKeys,
  );
  const savedSourceIdentityKey = selections[partKey] ?? null;
  if (savedSourceIdentityKey) {
    const preferred = preferredTextIdentity(availableSourceIdentityKeys, savedSourceIdentityKey);
    if (preferred) {
      return readyAuthorization(preferred, 'saved');
    }
    return blockedAuthorization('此前保存的主要文本来源已不可用，请到视频页助手重新选择当前来源。');
  }

  if (availableSourceIdentityKeys.length === 1) {
    return readyAuthorization(availableSourceIdentityKeys[0], 'single_available');
  }
  if (availableSourceIdentityKeys.length > 1) {
    const preferred = preferredTextIdentity(availableSourceIdentityKeys);
    if (preferred) return readyAuthorization(preferred, 'automatic');
    return blockedAuthorization('当前分 P 有多个文本来源，请先在视频页中明确选择一个来源。');
  }
  return blockedAuthorization('当前分 P 暂无字幕，开启播放器字幕后会自动接收。');
}

function readyAuthorization(
  selectedSourceIdentityKey: string,
  source: 'saved' | 'single_available' | 'automatic',
): CurrentVideoPrimaryTextAuthorization {
  return {
    ready: true,
    source,
    selectedSourceIdentityKey,
    message: null,
    params: {
      primaryTextSelectionsReady: true,
      selectedSourceIdentityKey,
    },
  };
}

function blockedAuthorization(message: string): CurrentVideoPrimaryTextAuthorization {
  return {
    ready: false,
    source: null,
    selectedSourceIdentityKey: null,
    message,
    params: { primaryTextSelectionsReady: false },
  };
}
