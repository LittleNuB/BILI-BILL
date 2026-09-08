import type { UserConfig } from '../shared/types/config.ts';
import type { CurrentVideoContextResult } from '../shared/types/current-video-context.ts';
import type { CurrentVideoTranscriptSegment } from '../shared/types/current-video-transcript.ts';
import type { CurrentVideoSummaryHighlightsResult } from '../shared/types/current-video-summary.ts';
import {
  buildCurrentVideoFullTextRequestEnvelope,
  currentVideoFullTextRequestTargetKey,
  CurrentVideoFullTextRequestGuard,
  type CurrentVideoTextSourceIdentity,
} from '../shared/current-video-primary-text.ts';
import {
  approximateTextSize,
  buildCurrentVideoSummaryHighlightsAiPayload,
  type CurrentVideoSummaryHighlightsChat,
  type CurrentVideoSummaryHighlightsAiOutput,
  cancelledCurrentVideoSummaryHighlights,
  disabledCurrentVideoSummaryHighlights,
  failedCurrentVideoSummaryHighlights,
  invalidCurrentVideoSummaryHighlights,
  noTextCurrentVideoSummaryHighlights,
  notConfiguredCurrentVideoSummaryHighlights,
  notRequestedCurrentVideoSummaryHighlights,
  readyCurrentVideoSummaryHighlights,
  requestAuditFromEnvelope,
  requestCurrentVideoSummaryHighlightsAi,
  textSizeFromEnvelope,
  validateCurrentVideoSummaryHighlightsAiOutput,
} from '../shared/current-video-summary-highlights.ts';
import { chatJson } from './ai/openai-compatible.ts';
import { readableModelOutput } from '../shared/readable-model-output.ts';
import {
  canUseCurrentVideoSummaryHighlightsClearGeneration,
  getCurrentVideoSummaryHighlightsClearState,
} from './current-video-summary-highlights-clear-epoch.ts';
import {
  buildCurrentVideoSummaryHighlightsCacheKey,
  getCurrentVideoSummaryHighlightsCache,
  putCurrentVideoSummaryHighlightsCache,
  withCurrentCacheHit,
} from './storage/current-video-summary-highlights-repo.ts';
import { loadConfig } from './storage/config-store.ts';

const summaryHighlightsRequestGuard = new CurrentVideoFullTextRequestGuard();
const preflightRequests = new Map<string, PreflightSummaryHighlightsRequest>();
const preflightRequestBySource = new Map<string, string>();
const activeNetworkRequests = new Map<string, ActiveSummaryHighlightsNetworkRequest>();
const activeNetworkRequestByTarget = new Map<string, string>();
let configGeneration = 0;

interface PreflightSummaryHighlightsRequest {
  requestId: string;
  sourceIdentityKey: string | null;
  cancelled: boolean;
  configGeneration: number;
}

interface ActiveSummaryHighlightsNetworkRequest {
  requestId: string;
  sourceIdentityKey: string;
  targetKey: string;
  controller: AbortController;
}

export interface GenerateCurrentVideoSummaryHighlightsOptions {
  config?: UserConfig;
  chat?: CurrentVideoSummaryHighlightsChat;
  transcriptSegments: CurrentVideoTranscriptSegment[];
  now?: number;
  requestId?: string;
  configGeneration?: number;
  currentIdentity?: Pick<CurrentVideoTextSourceIdentity, 'sourceIdentityKey'> | null;
  resolveCurrentIdentity?: () => Promise<Pick<CurrentVideoTextSourceIdentity, 'sourceIdentityKey'> | null>;
  resolveLiveConfig?: () => Promise<UserConfig>;
  sourceDataStillCurrent?: () => boolean;
  authorizationStillEnabled?: () => Promise<boolean>;
}

