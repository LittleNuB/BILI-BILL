import type { CurrentVideoContextResult } from '../shared/types/current-video-context.ts';
import { cancelLearningChats } from './learning-chat-control.ts';
import type { CurrentVideoTranscriptSegment } from '../shared/types/current-video-transcript.ts';
import type { UserConfig } from '../shared/types/config.ts';
import type {
  CurrentVideoFullTextQaCitation,
  CurrentVideoFullTextQaResult,
  CurrentVideoFullTextQaSourceReference,
  CurrentVideoFullTextQaTextSize,
} from '../shared/types/current-video-full-text-qa.ts';
import type { CurrentVideoQaConversationContext } from '../shared/types/current-video-qa-session.ts';
import {
  buildCurrentVideoFullTextRequestEnvelope,
  CurrentVideoFullTextRequestGuard,
  type CurrentVideoFullTextRequestEnvelope,
} from '../shared/current-video-primary-text.ts';
import {
  buildCurrentVideoFullTextQaAiPayload,
  requestCurrentVideoFullTextQaAi,
  validateCurrentVideoFullTextQaAiOutput,
  type CurrentVideoFullTextQaChat,
} from '../shared/current-video-full-text-qa.ts';
import { loadConfig } from './storage/config-store.ts';
import { chatJson } from './ai/openai-compatible.ts';
import { readableModelOutput } from '../shared/readable-model-output.ts';

export interface GenerateCurrentVideoFullTextQaOptions {
  requestId: string;
  sessionId?: string | null;
  turnId: string;
  question: string;
  transcriptSegments: CurrentVideoTranscriptSegment[];
  conversationContext?: CurrentVideoQaConversationContext | null;
  config?: UserConfig;
  configGeneration?: number;
  chat?: CurrentVideoFullTextQaChat;
  now?: number;
  resolveLiveConfig?: () => Promise<UserConfig>;
  sourceDataStillCurrent?: () => boolean | Promise<boolean>;
  authorizationStillEnabled?: () => boolean | Promise<boolean>;
  resolveCurrentIdentity?: () => Promise<{ sourceIdentityKey: string } | null>;
}

interface ActiveQaRequest {
  envelope: CurrentVideoFullTextRequestEnvelope;
  controller: AbortController;
  requestScopeId: string | null;
}

interface PreflightQaRequest {
  requestId: string;
  sessionId: string | null;
  turnId: string;
  sourceIdentityKey: string | null;
  requestScopeId: string | null;
  bvid: string | null;
  cid: number | null;
  page: number | null;
  configGeneration: number;
  cancelled: boolean;
}

interface CompletedQaRequest {
  requestId: string;
  sessionId: string | null;
  turnId: string;
  sourceIdentityKey: string;
  bvid: string;
  cid: number;
  page: number;
  generatedAt: number;
  citations: CurrentVideoFullTextQaCitation[];
}

export interface CurrentVideoFullTextQaCitationLookup {
  sessionId?: string | null;
  requestId: string;
  turnId: string;
  citationId: string;
  sourceIdentityKey: string;
}

export interface CurrentVideoFullTextQaCitationRecord {
  citation: CurrentVideoFullTextQaCitation;
  bvid: string;
  cid: number;
  page: number;
  sourceIdentityKey: string;
  generatedAt: number;
}

const requestGuard = new CurrentVideoFullTextRequestGuard();
const preflightRequests = new Map<string, PreflightQaRequest>();
const activeRequests = new Map<string, ActiveQaRequest>();
const activeRequestByTurn = new Map<string, string>();
const activeRequestBySession = new Map<string, string>();
const completedRequests = new Map<string, CompletedQaRequest>();
const completedRequestByTurn = new Map<string, string>();
const MAX_COMPLETED_REQUESTS = 20;
let configGeneration = 0;

