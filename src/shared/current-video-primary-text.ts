import type { CurrentVideoSubtitleSourceType } from './types/current-video-context';
import { stableDigestHex } from './stable-digest.ts';

export type CurrentVideoPrimaryTextSourceKind = 'bilibili_subtitle' | 'local_transcript';

export type CurrentVideoPrimaryTextSourceStatus =
  | 'available'
  | 'temporary'
  | 'missing'
  | 'incomplete';

export interface CurrentVideoTextLine {
  lineNo?: number;
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export interface CurrentVideoTextSourceIdentity {
  bvid: string;
  cid: number;
  page: number;
  source: CurrentVideoPrimaryTextSourceKind;
  sourceType: CurrentVideoSubtitleSourceType | 'local_transcript';
  language: string | null;
  bodyHash: string;
  timelineHash: string;
  sourceHash: string;
  sourceIdentityKey: string;
  lineCount: number;
}

export interface CurrentVideoCanonicalTextSourceRecord {
  version: 1;
  kind: 'current-video-primary-text-source';
  bvid: string;
  cid: number;
  page: number;
  source: CurrentVideoPrimaryTextSourceKind;
  sourceType: CurrentVideoSubtitleSourceType | 'local_transcript';
  language: string | null;
  bodyHash: string;
  timelineHash: string;
  lineCount: number;
}

export interface CurrentVideoPrimaryTextSourceOption {
  identity: CurrentVideoTextSourceIdentity;
  label: 'B站字幕' | '本地转录';
  status: CurrentVideoPrimaryTextSourceStatus;
  lineCount: number;
  byteSize: number;
  temporary: boolean;
  selectedByUser: boolean;
}

export type CurrentVideoPrimaryTextStatus =
  | 'no_body'
  | 'single_source_ready'
  | 'multiple_sources_need_choice'
  | 'selected_source_ready'
  | 'selected_source_missing';

export interface CurrentVideoPrimaryTextState {
  status: CurrentVideoPrimaryTextStatus;
  sources: CurrentVideoPrimaryTextSourceOption[];
  primarySource: CurrentVideoPrimaryTextSourceOption | null;
  showSourceSwitcher: boolean;
  userMessage: string;
  action: string;
}

export interface BuildCurrentVideoPrimaryTextStateInput {
  bvid: string;
  cid: number | null;
  page: number;
  sources: CurrentVideoPrimaryTextSourceOption[];
  selectedSourceIdentityKey?: string | null;
}

export type CurrentVideoFullTextOperation = 'summary_highlights' | 'qa';

export interface CurrentVideoFullTextRequestEnvelope {
  requestId: string;
  operation: CurrentVideoFullTextOperation;
  submittedAt: number;
  model: string;
  video: {
    bvid: string;
    cid: number;
    page: number;
    title: string | null;
    partTitle: string | null;
    durationSeconds: number | null;
  };
  source: CurrentVideoPrimaryTextSourceKind;
  sourceLabel: 'B站字幕' | '本地转录';
  language: string | null;
  primaryTextIdentity: CurrentVideoTextSourceIdentity;
  text: {
    lineCount: number;
    charCount: number;
    utf8Bytes: number;
    lines: ReadonlyArray<Readonly<Required<CurrentVideoTextLine>>>;
  };
  sessionId?: string;
  turnId?: string;
}

export interface BuildCurrentVideoFullTextRequestEnvelopeInput {
  requestId?: string;
  operation: CurrentVideoFullTextOperation;
  submittedAt: number;
  model: string;
  video: {
    bvid: string;
    cid: number;
    page: number;
    title?: string | null;
    partTitle?: string | null;
    durationSeconds?: number | null;
  };
  source: CurrentVideoPrimaryTextSourceKind;
  sourceType: CurrentVideoSubtitleSourceType | 'local_transcript';
  sourceLabel?: 'B站字幕' | '本地转录';
  language?: string | null;
  lines: CurrentVideoTextLine[];
  sessionId?: string;
  turnId?: string;
}

export type CurrentVideoFullTextCommitDecision =
  | { ok: true; current: boolean; reason: 'active_request' | 'snapshot_target_only' }
  | { ok: false; current: false; reason: 'invalidated' | 'replaced' | 'wrong_target' | 'identity_mismatch' };

let requestSequence = 0;

export function buildCurrentVideoTextSourceIdentity(input: {
  bvid: string;
  cid: number;
  page: number;
  source: CurrentVideoPrimaryTextSourceKind;
  sourceType: CurrentVideoSubtitleSourceType | 'local_transcript';
  language?: string | null;
  lines: CurrentVideoTextLine[];
}): CurrentVideoTextSourceIdentity {
  const normalizedLines = normalizeTextLines(input.lines);
  const bodyHash = stableDigestHex(canonicalSerialize({
    version: 1,
    kind: 'current-video-primary-text-body',
    lines: normalizedLines.map(line => ({
      lineNo: line.lineNo,
      text: normalizeLineText(line.text),
    })),
  }));
  const timelineHash = stableDigestHex(canonicalSerialize({
    version: 1,
    kind: 'current-video-primary-text-timeline',
    lines: normalizedLines.map(line => ({
      lineNo: line.lineNo,
      startMs: milliseconds(line.startSeconds),
      endMs: milliseconds(line.endSeconds),
    })),
  }));
  const language = normalizeLanguage(input.language);
  const canonicalIdentity = buildCanonicalTextSourceRecord({
    bvid: input.bvid,
    cid: input.cid,
    page: input.page,
    source: input.source,
    sourceType: input.sourceType,
    language,
    bodyHash,
    timelineHash,
    lineCount: normalizedLines.length,
  });
  const sourceHash = stableDigestHex(canonicalSerialize(canonicalIdentity));

  return {
    bvid: input.bvid,
    cid: input.cid,
    page: input.page,
    source: input.source,
    sourceType: input.sourceType,
    language,
    bodyHash,
    timelineHash,
    sourceHash,
    sourceIdentityKey: [
      'primary-text',
      input.source,
      input.bvid,
      input.cid,
      input.page,
      languageKey(language),
      sourceHash,
    ].join(':'),
    lineCount: normalizedLines.length,
  };
}

export function buildCanonicalTextSourceRecord(input: Omit<CurrentVideoCanonicalTextSourceRecord, 'version' | 'kind'>): CurrentVideoCanonicalTextSourceRecord {
  return {
    version: 1,
    kind: 'current-video-primary-text-source',
    bvid: input.bvid,
    cid: input.cid,
    page: input.page,
    source: input.source,
    sourceType: input.sourceType,
    language: input.language,
    bodyHash: input.bodyHash,
    timelineHash: input.timelineHash,
    lineCount: input.lineCount,
  };
}

export function serializeCurrentVideoCanonicalRecord(value: unknown): string {
  return canonicalSerialize(value);
}

export function buildPrimaryTextSourceOption(input: {
  identity: CurrentVideoTextSourceIdentity;
  byteSize: number;
  status?: CurrentVideoPrimaryTextSourceStatus;
  selectedByUser?: boolean;
  temporary?: boolean;
}): CurrentVideoPrimaryTextSourceOption {
  return {
    identity: input.identity,
    label: input.identity.source === 'bilibili_subtitle' ? 'B站字幕' : '本地转录',
    status: input.status ?? (input.temporary ? 'temporary' : 'available'),
    lineCount: input.identity.lineCount,
    byteSize: Math.max(0, Math.floor(input.byteSize)),
    temporary: input.temporary === true,
    selectedByUser: input.selectedByUser === true,
  };
}

export function buildCurrentVideoPrimaryTextState(
  input: BuildCurrentVideoPrimaryTextStateInput,
): CurrentVideoPrimaryTextState {
  const matchingSources = input.sources
    .filter(source =>
      source.status === 'available'
      || source.status === 'temporary',
    )
    .filter(source =>
      source.identity.bvid === input.bvid
      && source.identity.cid === input.cid
      && source.identity.page === input.page,
    );
  const selected = input.selectedSourceIdentityKey
    ? matchingSources.find(source => source.identity.sourceIdentityKey === input.selectedSourceIdentityKey) ?? null
    : null;

  if (selected) {
    return {
      status: 'selected_source_ready',
      sources: matchingSources,
      primarySource: { ...selected, selectedByUser: true },
      showSourceSwitcher: matchingSources.length > 1,
      userMessage: `${selected.label}已作为当前视频 AI 助手的主要文本来源。`,
      action: '只有再次明确选择其他来源后，主要文本来源才会改变。',
    };
  }

  if (input.selectedSourceIdentityKey && !selected) {
    return {
      status: 'selected_source_missing',
      sources: matchingSources,
      primarySource: null,
      showSourceSwitcher: matchingSources.length > 1,
      userMessage: '此前选择的主要文本来源已经不可用。',
      action: '请重新检测字幕正文；清除后不会自动切换到另一个来源。',
    };
  }

  if (matchingSources.length === 1) {
    const [source] = matchingSources;
    return {
      status: 'single_source_ready',
      sources: matchingSources,
      primarySource: source,
      showSourceSwitcher: false,
      userMessage: `当前只有一个可用文本来源：${source.label}。`,
      action: '无需切换来源；后续完整文本任务会绑定这个来源身份。',
    };
  }

  if (matchingSources.length > 1) {
    return {
      status: 'multiple_sources_need_choice',
      sources: matchingSources,
      primarySource: null,
      showSourceSwitcher: true,
      userMessage: '当前有多个可用文本来源。',
      action: '请选择一个来源用于当前视频 AI 助手，查看字幕来源本身不会改变主要来源。',
    };
  }

  return {
    status: 'no_body',
    sources: [],
    primarySource: null,
    showSourceSwitcher: false,
    userMessage: '当前还没有可用的视频正文。',
    action: '请先在 B 站播放器中手动开启“中文 AI”字幕，然后重新检测字幕。',
  };
}

export function buildCurrentVideoFullTextRequestEnvelope(
  input: BuildCurrentVideoFullTextRequestEnvelopeInput,
): Readonly<CurrentVideoFullTextRequestEnvelope> {
  const lines = normalizeTextLines(input.lines);
  const identity = buildCurrentVideoTextSourceIdentity({
    bvid: input.video.bvid,
    cid: input.video.cid,
    page: input.video.page,
    source: input.source,
    sourceType: input.sourceType,
    language: input.language ?? null,
    lines,
  });
  const text = lines.map(line => Object.freeze(line));
  const plainText = text.map(line => `${line.lineNo}\t${formatSeconds(line.startSeconds)}-${formatSeconds(line.endSeconds)}\t${line.text}`).join('\n');
  const envelope: CurrentVideoFullTextRequestEnvelope = {
    requestId: input.requestId ?? createCurrentVideoFullTextRequestId(),
    operation: input.operation,
    submittedAt: input.submittedAt,
    model: input.model,
    video: {
      bvid: input.video.bvid,
      cid: input.video.cid,
      page: input.video.page,
      title: input.video.title ?? null,
      partTitle: input.video.partTitle ?? null,
      durationSeconds: input.video.durationSeconds ?? null,
    },
    source: input.source,
    sourceLabel: input.sourceLabel ?? (input.source === 'bilibili_subtitle' ? 'B站字幕' : '本地转录'),
    language: identity.language,
    primaryTextIdentity: identity,
    text: {
      lineCount: text.length,
      charCount: plainText.length,
      utf8Bytes: utf8ByteLength(plainText),
      lines: Object.freeze(text),
    },
    sessionId: input.sessionId,
    turnId: input.turnId,
  };

  return deepFreeze(envelope);
}

export function createCurrentVideoFullTextRequestId(prefix = 'cvft'): string {
  requestSequence = (requestSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `${prefix}-${Date.now().toString(36)}-${requestSequence.toString(36)}`;
}

export class CurrentVideoFullTextRequestGuard {
  private readonly activeByTarget = new Map<string, string>();
  private readonly invalidated = new Set<string>();

  start(envelope: CurrentVideoFullTextRequestEnvelope): void {
    this.activeByTarget.set(currentVideoFullTextRequestTargetKey(envelope), envelope.requestId);
    this.invalidated.delete(envelope.requestId);
  }

  cancel(requestId: string): void {
    if (Array.from(this.activeByTarget.values()).includes(requestId)) {
      this.invalidated.add(requestId);
    }
  }

  retry(previous: CurrentVideoFullTextRequestEnvelope, next: CurrentVideoFullTextRequestEnvelope): void {
    this.cancel(previous.requestId);
    this.start(next);
  }

  clearPrimaryText(identity: Pick<CurrentVideoTextSourceIdentity, 'sourceIdentityKey'>): void {
    for (const [targetKey, requestId] of this.activeByTarget.entries()) {
      if (targetKey.includes(`|${identity.sourceIdentityKey}|`)) {
        this.invalidated.add(requestId);
        this.activeByTarget.delete(targetKey);
      }
    }
  }

  settle(envelope: CurrentVideoFullTextRequestEnvelope): void {
    const targetKey = currentVideoFullTextRequestTargetKey(envelope);
    if (this.activeByTarget.get(targetKey) === envelope.requestId) {
      this.activeByTarget.delete(targetKey);
    }
    this.invalidated.delete(envelope.requestId);
  }

  canCommit(
    envelope: CurrentVideoFullTextRequestEnvelope,
    currentIdentity?: Pick<CurrentVideoTextSourceIdentity, 'sourceIdentityKey'> | null,
  ): CurrentVideoFullTextCommitDecision {
    if (this.invalidated.has(envelope.requestId)) {
      return { ok: false, current: false, reason: 'invalidated' };
    }

    const active = this.activeByTarget.get(currentVideoFullTextRequestTargetKey(envelope));
    if (!active) {
      return { ok: false, current: false, reason: 'wrong_target' };
    }
    if (active !== envelope.requestId) {
      return { ok: false, current: false, reason: 'replaced' };
    }
    if (currentIdentity && currentIdentity.sourceIdentityKey !== envelope.primaryTextIdentity.sourceIdentityKey) {
      return { ok: true, current: false, reason: 'snapshot_target_only' };
    }
    return { ok: true, current: true, reason: 'active_request' };
  }
}

export function currentVideoFullTextRequestTargetKey(
  envelope: CurrentVideoFullTextRequestEnvelope,
): string {
  return [
    envelope.operation,
    envelope.video.bvid,
    envelope.video.cid,
    envelope.video.page,
    envelope.primaryTextIdentity.sourceIdentityKey,
    envelope.sessionId ?? '',
    envelope.turnId ?? '',
  ].join('|');
}

export function normalizeTextLines(lines: CurrentVideoTextLine[]): Array<Required<CurrentVideoTextLine>> {
  return lines
    .map((line, index) => ({
      lineNo: line.lineNo ?? index + 1,
      startSeconds: normalizeSeconds(line.startSeconds),
      endSeconds: normalizeSeconds(line.endSeconds),
      text: normalizeLineText(line.text),
    }))
    .filter(line => line.text && line.endSeconds > line.startSeconds)
    .sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds || a.lineNo - b.lineNo)
    .map((line, index) => ({ ...line, lineNo: index + 1 }));
}

function normalizeLineText(value: string): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeSeconds(value: number): number {
  return Math.round(Math.max(0, Number.isFinite(value) ? value : 0) * 1000) / 1000;
}

function milliseconds(value: number): number {
  return Math.round(normalizeSeconds(value) * 1000);
}

function formatSeconds(value: number): string {
  return (Math.round(value * 1000) / 1000).toFixed(3);
}

function normalizeLanguage(value: string | null | undefined): string | null {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  return text ? text : null;
}

function languageKey(value: string | null | undefined): string {
  return (value ?? 'unknown').trim().toLowerCase() || 'unknown';
}

function canonicalSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalSerialize(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalSerialize(record[key])}`)
    .join(',')}}`;
}

function utf8ByteLength(value: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(value).byteLength;
  }
  return value.length;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (!value || typeof value !== 'object') return value as Readonly<T>;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (child && typeof child === 'object' && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return value as Readonly<T>;
}