export async function readCachedCurrentVideoSummaryHighlights(
  context: CurrentVideoContextResult,
  options: { config?: UserConfig; now?: number } = {},
): Promise<CurrentVideoSummaryHighlightsResult> {
  const config = options.config ?? await loadConfig();
  const now = options.now ?? Date.now();
  const title = currentVideoSummaryHighlightsTitle(context);
  const model = normalizedModel(config);
  const identity = activeSourceIdentity(context);
  if (!identity) {
    return notRequestedCurrentVideoSummaryHighlights(title, now);
  }
  if (!model) {
    return notConfiguredCurrentVideoSummaryHighlights(title, null, approximateSizeFromContext(context), now);
  }

  const record = await getCurrentVideoSummaryHighlightsCache({
    identity,
    model,
    now,
  });
  if (!record) {
    if (!config.assistant.currentVideoAiAssistantEnabled) {
      return disabledCurrentVideoSummaryHighlights(title, model, approximateSizeFromContext(context), now);
    }
    if (!aiConfigured(config)) {
      return notConfiguredCurrentVideoSummaryHighlights(title, model, approximateSizeFromContext(context), now);
    }
    return notRequestedCurrentVideoSummaryHighlights(title, now);
  }
  return withCurrentCacheHit(record, identity.sourceIdentityKey === record.sourceIdentityKey, {
    authorizationEnabled: config.assistant.currentVideoAiAssistantEnabled,
    configured: aiConfigured(config),
  });
}