export function registerCurrentVideoFullTextQaPreflightRequest(input: {
  requestId: string;
  sessionId?: string | null;
  turnId: string;
  sourceIdentityKey?: string | null;
  requestScopeId?: string | null;
  bvid?: string | null;
  cid?: number | null;
  page?: number | null;
}): {
  requestId: string;
  sessionId: string | null;
  turnId: string;
  configGeneration: number;
  accepted: boolean;
  blockedReason: string | null;
} {
  const requestId = input.requestId.trim();
  const sessionId = input.sessionId?.trim() || null;
  const turnId = input.turnId.trim();
  const sourceIdentityKey = input.sourceIdentityKey?.trim() || null;
  const requestScopeId = input.requestScopeId?.trim() || null;
  const bvid = input.bvid?.trim() || null;
  const cid = Number.isInteger(input.cid) && Number(input.cid) > 0 ? Number(input.cid) : null;
  const page = Number.isInteger(input.page) && Number(input.page) > 0 ? Number(input.page) : null;
  if (!requestId || !turnId) {
    return { requestId, sessionId, turnId, configGeneration, accepted: false, blockedReason: 'request_invalid' };
  }

  if (
    preflightRequests.has(requestId)
    || activeRequests.has(requestId)
    || completedRequests.has(requestId)
  ) {
    return { requestId, sessionId, turnId, configGeneration, accepted: false, blockedReason: 'request_duplicate' };
  }

  if (sessionId) {
    const activeSessionRequestId = activeRequestBySession.get(sessionId);
    const active = activeSessionRequestId ? activeRequests.get(activeSessionRequestId) : null;
    if (activeSessionRequestId && activeSessionRequestId !== requestId && active?.envelope.turnId !== turnId) {
      return { requestId, sessionId, turnId, configGeneration, accepted: false, blockedReason: 'session_busy' };
    }
    for (const preflight of preflightRequests.values()) {
      if (
        !preflight.cancelled
        && preflight.requestId !== requestId
        && preflight.sessionId === sessionId
        && preflight.turnId !== turnId
      ) {
        return { requestId, sessionId, turnId, configGeneration, accepted: false, blockedReason: 'session_busy' };
      }
    }
  }

  for (const preflight of preflightRequests.values()) {
    if (
      preflight.requestId !== requestId
      && sameQaTurn(preflight.sessionId, preflight.turnId, sessionId, turnId)
    ) {
      preflight.cancelled = true;
      cancelCurrentVideoFullTextQaRequest(preflight.requestId);
    }
  }
  const completedRequestId = completedRequestByTurn.get(fullTextQaTurnKey(sessionId, turnId));
  if (completedRequestId && completedRequestId !== requestId) {
    removeCompletedRequest(completedRequestId);
  }
  preflightRequests.set(requestId, {
    requestId,
    sessionId,
    turnId,
    sourceIdentityKey,
    requestScopeId,
    bvid,
    cid,
    page,
    configGeneration,
    cancelled: false,
  });
  return { requestId, sessionId, turnId, configGeneration, accepted: true, blockedReason: null };
}

export function settleCurrentVideoFullTextQaPreflightRequest(requestId: string): void {
  preflightRequests.delete(requestId.trim());
}

export function bindCurrentVideoFullTextQaPreflightPart(
  requestId: string,
  input: { bvid: string; cid: number; page: number; requestScopeId?: string | null },
): boolean {
  const preflight = preflightRequests.get(requestId.trim());
  if (
    !preflight
    || preflight.cancelled
    || !input.bvid.trim()
    || !Number.isInteger(input.cid)
    || input.cid <= 0
    || !Number.isInteger(input.page)
    || input.page <= 0
  ) {
    return false;
  }
  preflight.bvid = input.bvid.trim();
  preflight.cid = input.cid;
  preflight.page = input.page;
  const requestScopeId = input.requestScopeId?.trim() || null;
  if (requestScopeId) {
    preflight.requestScopeId = requestScopeId;
  }
  return true;
}

export function unavailableCurrentVideoFullTextQa(input: {
  status: 'no_context' | 'no_text' | 'disabled' | 'not_configured' | 'cancelled' | 'error';
  requestId: string;
  sessionId?: string | null;
  turnId: string;
  question: string;
  message: string;
  title?: string | null;
  partTitle?: string | null;
  model?: string | null;
  sourceReference?: CurrentVideoFullTextQaSourceReference | null;
  textSize?: CurrentVideoFullTextQaTextSize;
  now?: number;
}): CurrentVideoFullTextQaResult {
  const statusToAi = {
    no_context: 'failed',
    no_text: 'failed',
    disabled: 'disabled',
    not_configured: 'not_configured',
    cancelled: 'cancelled',
    error: 'failed',
  } as const;
  return baseResult({
    status: input.status,
    requestId: input.requestId.trim(),
    sessionId: input.sessionId?.trim() || null,
    turnId: input.turnId.trim(),
    question: normalizeQuestion(input.question),
    title: input.title?.trim() || '当前视频',
    partTitle: input.partTitle?.trim() || null,
    textSize: input.textSize ?? { lineCount: 0, charCount: null, utf8Bytes: 0 },
    message: input.message,
    aiStatus: statusToAi[input.status],
    model: input.model?.trim() || null,
    sourceReference: input.sourceReference ?? null,
    errorCode: input.status === 'cancelled' ? null : input.status,
    canRetry: true,
    now: input.now ?? Date.now(),
  });
}

export async function generateCurrentVideoFullTextQa(
  context: CurrentVideoContextResult,
  options: GenerateCurrentVideoFullTextQaOptions,
): Promise<CurrentVideoFullTextQaResult> {
  const now = options.now ?? Date.now();
  const question = normalizeQuestion(options.question);
  const requestId = options.requestId.trim();
  const sessionId = options.sessionId?.trim() || null;
  const turnId = options.turnId.trim();
  const config = options.config ?? await loadConfig();
  const model = config.ai.chatModel.trim() || null;
  const title = context.kind === 'video' ? context.title?.trim() || '当前视频' : '当前视频';
  const partTitle = context.kind === 'video' ? context.currentPart.title?.trim() || null : null;
  const approximateSize = approximateTextSize(context);
  const approximateSourceReference = buildSourceReferenceFromContext(context, approximateSize, now);

  if (!requestId || !turnId || !question) {
    return baseResult({
      status: 'error', requestId, turnId, question, title, partTitle, textSize: approximateSize,
      message: '问题没有提交成功，请保留当前问题并重试。',
      aiStatus: 'failed', model, sourceReference: approximateSourceReference, errorCode: 'request_invalid', canRetry: true, now, sessionId,
    });
  }
  if (context.kind !== 'video') {
    return baseResult({
      status: 'no_context', requestId, turnId, question, title, partTitle, textSize: approximateSize,
      message: '当前没有可用的视频上下文，请在 B 站视频页内重新提交。',
      aiStatus: 'failed', model, sourceReference: approximateSourceReference, errorCode: 'no_context', canRetry: true, now, sessionId,
    });
  }
  if (!config.assistant.currentVideoAiAssistantEnabled) {
    return baseResult({
      status: 'disabled', requestId, turnId, question, title, partTitle, textSize: approximateSize,
      message: '当前视频 AI 助手已关闭，问题已保留。开启后可重新提交。',
      aiStatus: 'disabled', model, sourceReference: approximateSourceReference, errorCode: null, canRetry: true, now, sessionId,
    });
  }
  if (!aiConfigured(config)) {
    return baseResult({
      status: 'not_configured', requestId, turnId, question, title, partTitle, textSize: approximateSize,
      message: 'AI 服务尚未配置完成，问题已保留。完成设置后可重新提交。',
      aiStatus: 'not_configured', model, sourceReference: approximateSourceReference, errorCode: null, canRetry: true, now, sessionId,
    });
  }
  if (
    !model
    || !context.cid
    || options.transcriptSegments.length === 0
    || !context.transcriptEvidence?.active
    || !context.transcriptEvidence.sourceIdentityKey
    || !context.transcriptEvidence.sourceType
  ) {
    return baseResult({
      status: 'no_text', requestId, turnId, question, title, partTitle, textSize: approximateSize,
      message: '当前分 P 没有可用的主要文本，无法回答。问题已保留。',
      aiStatus: 'failed', model, sourceReference: approximateSourceReference, errorCode: 'no_text', canRetry: true, now, sessionId,
    });
  }

  const envelope = buildCurrentVideoFullTextRequestEnvelope({
    requestId,
    operation: 'qa',
    submittedAt: now,
    model,
    video: {
      bvid: context.bvid,
      cid: context.cid,
      page: context.currentPart.page,
      title: context.title,
      partTitle: context.currentPart.title,
      durationSeconds: context.durationSeconds,
    },
    source: 'bilibili_subtitle',
    sourceType: context.transcriptEvidence.sourceType,
    sourceLabel: 'B站字幕',
    language: context.transcriptEvidence.language,
    lines: options.transcriptSegments.map(segment => ({
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds,
      text: segment.text,
    })),
    sessionId: sessionId ?? undefined,
    turnId,
  });
  const textSize = textSizeFromEnvelope(envelope);
  const sourceReference = buildSourceReferenceFromEnvelope(envelope, context.url, now);
  if (context.transcriptEvidence.sourceIdentityKey !== envelope.primaryTextIdentity.sourceIdentityKey) {
    return baseResult({
      status: 'no_text', requestId, turnId, question, title, partTitle, textSize,
      message: '当前主要文本已变化，请重新确认来源后提交。',
      aiStatus: 'failed', model, sourceReference, errorCode: 'source_mismatch', canRetry: true, now, sessionId,
    });
  }

  const capturedGeneration = options.configGeneration ?? configGeneration;
  const liveConfig = options.resolveLiveConfig ? await options.resolveLiveConfig() : config;
  if (!liveConfig.assistant.currentVideoAiAssistantEnabled) {
    return baseResult({
      status: 'disabled', requestId, turnId, question, title, partTitle, textSize,
      message: '当前视频 AI 助手已关闭，问题已保留。开启后可重新提交。',
      aiStatus: 'disabled', model: liveConfig.ai.chatModel.trim() || model, sourceReference, errorCode: null, canRetry: true, now, sessionId,
    });
  }
  if (!aiConfigured(liveConfig)) {
    return baseResult({
      status: 'not_configured', requestId, turnId, question, title, partTitle, textSize,
      message: 'AI 服务尚未配置完成，问题已保留。完成设置后可重新提交。',
      aiStatus: 'not_configured', model: liveConfig.ai.chatModel.trim() || model, sourceReference, errorCode: null, canRetry: true, now, sessionId,
    });
  }
  if (!await preflightStillValid(envelope, capturedGeneration, options)) {
    return cancelledResult(envelope, question, title, partTitle, textSize, model, now, sourceReference);
  }

  const active = startNetworkRequest(envelope);
  try {
    let output: unknown;
    try {
      const payload = buildCurrentVideoFullTextQaAiPayload(envelope, question, options.conversationContext ?? null);
      output = await requestCurrentVideoFullTextQaAi(
        liveConfig.ai,
        payload,
        envelope,
        options.chat ?? ((config, messages, requestOptions) => chatJson(config, messages, { ...requestOptions, allowTextResponse: true })),
        { signal: active.controller.signal },
      );
    } catch (error) {
      if (!await requestStillValid(envelope, active, capturedGeneration, options)) {
        return cancelledResult(envelope, question, title, partTitle, textSize, model, Date.now(), sourceReference);
      }
      if (isContextTooLongError(error)) {
        return baseResult({
          status: 'context_too_long', requestId, turnId, question, title, partTitle, textSize,
          message: '当前正文过长，所选模型没有接受本次完整请求；系统不会截断或分段发送。问题已保留，可更换模型后重试。',
          aiStatus: 'context_too_long', model, sourceReference, errorCode: 'context_too_long', canRetry: true, now: Date.now(), sessionId,
        });
      }
      return baseResult({
        status: 'error', requestId, turnId, question, title, partTitle, textSize,
        message: '本次回答失败，问题已保留，请检查 AI 设置后重试。',
        aiStatus: 'failed', model, sourceReference, errorCode: 'request_failed', canRetry: true, now: Date.now(), sessionId,
      });
    }

    if (!await requestStillValid(envelope, active, capturedGeneration, options)) {
      return cancelledResult(envelope, question, title, partTitle, textSize, model, Date.now(), sourceReference);
    }
    const validation = validateCurrentVideoFullTextQaAiOutput(output, envelope);
    if (!validation.ok) {
      const answer = readableModelOutput(output, 'qa');
      return baseResult({
        status: 'invalid_output', requestId, turnId, question, title, partTitle, textSize,
        message: answer ? '模型回答已显示，引用尚未核实。' : '模型未返回可读的回答正文，可重试本题。',
        answer, sourceLabel: envelope.sourceLabel,
        aiStatus: 'invalid_output', model, sourceReference, errorCode: 'invalid_output', canRetry: true, now: Date.now(), sessionId,
      });
    }

    if (validation.kind === 'unsupported') {
      return baseResult({
        status: 'unsupported', requestId, turnId, question, title, partTitle, textSize,
        message: '当前视频文本没有足够内容支持回答。',
        answer: readableModelOutput(output, 'qa') || validation.answer,
        answerEvidenceLineNumbers: [],
        citations: [],
        sourceLabel: envelope.sourceLabel,
        aiStatus: 'unsupported', model, sourceReference, errorCode: null, canRetry: false, now: Date.now(), sessionId,
      });
    }

    const citations: CurrentVideoFullTextQaCitation[] = validation.citations.map(citation => ({
      ...citation,
      sourceLabel: envelope.sourceLabel,
      binding: {
        ...(sessionId ? { sessionId } : {}),
        requestId,
        turnId,
        citationId: citation.id,
      },
    }));
    const generatedAt = Date.now();
    const result = baseResult({
      status: 'ready', requestId, turnId, question, title, partTitle, textSize,
      message: '回答已基于当前分 P 的完整主要文本生成。',
      answer: validation.answer,
      answerEvidenceLineNumbers: validation.answerEvidenceLineNumbers,
      citations,
      sourceLabel: envelope.sourceLabel,
      aiStatus: 'generated', model, sourceReference, errorCode: null, canRetry: true, now: generatedAt, sessionId,
      rollingContext: validation.rollingContext,
    });
    rememberCompletedRequest(envelope, result);
    return result;
  } finally {
    settleNetworkRequest(envelope, active);
  }
}