export async function generateCurrentVideoSummaryHighlights(
  context: CurrentVideoContextResult,
  options: GenerateCurrentVideoSummaryHighlightsOptions,
): Promise<CurrentVideoSummaryHighlightsResult> {
  const config = options.config ?? await loadConfig();
  const now = options.now ?? Date.now();
  const title = currentVideoSummaryHighlightsTitle(context);
  const model = normalizedModel(config);
  const approximateSize = approximateSizeFromContext(context);
  if (context.kind !== 'video') {
    return noTextCurrentVideoSummaryHighlights(title, model, approximateSize, now);
  }
  if (!config.assistant.currentVideoAiAssistantEnabled) {
    return disabledCurrentVideoSummaryHighlights(title, model, approximateSize, now);
  }
  if (!aiConfigured(config)) {
    return notConfiguredCurrentVideoSummaryHighlights(title, model, approximateSize, now);
  }
  if (
    !model
    || !context.cid
    || options.transcriptSegments.length <= 0
    || !context.transcriptEvidence?.active
    || !context.transcriptEvidence.sourceType
  ) {
    return noTextCurrentVideoSummaryHighlights(title, model, approximateSize, now);
  }

  const envelope = buildCurrentVideoFullTextRequestEnvelope({
    requestId: options.requestId,
    operation: 'summary_highlights',
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
  });
  const textSize = textSizeFromEnvelope(envelope);
  if (context.transcriptEvidence.sourceIdentityKey !== envelope.primaryTextIdentity.sourceIdentityKey) {
    return noTextCurrentVideoSummaryHighlights(title, model, textSize, now);
  }

  const clearState = getCurrentVideoSummaryHighlightsClearState();
  const liveConfig = await resolveLiveConfigSafely(options, config);
  if (!liveConfig.assistant.currentVideoAiAssistantEnabled) {
    return disabledCurrentVideoSummaryHighlights(title, normalizedModel(liveConfig), textSize, Date.now());
  }
  if (!aiConfigured(liveConfig)) {
    return notConfiguredCurrentVideoSummaryHighlights(title, normalizedModel(liveConfig), textSize, Date.now());
  }
  if (!summaryHighlightsRequestStillValidSync(envelope, clearState.generation, options, false)) {
    return cancelledResult(title, model, textSize);
  }
  summaryHighlightsRequestGuard.start(envelope);
  const networkRequest = registerSummaryHighlightsNetworkRequest(envelope);
  try {
    let aiOutput: CurrentVideoSummaryHighlightsAiOutput;
    try {
      const payload = buildCurrentVideoSummaryHighlightsAiPayload(envelope);
      aiOutput = await requestCurrentVideoSummaryHighlightsAi(
        liveConfig.ai,
        payload,
        options.chat ?? ((config, messages, requestOptions) => chatJson(config, messages, { ...requestOptions, allowTextResponse: true })),
        { signal: networkRequest.controller.signal },
      );
    } catch (error) {
      if (!await summaryHighlightsRequestStillValid(envelope, clearState.generation, options)) {
        return cancelledResult(title, model, textSize);
      }
      return failedCurrentVideoSummaryHighlights(title, model, errorMessage(error), textSize, Date.now());
    }

    if (!await summaryHighlightsRequestStillValid(envelope, clearState.generation, options)) {
      return cancelledResult(title, model, textSize);
    }

    const validation = validateCurrentVideoSummaryHighlightsAiOutput(aiOutput, envelope);
    if (!validation.ok) {
      const result = invalidCurrentVideoSummaryHighlights(title, model, validation.reason, textSize, Date.now());
      const unverifiedText = readableModelOutput(aiOutput, 'summary');
      return { ...result, unverifiedText, message: unverifiedText ? '模型输出已显示，引用尚未核实。' : '模型未返回可读的正文，可重新生成。',
        limitations: [], ai: { ...result.ai, note: '未核实的内容仅供阅读，不提供时间跳转。' } };
    }

    const currentIdentity = await resolveCurrentIdentitySafely(options);
    const commit = summaryHighlightsRequestGuard.canCommit(envelope);
    if (!commit.ok || !await summaryHighlightsRequestStillValid(envelope, clearState.generation, options)) {
      return cancelledResult(title, model, textSize);
    }
    const current = currentIdentity?.sourceIdentityKey === envelope.primaryTextIdentity.sourceIdentityKey;
    const cacheKey = buildCurrentVideoSummaryHighlightsCacheKey({
      identity: envelope.primaryTextIdentity,
      model,
    });
    const generatedAt = Date.now();
    let result = readyCurrentVideoSummaryHighlights({
      title,
      sourceLabel: envelope.sourceLabel,
      textSize,
      summarySentences: validation.result.summarySentences,
      keyPoints: validation.result.keyPoints,
      highlights: validation.result.highlights,
      model,
      cacheKey,
      cacheHit: false,
      current,
      requestId: envelope.requestId,
      generatedAt,
    });

    const cacheResult = await putCurrentVideoSummaryHighlightsCache({
      cacheKey,
      sourceIdentityKey: envelope.primaryTextIdentity.sourceIdentityKey,
      model,
      bvid: envelope.video.bvid,
      cid: envelope.video.cid,
      page: envelope.video.page,
      generatedAt,
      lastAccessedAt: generatedAt,
      requestAudit: requestAuditFromEnvelope(envelope),
      result,
    }, {
      expectedClearGeneration: clearState.generation,
      canWrite: () => summaryHighlightsRequestStillValidSync(envelope, clearState.generation, options)
        && !networkRequest.controller.signal.aborted,
    });
    if (cacheResult.rejectedReason === 'cleared' || cacheResult.rejectedReason === 'invalidated') {
      return cancelledResult(title, model, textSize);
    }
    result = {
      ...result,
      cacheKey: cacheResult.cacheKey,
      limitations: cacheResult.cached
        ? result.limitations
        : [...result.limitations, '本次结果超过本地缓存上限，仅返回当前结果。'],
    };
    return result;
  } finally {
    settleSummaryHighlightsNetworkRequest(envelope, networkRequest);
  }
}

export function cancelCurrentVideoSummaryHighlightsRequest(requestId: string): void {
  const preflight = preflightRequests.get(requestId);
  if (preflight) {
    preflight.cancelled = true;
  }
  summaryHighlightsRequestGuard.cancel(requestId);
  activeNetworkRequests.get(requestId)?.controller.abort();
}

export function cancelCurrentVideoSummaryHighlightsForSource(sourceIdentityKey: string): void {
  for (const preflight of preflightRequests.values()) {
    if (preflight.sourceIdentityKey === sourceIdentityKey) preflight.cancelled = true;
  }
  summaryHighlightsRequestGuard.clearPrimaryText({ sourceIdentityKey });
  for (const request of activeNetworkRequests.values()) {
    if (request.sourceIdentityKey === sourceIdentityKey) request.controller.abort();
  }
}

export function invalidateCurrentVideoSummaryHighlightsAuthorization(): void {
  for (const preflight of preflightRequests.values()) {
    preflight.cancelled = true;
  }
  for (const request of activeNetworkRequests.values()) {
    summaryHighlightsRequestGuard.cancel(request.requestId);
    request.controller.abort();
  }
}