export function cancelCurrentVideoFullTextQaRequest(requestId: string): void {
  cancelLearningChats((_chat, id) => id === requestId.trim());
  const normalized = requestId.trim();
  if (!normalized) return;
  const preflight = preflightRequests.get(normalized);
  if (preflight) preflight.cancelled = true;
  requestGuard.cancel(normalized);
  const active = activeRequests.get(normalized);
  if (!active) return;
  const sessionId = active.envelope.sessionId?.trim() || null;
  if (sessionId && activeRequestBySession.get(sessionId) === normalized) {
    activeRequestBySession.delete(sessionId);
  }
  active.controller.abort();
}

export function cancelCurrentVideoFullTextQaForSource(sourceIdentityKey: string): void {
  const normalized = sourceIdentityKey.trim();
  if (!normalized) return;
  cancelLearningChats(chat => chat.source === undefined || chat.source?.sourceIdentityKey === normalized);
  for (const preflight of preflightRequests.values()) {
    if (preflight.sourceIdentityKey === normalized) preflight.cancelled = true;
  }
  requestGuard.clearPrimaryText({ sourceIdentityKey: normalized });
  for (const request of activeRequests.values()) {
    if (request.envelope.primaryTextIdentity.sourceIdentityKey === normalized) {
      cancelCurrentVideoFullTextQaRequest(request.envelope.requestId);
    }
  }
  for (const [requestId, request] of completedRequests.entries()) {
    if (request.sourceIdentityKey === normalized) removeCompletedRequest(requestId);
  }
}