export function invalidateCurrentVideoSummaryHighlightsConfig(): void {
  configGeneration += 1;
  invalidateCurrentVideoSummaryHighlightsAuthorization();
}

export function getCurrentVideoSummaryHighlightsConfigGeneration(): number {
  return configGeneration;
}

export function canUseCurrentVideoSummaryHighlightsConfigGeneration(
  generation: number | null | undefined,
): boolean {
  return generation === configGeneration;
}

export function registerCurrentVideoSummaryHighlightsPreflightRequest(input: {
  requestId: string;
  sourceIdentityKey?: string | null;
}): { requestId: string; configGeneration: number } {
  const requestId = input.requestId.trim();
  const sourceIdentityKey = input.sourceIdentityKey?.trim() || null;
  if (!requestId) {
    return { requestId, configGeneration };
  }
  if (sourceIdentityKey) {
    const previousRequestId = preflightRequestBySource.get(sourceIdentityKey);
    if (previousRequestId && previousRequestId !== requestId) {
      const previous = preflightRequests.get(previousRequestId);
      if (previous) previous.cancelled = true;
    }
    cancelActiveSummaryHighlightsNetworkRequestsForSource(sourceIdentityKey);
    preflightRequestBySource.set(sourceIdentityKey, requestId);
  }
  preflightRequests.set(requestId, {
    requestId,
    sourceIdentityKey,
    cancelled: false,
    configGeneration,
  });
  return { requestId, configGeneration };
}

export function settleCurrentVideoSummaryHighlightsPreflightRequest(requestId: string | null | undefined): void {
  const normalizedRequestId = requestId?.trim();
  if (!normalizedRequestId) return;
  const preflight = preflightRequests.get(normalizedRequestId);
  if (preflight?.sourceIdentityKey && preflightRequestBySource.get(preflight.sourceIdentityKey) === normalizedRequestId) {
    preflightRequestBySource.delete(preflight.sourceIdentityKey);
  }
  preflightRequests.delete(normalizedRequestId);
}

export function currentVideoSummaryHighlightsTitle(context: CurrentVideoContextResult | null): string {
  if (context?.kind !== 'video') return '当前视频';
  return context.title?.trim() || '当前视频';
}

export function approximateSizeFromContext(context: CurrentVideoContextResult | null) {
  if (context?.kind !== 'video') return approximateTextSize(0, 0);
  return approximateTextSize(
    context.transcriptEvidence?.segmentCount ?? 0,
    context.transcriptEvidence?.serializedBytes ?? 0,
  );
}

function registerSummaryHighlightsNetworkRequest(
  envelope: ReturnType<typeof buildCurrentVideoFullTextRequestEnvelope>,
): ActiveSummaryHighlightsNetworkRequest {
  const targetKey = summaryHighlightsNetworkTargetKey(envelope);
  const previousRequestId = activeNetworkRequestByTarget.get(targetKey);
  if (previousRequestId && previousRequestId !== envelope.requestId) {
    activeNetworkRequests.get(previousRequestId)?.controller.abort();
  }
  const request: ActiveSummaryHighlightsNetworkRequest = {
    requestId: envelope.requestId,
    sourceIdentityKey: envelope.primaryTextIdentity.sourceIdentityKey,
    targetKey,
    controller: new AbortController(),
  };
  activeNetworkRequests.set(request.requestId, request);
  activeNetworkRequestByTarget.set(targetKey, request.requestId);
  return request;
}

function cancelActiveSummaryHighlightsNetworkRequestsForSource(sourceIdentityKey: string): void {
  for (const request of activeNetworkRequests.values()) {
    if (request.sourceIdentityKey !== sourceIdentityKey) continue;
    summaryHighlightsRequestGuard.cancel(request.requestId);
    request.controller.abort();
  }
}