export function cancelCurrentVideoFullTextQaForScope(requestScopeId: string): void {
  const normalized = requestScopeId.trim();
  if (!normalized) return;
  cancelLearningChats(chat => chat.tabId !== null && `tab-${chat.tabId}` === normalized);
  for (const preflight of preflightRequests.values()) {
    if (preflight.requestScopeId === normalized) {
      preflight.cancelled = true;
      cancelCurrentVideoFullTextQaRequest(preflight.requestId);
    }
  }
  for (const active of activeRequests.values()) {
    if (active.requestScopeId === normalized) {
      cancelCurrentVideoFullTextQaRequest(active.envelope.requestId);
    }
  }
}

export function cancelCurrentVideoFullTextQaForSession(sessionId: string): void {
  const normalized = sessionId.trim();
  if (!normalized) return;
  cancelLearningChats(chat => chat.sessionId === normalized);
  for (const preflight of preflightRequests.values()) {
    if (preflight.sessionId === normalized) {
      preflight.cancelled = true;
      cancelCurrentVideoFullTextQaRequest(preflight.requestId);
    }
  }
  const activeRequestId = activeRequestBySession.get(normalized);
  if (activeRequestId) cancelCurrentVideoFullTextQaRequest(activeRequestId);
}

export function invalidateCurrentVideoFullTextQaConfig(): void {
  cancelLearningChats();
  configGeneration += 1;
  for (const preflight of preflightRequests.values()) preflight.cancelled = true;
  for (const request of activeRequests.values()) {
    cancelCurrentVideoFullTextQaRequest(request.envelope.requestId);
  }
}

export function invalidateCurrentVideoFullTextQaSources(): void {
  cancelLearningChats();
  for (const preflight of preflightRequests.values()) preflight.cancelled = true;
  for (const request of activeRequests.values()) {
    cancelCurrentVideoFullTextQaRequest(request.envelope.requestId);
  }
  completedRequests.clear();
  completedRequestByTurn.clear();
}

export function invalidateCurrentVideoFullTextQaPart(input: {
  bvid: string;
  cid: number;
  page: number;
}): void {
  const bvid = input.bvid.trim();
  if (!bvid || !Number.isInteger(input.cid) || input.cid <= 0 || !Number.isInteger(input.page) || input.page <= 0) {
    return;
  }
  cancelLearningChats(chat => chat.source === undefined || (chat.source?.bvid === bvid && chat.source.cid === input.cid && chat.source.page === input.page));
  for (const preflight of preflightRequests.values()) {
    if (preflight.bvid === bvid && preflight.cid === input.cid && preflight.page === input.page) {
      preflight.cancelled = true;
      cancelCurrentVideoFullTextQaRequest(preflight.requestId);
    }
  }
  for (const request of activeRequests.values()) {
    if (
      request.envelope.video.bvid === bvid
      && request.envelope.video.cid === input.cid
      && request.envelope.video.page === input.page
    ) {
      cancelCurrentVideoFullTextQaRequest(request.envelope.requestId);
    }
  }
  for (const [requestId, request] of completedRequests.entries()) {
    if (request.bvid === bvid && request.cid === input.cid && request.page === input.page) {
      removeCompletedRequest(requestId);
    }
  }
}

export function getCurrentVideoFullTextQaCitation(
  lookup: CurrentVideoFullTextQaCitationLookup,
): CurrentVideoFullTextQaCitationRecord | null {
  const request = completedRequests.get(lookup.requestId);
  if (
    !request
    || (lookup.sessionId !== undefined && (lookup.sessionId?.trim() || null) !== request.sessionId)
    || request.turnId !== lookup.turnId
    || request.sourceIdentityKey !== lookup.sourceIdentityKey
  ) return null;
  const citation = request.citations.find(item => item.id === lookup.citationId);
  if (!citation) return null;
  return {
    citation,
    bvid: request.bvid,
    cid: request.cid,
    page: request.page,
    sourceIdentityKey: request.sourceIdentityKey,
    generatedAt: request.generatedAt,
  };
}

function startNetworkRequest(
  envelope: CurrentVideoFullTextRequestEnvelope,
  requestScopeId = preflightRequests.get(envelope.requestId)?.requestScopeId ?? null,
): ActiveQaRequest {
  const turnId = envelope.turnId!;
  const sessionId = envelope.sessionId?.trim() || null;
  const turnKey = fullTextQaTurnKey(sessionId, turnId);
  const previousRequestId = activeRequestByTurn.get(turnKey);
  if (previousRequestId && previousRequestId !== envelope.requestId) {
    cancelCurrentVideoFullTextQaRequest(previousRequestId);
  }
  const previousCompleted = completedRequestByTurn.get(turnKey);
  if (previousCompleted && previousCompleted !== envelope.requestId) {
    removeCompletedRequest(previousCompleted);
  }
  if (sessionId) {
    const previousSessionRequestId = activeRequestBySession.get(sessionId);
    if (previousSessionRequestId && previousSessionRequestId !== envelope.requestId) {
      const previous = activeRequests.get(previousSessionRequestId);
      if (previous?.envelope.turnId === turnId) {
        cancelCurrentVideoFullTextQaRequest(previousSessionRequestId);
      }
    }
  }
  requestGuard.start(envelope);
  const active = { envelope, controller: new AbortController(), requestScopeId };
  activeRequests.set(envelope.requestId, active);
  activeRequestByTurn.set(turnKey, envelope.requestId);
  if (sessionId) activeRequestBySession.set(sessionId, envelope.requestId);
  return active;
}

function settleNetworkRequest(envelope: CurrentVideoFullTextRequestEnvelope, active: ActiveQaRequest): void {
  if (activeRequests.get(envelope.requestId) === active) activeRequests.delete(envelope.requestId);
  const sessionId = envelope.sessionId?.trim() || null;
  const turnKey = fullTextQaTurnKey(sessionId, envelope.turnId!);
  if (activeRequestByTurn.get(turnKey) === envelope.requestId) {
    activeRequestByTurn.delete(turnKey);
  }
  if (sessionId && activeRequestBySession.get(sessionId) === envelope.requestId) {
    activeRequestBySession.delete(sessionId);
  }
  requestGuard.settle(envelope);
}