function settleSummaryHighlightsNetworkRequest(
  envelope: ReturnType<typeof buildCurrentVideoFullTextRequestEnvelope>,
  request: ActiveSummaryHighlightsNetworkRequest,
): void {
  summaryHighlightsRequestGuard.settle(envelope);
  if (activeNetworkRequests.get(request.requestId) === request) {
    activeNetworkRequests.delete(request.requestId);
  }
  if (activeNetworkRequestByTarget.get(request.targetKey) === request.requestId) {
    activeNetworkRequestByTarget.delete(request.targetKey);
  }
}

function summaryHighlightsNetworkTargetKey(
  envelope: ReturnType<typeof buildCurrentVideoFullTextRequestEnvelope>,
): string {
  return currentVideoFullTextRequestTargetKey(envelope);
}

async function summaryHighlightsRequestStillValid(
  envelope: ReturnType<typeof buildCurrentVideoFullTextRequestEnvelope>,
  expectedClearGeneration: number,
  options: GenerateCurrentVideoSummaryHighlightsOptions,
): Promise<boolean> {
  if (!summaryHighlightsRequestStillValidSync(envelope, expectedClearGeneration, options)) return false;
  if (!options.authorizationStillEnabled) return true;
  try {
    if (await options.authorizationStillEnabled()) return true;
  } catch {
    // A failed live authorization read must fail closed.
  }
  cancelCurrentVideoSummaryHighlightsRequest(envelope.requestId);
  return false;
}

function summaryHighlightsRequestStillValidSync(
  envelope: ReturnType<typeof buildCurrentVideoFullTextRequestEnvelope>,
  expectedClearGeneration: number,
  options: GenerateCurrentVideoSummaryHighlightsOptions,
  requireActiveRequest = true,
): boolean {
  if (preflightRequests.get(envelope.requestId)?.cancelled) return false;
  if (requireActiveRequest && !summaryHighlightsRequestGuard.canCommit(envelope).ok) return false;
  if (!canUseCurrentVideoSummaryHighlightsClearGeneration(expectedClearGeneration)) return false;
  if (
    options.configGeneration !== undefined
    && !canUseCurrentVideoSummaryHighlightsConfigGeneration(options.configGeneration)
  ) {
    return false;
  }
  if (options.sourceDataStillCurrent && !options.sourceDataStillCurrent()) return false;
  return true;
}

async function resolveCurrentIdentitySafely(
  options: GenerateCurrentVideoSummaryHighlightsOptions,
): Promise<Pick<CurrentVideoTextSourceIdentity, 'sourceIdentityKey'> | null> {
  if (!options.resolveCurrentIdentity) return options.currentIdentity ?? null;
  try {
    return await options.resolveCurrentIdentity();
  } catch {
    return null;
  }
}

async function resolveLiveConfigSafely(
  options: GenerateCurrentVideoSummaryHighlightsOptions,
  fallback: UserConfig,
): Promise<UserConfig> {
  if (!options.resolveLiveConfig) return fallback;
  try {
    return await options.resolveLiveConfig();
  } catch {
    return {
      ...fallback,
      assistant: {
        ...fallback.assistant,
        currentVideoAiAssistantEnabled: false,
      },
    };
  }
}

function cancelledResult(
  title: string,
  model: string,
  textSize: ReturnType<typeof textSizeFromEnvelope>,
): CurrentVideoSummaryHighlightsResult {
  return cancelledCurrentVideoSummaryHighlights(
    title,
    model,
    textSize,
    '本次生成已经被取消、替换、关闭授权或清理，旧结果不会被替换。',
    Date.now(),
  );
}

function activeSourceIdentity(
  context: CurrentVideoContextResult,
): Pick<CurrentVideoTextSourceIdentity, 'sourceIdentityKey'> | null {
  if (
    context.kind !== 'video'
    || !context.transcriptEvidence?.active
    || !context.transcriptEvidence.sourceIdentityKey
  ) {
    return null;
  }
  return { sourceIdentityKey: context.transcriptEvidence.sourceIdentityKey };
}

function aiConfigured(config: UserConfig): boolean {
  return Boolean(
    config.ai.baseURL.trim()
    && config.ai.chatModel.trim()
    && config.ai.apiKey.trim(),
  );
}

function normalizedModel(config: UserConfig): string | null {
  return config.ai.chatModel.trim() || null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