async function preflightStillValid(
  envelope: CurrentVideoFullTextRequestEnvelope,
  capturedGeneration: number,
  options: GenerateCurrentVideoFullTextQaOptions,
): Promise<boolean> {
  if (capturedGeneration !== configGeneration) return false;
  const preflight = preflightRequests.get(envelope.requestId);
  if (preflight?.cancelled || (preflight && preflight.configGeneration !== capturedGeneration)) return false;
  if (options.sourceDataStillCurrent && !await options.sourceDataStillCurrent()) return false;
  if (options.authorizationStillEnabled && !await options.authorizationStillEnabled()) return false;
  return envelope.primaryTextIdentity.sourceIdentityKey.length > 0;
}

async function requestStillValid(
  envelope: CurrentVideoFullTextRequestEnvelope,
  active: ActiveQaRequest,
  capturedGeneration: number,
  options: GenerateCurrentVideoFullTextQaOptions,
): Promise<boolean> {
  if (active.controller.signal.aborted) return false;
  if (!await preflightStillValid(envelope, capturedGeneration, options)) return false;
  if (options.resolveLiveConfig) {
    const liveConfig = await options.resolveLiveConfig();
    if (!liveConfig.assistant.currentVideoAiAssistantEnabled || !aiConfigured(liveConfig)) return false;
  }
  const currentIdentity = options.resolveCurrentIdentity
    ? await options.resolveCurrentIdentity()
    : { sourceIdentityKey: envelope.primaryTextIdentity.sourceIdentityKey };
  const commit = requestGuard.canCommit(envelope, currentIdentity);
  return commit.ok;
}

function rememberCompletedRequest(
  envelope: CurrentVideoFullTextRequestEnvelope,
  result: CurrentVideoFullTextQaResult,
): void {
  const sessionId = envelope.sessionId?.trim() || null;
  const turnKey = fullTextQaTurnKey(sessionId, result.turnId);
  const previous = completedRequestByTurn.get(turnKey);
  if (previous && previous !== result.requestId) removeCompletedRequest(previous);
  completedRequests.set(result.requestId, {
    requestId: result.requestId,
    sessionId,
    turnId: result.turnId,
    sourceIdentityKey: envelope.primaryTextIdentity.sourceIdentityKey,
    bvid: envelope.video.bvid,
    cid: envelope.video.cid,
    page: envelope.video.page,
    generatedAt: result.generatedAt,
    citations: result.citations,
  });
  completedRequestByTurn.set(turnKey, result.requestId);
  while (completedRequests.size > MAX_COMPLETED_REQUESTS) {
    const oldest = completedRequests.keys().next().value as string | undefined;
    if (!oldest) break;
    removeCompletedRequest(oldest);
  }
}

function removeCompletedRequest(requestId: string): void {
  const request = completedRequests.get(requestId);
  completedRequests.delete(requestId);
  if (request && completedRequestByTurn.get(fullTextQaTurnKey(request.sessionId, request.turnId)) === requestId) {
    completedRequestByTurn.delete(fullTextQaTurnKey(request.sessionId, request.turnId));
  }
}

function cancelledResult(
  envelope: CurrentVideoFullTextRequestEnvelope,
  question: string,
  title: string,
  partTitle: string | null,
  textSize: CurrentVideoFullTextQaTextSize,
  model: string | null,
  now: number,
  sourceReference: CurrentVideoFullTextQaSourceReference | null,
): CurrentVideoFullTextQaResult {
  return baseResult({
    status: 'cancelled',
    requestId: envelope.requestId,
    sessionId: envelope.sessionId?.trim() || null,
    turnId: envelope.turnId ?? '',
    question,
    title,
    partTitle,
    textSize,
    message: '本次回答已取消，问题已保留，可重新提交。',
    aiStatus: 'cancelled',
    model,
    sourceReference,
    errorCode: null,
    canRetry: true,
    now,
  });
}

function baseResult(input: {
  status: CurrentVideoFullTextQaResult['status'];
  requestId: string;
  sessionId?: string | null;
  turnId: string;
  question: string;
  title: string;
  partTitle: string | null;
  textSize: CurrentVideoFullTextQaTextSize;
  message: string;
  aiStatus: CurrentVideoFullTextQaResult['ai']['status'];
  model: string | null;
  sourceReference: CurrentVideoFullTextQaSourceReference | null;
  errorCode: string | null;
  canRetry: boolean;
  now: number;
  answer?: string;
  answerEvidenceLineNumbers?: number[];
  citations?: CurrentVideoFullTextQaCitation[];
  sourceLabel?: 'B站字幕' | '本地转录' | null;
  rollingContext?: string | null;
}): CurrentVideoFullTextQaResult {
  return {
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    status: input.status,
    requestId: input.requestId,
    turnId: input.turnId,
    question: input.question,
    title: input.title,
    partTitle: input.partTitle,
    sourceLabel: input.sourceLabel ?? null,
    textSize: input.textSize,
    answer: input.answer ?? '',
    answerEvidenceLineNumbers: input.answerEvidenceLineNumbers ?? [],
    citations: input.citations ?? [],
    message: input.message,
    limitations: input.status === 'ready'
      ? ['回答和引用只基于当前分 P 本次提交的完整主要文本。']
      : input.status === 'unsupported'
        ? ['没有使用标题、简介、通用知识或其他视频内容补答。']
        : ['本次没有采用不完整文本生成回答。'],
    ai: {
      status: input.aiStatus,
      model: input.model,
      note: input.message,
      errorCode: input.errorCode,
    },
    sourceReference: input.sourceReference,
    rollingContext: input.rollingContext ?? null,
    generatedAt: input.now,
    canRetry: input.canRetry,
  };
}

function approximateTextSize(context: CurrentVideoContextResult): CurrentVideoFullTextQaTextSize {
  if (context.kind !== 'video') return { lineCount: 0, charCount: null, utf8Bytes: 0 };
  return {
    lineCount: context.transcriptEvidence?.segmentCount ?? 0,
    charCount: null,
    utf8Bytes: context.transcriptEvidence?.serializedBytes ?? 0,
  };
}

function textSizeFromEnvelope(envelope: CurrentVideoFullTextRequestEnvelope): CurrentVideoFullTextQaTextSize {
  return {
    lineCount: envelope.text.lineCount,
    charCount: envelope.text.charCount,
    utf8Bytes: envelope.text.utf8Bytes,
  };
}

function buildSourceReferenceFromContext(
  context: CurrentVideoContextResult,
  textSize: CurrentVideoFullTextQaTextSize,
  capturedAt: number,
): CurrentVideoFullTextQaSourceReference | null {
  if (context.kind !== 'video') return null;
  return {
    title: context.title?.trim() || '当前视频',
    partTitle: context.currentPart.title?.trim() || null,
    page: Number.isInteger(context.currentPart.page) ? context.currentPart.page : null,
    bvid: context.bvid,
    cid: typeof context.cid === 'number' ? context.cid : null,
    url: context.url,
    sourceLabel: context.transcriptEvidence?.active ? 'B站字幕' : null,
    language: context.transcriptEvidence?.language ?? null,
    sourceIdentityKey: context.transcriptEvidence?.sourceIdentityKey ?? null,
    textSize,
    capturedAt,
  };
}

function buildSourceReferenceFromEnvelope(
  envelope: CurrentVideoFullTextRequestEnvelope,
  url: string | null,
  capturedAt: number,
): CurrentVideoFullTextQaSourceReference {
  return {
    title: envelope.video.title || '当前视频',
    partTitle: envelope.video.partTitle,
    page: envelope.video.page,
    bvid: envelope.video.bvid,
    cid: envelope.video.cid,
    url,
    sourceLabel: envelope.sourceLabel,
    language: envelope.language,
    sourceIdentityKey: envelope.primaryTextIdentity.sourceIdentityKey,
    textSize: textSizeFromEnvelope(envelope),
    capturedAt,
  };
}

function fullTextQaTurnKey(sessionId: string | null, turnId: string): string {
  return `${sessionId ?? ''}|${turnId}`;
}

function sameQaTurn(
  leftSessionId: string | null,
  leftTurnId: string,
  rightSessionId: string | null,
  rightTurnId: string,
): boolean {
  return fullTextQaTurnKey(leftSessionId, leftTurnId) === fullTextQaTurnKey(rightSessionId, rightTurnId);
}

function aiConfigured(config: UserConfig): boolean {
  return Boolean(config.ai.baseURL.trim() && config.ai.apiKey.trim() && config.ai.chatModel.trim());
}

function normalizeQuestion(question: string): string {
  return String(question ?? '').replace(/\s+/g, ' ').trim();
}

function isContextTooLongError(error: unknown): boolean {
  return error instanceof Error && /^AI_REQUEST_FAILED_(413|422)(?:\s|$)/.test(error.message.trim());
}
