import type { BiliVizRequest, BiliVizContentMessage, BiliVizResponse, PlayerActionPayload, PlayerHeartbeatPayload, RequestAction, SyncNowResult } from '../../shared/types/messages';
import type { HistorySyncStatus } from '../../shared/types/history-sync';
import { cancelLearningChats } from '../learning-chat-control.ts';
import { resolveLearningSelection } from '../../shared/learning-selection.ts';
import type {
  CurrentVideoContext,
  CurrentVideoContextResult,
  CurrentVideoNoContext,
  CurrentVideoSubtitleSourceState,
} from '../../shared/types/current-video-context';
import type {
  CurrentVideoTranscriptEvidenceState,
  CurrentVideoTranscriptSegment,
} from '../../shared/types/current-video-transcript';
import type {
  CurrentVideoSegmentRetrievalResult,
  CurrentVideoTimestampJumpResponse,
  CurrentVideoTimestampOperationKind,
  CurrentVideoTimestampOperationLeaseConsumeResult,
  CurrentVideoTimestampReturnResponse,
} from '../../shared/types/current-video-segment-retrieval';
import type {
  CurrentVideoSubtitleLine,
  CurrentVideoSubtitleViewSourcesResult,
  CurrentVideoSubtitleViewingSource,
} from '../../shared/current-video-subtitle-view.ts';
import type { CurrentVideoRelatedFavoritesResponse } from '../../shared/types/current-video-related-favorites';
import type { CurrentVideoSummaryHighlightsResult } from '../../shared/types/current-video-summary';
import type {
  CurrentVideoFullTextQaResult,
  CurrentVideoFullTextQaSourceReference,
} from '../../shared/types/current-video-full-text-qa';
import type {
  CurrentVideoQaSessionRecord,
  CurrentVideoQaSourceSnapshot,
} from '../../shared/types/current-video-qa-session';
import type { VideoKnowledgeResult } from '../../shared/types/video-knowledge';
import type { DynamicBillFeedbackScope, DynamicBillStatusFilter } from '../../shared/types/dynamic-bill';
import { normalizePageLimit, runInitialBackfill } from '../sync/initial-backfill';
import { probeHistoryTailCoverage } from '../sync/history-tail-probe';
import {
  saveConfig,
  getLastSyncTime,
  getHistorySyncing,
  getHistorySyncProgress,
  getBackfillComplete,
  loadConfig,
  loadConfigSnapshot,
  normalizeUserConfig,
  requestHistorySyncCancel,
  clearOrphanedHistorySyncLock,
  setDeviceTypeMigrationComplete,
} from '../storage/config-store';
import { db } from '../storage/db';
import { ExplicitMemoryRepository } from '../storage/explicit-memory-repo.ts';
import { navigateLearning, returnLearning } from './learning-navigation.ts';
import { handleLearningRequest } from './learning-handlers.ts';
import { learningChatProgress, askLearningChat } from '../learning-chat.ts';
import { learningAssert, type LearningSourceRequest } from '../../shared/learning.ts';
import { buildLearningSnapshot } from '../../shared/learning-source.ts';
import type { CurrentVideoQaSessionTurn } from '../../shared/types/current-video-qa-session.ts';
import type { UserConfig } from '../../shared/types/config';
import {
  approximateSizeFromContext,
  cancelCurrentVideoSummaryHighlightsForSource,
  cancelCurrentVideoSummaryHighlightsRequest,
  canUseCurrentVideoSummaryHighlightsConfigGeneration,
  currentVideoSummaryHighlightsTitle,
  generateCurrentVideoSummaryHighlights,
  getCurrentVideoSummaryHighlightsConfigGeneration,
  invalidateCurrentVideoSummaryHighlightsConfig,
  readCachedCurrentVideoSummaryHighlights,
  registerCurrentVideoSummaryHighlightsPreflightRequest,
  settleCurrentVideoSummaryHighlightsPreflightRequest,
} from '../current-video-summary-highlights';
import {
  bindCurrentVideoFullTextQaPreflightPart,
  cancelCurrentVideoFullTextQaForSource,
  cancelCurrentVideoFullTextQaForSession,
  cancelCurrentVideoFullTextQaRequest,
  generateCurrentVideoFullTextQa,
  getCurrentVideoFullTextQaCitation,
  invalidateCurrentVideoFullTextQaConfig,
  invalidateCurrentVideoFullTextQaSources,
  registerCurrentVideoFullTextQaPreflightRequest,
  settleCurrentVideoFullTextQaPreflightRequest,
  unavailableCurrentVideoFullTextQa,
} from '../current-video-full-text-qa';
import {
  buildCurrentVideoQaConversationContext,
  buildRefusedCurrentVideoQaResult,
  completeCurrentVideoQaTurn,
  CURRENT_VIDEO_QA_SESSION_STORAGE_LIMIT_MESSAGE,
  deleteCurrentVideoQaSession,
  getPersistedCurrentVideoQaCitation,
  getCurrentVideoQaSessionsView,
  isCurrentVideoQaSessionStorageLimitError,
  isCurrentVideoQaSessionWriteInvalidatedError,
  registerCurrentVideoQaSessionTurnWriteGuard,
  renameCurrentVideoQaSession,
  settleCurrentVideoQaSessionTurnWriteGuard,
  shouldRefuseCurrentVideoQaBeforeNetwork,
  type CurrentVideoQaSessionWriteGuard,
  upsertCurrentVideoQaPendingTurn,
} from '../storage/current-video-qa-session-repo';
import {
  cancelledCurrentVideoSummaryHighlights,
  currentVideoSummaryHighlightBindingMatchesRecord,
  disabledCurrentVideoSummaryHighlights,
  noTextCurrentVideoSummaryHighlights,
  notConfiguredCurrentVideoSummaryHighlights,
} from '../../shared/current-video-summary-highlights.ts';
import {
  probeCurrentVideoSubtitleSource,
  withSubtitleSourceState,
} from '../current-video-subtitle-probe';
import { cacheCurrentVideoTranscriptEvidence } from '../current-video-transcript-cache';
import {
  buildCurrentVideoTranscriptEvidenceState,
  withTranscriptEvidenceState,
} from '../../shared/current-video-transcript-cache';
import {
  rewriteCurrentVideoSegmentQuery,
  searchCurrentVideoSegments,
} from '../../shared/current-video-segment-retrieval';
import { searchCurrentVideoSegmentsWithAiRerank } from '../current-video-segment-rerank';
import {
  buildCurrentVideoRelatedFavoritesHint,
  emptyCurrentVideoRelatedFavoritesResponse,
} from '../../shared/current-video-related-favorites';
import {
  blockedTimestampJumpResponse,
  blockedTimestampReturnResponse,
  formatTimestampJumpFailureReason,
} from '../../shared/current-video-timestamp-jump';
import {
  buildBilibiliSubtitleViewingSource,
  buildCurrentVideoSubtitleJumpPreview,
  currentVideoSubtitleContextKey,
} from '../../shared/current-video-subtitle-view.ts';
import { buildVideoKnowledgeResult } from '../../shared/video-knowledge';
import {
  getQuickStats,
  getDashboardOverview,
  getPreferenceData,
  getCreatorData,
  getBehaviorData,
  getExperimentData,
  computeStoredHistoryAggregates,
} from '../analytics/engine';
import { getDeviceData } from '../analytics/device';
import {
  abortCurrentHistorySync,
  hasActiveHistoryDataOperation,
  hasActiveHistorySyncAbortScope,
  runHistoryPlayerEventDataOperation,
} from '../sync/sync-control';
import { syncFavorites } from '../favorites/sync';
import { probeFavoriteFolderGap } from '../favorites/folder-gap-probe';
import {
  buildSmartFavoriteIndex,
  getSmartFavoriteOverview,
  getSmartFavoritesByPath,
  rebuildSmartFavoriteIndex,
  searchSmartFavorites,
} from '../favorites/smart';
import { answerSmartFavoriteQuestion } from '../favorites/qa';
import { buildDynamicBillExplanations } from '../dynamic-bill/ai';
import { generateDynamicBillItems } from '../dynamic-bill/generator';
import { ensureDynamicBill013Migration } from '../dynamic-bill/migration';
import { runDynamicBillDataOperation } from '../dynamic-bill/operation-control';
import { DYNAMIC_BILL_STRATEGY } from '../dynamic-bill/strategy';
import { getDynamicOverview, syncDynamicBillUpdates } from '../dynamic-bill/sync';
import {
  extractBvidFromUrl,
  extractPageFromUrl,
  isBilibiliVideoUrl,
  resolveFreshMatchingVideoContext,
  resolveCurrentVideoTabState,
  type CurrentVideoTabSnapshot,
} from '../current-video-context-resolver';
import {
  clearAllLocalData,
  clearLocalDataCategory,
  clearCurrentVideoSummaryHighlightCache,
  clearCurrentVideoSubtitleCache,
  getLocalDataPrivacySummary,
} from '../storage/local-data-privacy-repo';
import { isIndependentlyClearableLocalDataCategoryId } from '../../shared/local-data-category-contract.ts';
import {
  applyDynamicBillCreatorLessReminder,
  getDynamicBillFilterPreference,
  getDynamicBillFeedbackState,
  getDynamicBillActiveCreatorPauseViews,
  getDynamicBillItems,
  addDynamicBillFeedback,
  markDynamicBillItemOpened,
  markDynamicBillItemProcessed,
  markDynamicBillItemsConsumedByBvid,
  resolveDynamicBillCreatorReviewPrompt,
  restoreDynamicBillCreatorReminder,
  setDynamicBillFilterPreference,
  undoDynamicBillCreatorLessReminder,
} from '../storage/dynamic-bill-repo';
import {
  getCurrentVideoActiveTranscriptSourceIdentityKeys,
  getCurrentVideoCurrentOwnerTranscriptSourceIdentityKeys,
  getCurrentVideoTranscriptEvidenceState,
  getCurrentVideoTranscriptSegments,
} from '../storage/current-video-transcript-repo';
import {
  buildTemporaryCurrentVideoTranscriptUnavailableState,
  clearTemporaryCurrentVideoTranscriptCacheForTab,
  getTemporaryCurrentVideoTranscriptOwnerReadResolution,
  retainTemporaryCurrentVideoTranscriptOwner,
  type CurrentVideoTemporaryTranscriptOwner,
} from '../current-video-temporary-transcript-cache.ts';
import { retainTemporaryTranscriptOwnerForContextSnapshot } from '../current-video-transcript-owner.ts';
import { testAiConnection } from '../ai/openai-compatible';
import {
  canUseCurrentVideoPrimaryTextSelectionGeneration,
  getCurrentVideoPrimaryTextSelectionMutationState,
  saveCurrentVideoPrimaryTextSelection,
} from '../storage/current-video-primary-text-selection-store.ts';
import {
  canUseCurrentVideoTranscriptClearGeneration,
  getCurrentVideoTranscriptClearState,
} from '../current-video-transcript-clear-epoch.ts';
import {
  readCurrentVideoPrimaryTextSelections,
  resolveCurrentVideoPrimaryTextAuthorization,
} from '../../shared/current-video-primary-text-selection.ts';
import {
  getCurrentVideoSummaryHighlightsCache,
  buildCurrentVideoSummaryHighlightsCacheKey,
} from '../storage/current-video-summary-highlights-repo.ts';
import {
  clearCurrentVideoTimestampOperationLeasesForTab,
  consumeCurrentVideoTimestampOperationLease,
  issueCurrentVideoTimestampOperationLease,
  retireCurrentVideoTimestampOperationLease,
} from '../current-video-timestamp-operation-lease.ts';

const EXPORT_PAGE_LIMIT_MAX = 1000;
const SUBTITLE_PROBE_CACHE_MS = 5 * 60 * 1000;
const DYNAMIC_BILL_MIGRATION_GATED_ACTIONS = new Set<RequestAction>([
  'GET_LOCAL_DATA_PRIVACY_SUMMARY',
  'GET_DYNAMIC_BILL_OVERVIEW',
  'SYNC_DYNAMIC_UPDATES',
  'GENERATE_DYNAMIC_BILL',
  'BUILD_DYNAMIC_BILL_EXPLANATIONS',
  'GET_DYNAMIC_BILL_ITEMS',
  'GET_DYNAMIC_BILL_FILTER',
  'UPDATE_DYNAMIC_BILL_FILTER',
  'ADD_DYNAMIC_BILL_FEEDBACK',
  'GET_DYNAMIC_BILL_FEEDBACK_STATE',
  'APPLY_DYNAMIC_BILL_CREATOR_LESS_REMINDER',
  'UNDO_DYNAMIC_BILL_CREATOR_LESS_REMINDER',
  'DISMISS_DYNAMIC_BILL_CREATOR_REVIEW_PROMPT',
  'OPEN_DYNAMIC_BILL_CREATOR_REVIEW_PROMPT',
  'GET_DYNAMIC_BILL_ACTIVE_PAUSES',
  'RESTORE_DYNAMIC_BILL_CREATOR_REMINDER',
  'OPEN_DYNAMIC_BILL_VIDEO',
  'MARK_DYNAMIC_BILL_ITEM_PROCESSED',
]);
const DYNAMIC_BILL_DATA_OPERATION_ACTIONS = new Set<RequestAction>([
  'GET_CREATOR_DATA',
  'GET_LOCAL_DATA_PRIVACY_SUMMARY',
  'GET_DYNAMIC_BILL_OVERVIEW',
  'BUILD_DYNAMIC_BILL_EXPLANATIONS',
  'GET_DYNAMIC_BILL_ITEMS',
  'GET_DYNAMIC_BILL_FILTER',
  'UPDATE_DYNAMIC_BILL_FILTER',
  'ADD_DYNAMIC_BILL_FEEDBACK',
  'GET_DYNAMIC_BILL_FEEDBACK_STATE',
  'APPLY_DYNAMIC_BILL_CREATOR_LESS_REMINDER',
  'UNDO_DYNAMIC_BILL_CREATOR_LESS_REMINDER',
  'DISMISS_DYNAMIC_BILL_CREATOR_REVIEW_PROMPT',
  'OPEN_DYNAMIC_BILL_CREATOR_REVIEW_PROMPT',
  'GET_DYNAMIC_BILL_ACTIVE_PAUSES',
  'RESTORE_DYNAMIC_BILL_CREATOR_REMINDER',
  'OPEN_DYNAMIC_BILL_VIDEO',
  'MARK_DYNAMIC_BILL_ITEM_PROCESSED',
]);
const DYNAMIC_BILL_SELF_GATED_ACTIONS = new Set<RequestAction>([
  'SYNC_DYNAMIC_UPDATES',
  'GENERATE_DYNAMIC_BILL',
]);
const currentVideoContexts = new Map<number, CurrentVideoContextResult>();
const currentVideoSubtitleProbes = new Map<string, CurrentVideoSubtitleSourceState>();
const currentVideoSubtitleProbeRequests = new Map<string, Promise<CurrentVideoSubtitleSourceState>>();
const PRIMARY_TEXT_SELECTION_NOT_READY_MESSAGE = '主要文本来源选择还在读取中，请稍等本页保存的选择读取完成后再试。';

interface CurrentVideoLookupOptions {
  forceContextRefresh?: boolean;
  forceSubtitleProbe?: boolean;
}

interface CurrentVideoContextLookupResult {
  tab: CurrentVideoTabSnapshot | null;
  context: CurrentVideoContextResult;
  temporaryOwner?: CurrentVideoTemporaryTranscriptOwner;
  primaryTextAuthorized?: boolean;
  primaryTextGuard?: CurrentVideoPrimaryTextAuthorizationGuard;
}

interface BilibiliVideoUrlIdentity {
  bvid: string;
  page: number;
}

interface CurrentVideoPrimaryTextAuthorizationGuard {
  bvid: string;
  cid: number;
  page: number;
  sourceIdentityKey: string;
  selectionGeneration: number;
  transcriptClearGeneration: number;
}

interface CurrentVideoPrimaryTextAuthorizationEpochs {
  selectionGeneration: number;
  selectionMutating: boolean;
  transcriptClearGeneration: number;
  transcriptClearing: boolean;
}

type CurrentVideoPrimaryTextGuardTestPhase =
  | 'before_active_source_check'
  | 'before_evidence_bind'
  | 'before_segment_body_read'
  | 'after_segment_body_read'
  | 'before_full_text_qa_session_write'
  | 'before_full_text_qa_network'
  | 'before_timestamp_message';

export function setupMessageHandlers(): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Handle content script messages
    const contentMsg = message as BiliVizContentMessage;
    if (contentMsg.action && ['PLAYER_HEARTBEAT', 'PLAYER_ACTION', 'PAGE_NAVIGATION', 'CURRENT_VIDEO_CONTEXT_UPDATE'].includes(contentMsg.action)) {
      handleContentMessage(contentMsg, sender.tab?.id ?? 0, sender.tab?.url ?? null).then(() => {
        sendResponse({ success: true });
      }).catch((err) => {
        sendResponse({ success: false, error: errorMessage(err) });
      });
      return true; // keep channel open
    }

    // Handle UI request messages
    const request = message as BiliVizRequest;
    if (request.action) {
      handleRequest(request, sender.tab?.id ?? null).then(sendResponse).catch((err) => {
        sendResponse({ success: false, error: errorMessage(err) });
      });
      return true;
    }

    return false;
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    cancelLearningChats(chat => chat.tabId === tabId);
    currentVideoContexts.delete(tabId);
    clearTemporaryCurrentVideoTranscriptCacheForTab(tabId);
    clearCurrentVideoTimestampOperationLeasesForTab(tabId);
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    const nextUrl = changeInfo.url;
    if (!nextUrl) return;
    cancelLearningChats(chat => chat.tabId === tabId);
    currentVideoContexts.delete(tabId);
    clearTemporaryCurrentVideoTranscriptCacheForTab(tabId);
    clearCurrentVideoTimestampOperationLeasesForTab(tabId);
  });
}

async function handleContentMessage(
  msg: BiliVizContentMessage,
  tabId: number,
  senderTabUrl: string | null = null,
): Promise<void> {
  switch (msg.action) {
    case 'CURRENT_VIDEO_CONTEXT_UPDATE': {
      if (tabId > 0) {
        const context = msg.payload as CurrentVideoContextResult;
        if (context.kind !== 'video') {
          if (!senderTabUrl || !isBilibiliVideoUrl(senderTabUrl)) {
            cancelLearningChats(chat => chat.tabId === tabId);
            currentVideoContexts.delete(tabId);
            clearTemporaryCurrentVideoTranscriptCacheForTab(tabId);
          }
          break;
        }
        if (!canAcceptCurrentVideoContextUpdate(context, senderTabUrl)) {
          break;
        }
        const previous = currentVideoContexts.get(tabId);
        if (previous?.kind === 'video' && (previous.bvid !== context.bvid || previous.cid !== context.cid || previous.currentPart.page !== context.currentPart.page)) {
          cancelLearningChats(chat => chat.tabId === tabId);
        }
        currentVideoContexts.set(tabId, context);
        if (context.cid) {
          retainTemporaryCurrentVideoTranscriptOwner({
            ownerTabId: tabId,
            bvid: context.bvid,
            cid: context.cid,
            page: context.currentPart.page,
          });
        } else {
          clearTemporaryCurrentVideoTranscriptCacheForTab(tabId);
        }
      }
      break;
    }
    case 'PLAYER_HEARTBEAT': {
      const p = msg.payload as PlayerHeartbeatPayload;
      await runHistoryPlayerEventDataOperation(async () => {
        await db.playerEvents.add({
          bvid: p.bvid,
          cid: p.cid,
          eventType: 'heartbeat',
          timestamp: Date.now(),
          currentTime: p.currentTime,
          duration: p.duration,
          playbackRate: p.playbackRate ?? 1,
          tabId,
        });
        await markConsumedFromPlayerEvent(p);
      });
      break;
    }
    case 'PLAYER_ACTION': {
      const p = msg.payload as PlayerActionPayload;
      await runHistoryPlayerEventDataOperation(async () => {
        await db.playerEvents.add({
          bvid: p.bvid,
          cid: p.cid,
          eventType: p.action,
          timestamp: Date.now(),
          currentTime: p.currentTime,
          duration: p.duration,
          playbackRate: p.playbackRate ?? 1,
          seekFrom: p.seekFrom,
          seekTo: p.seekTo,
          tabId,
        });
        await markConsumedFromPlayerEvent(p);
      });
      break;
    }
    case 'PAGE_NAVIGATION':
      cancelLearningChats(chat => chat.tabId === tabId);
      currentVideoContexts.delete(tabId);
      clearTemporaryCurrentVideoTranscriptCacheForTab(tabId);
      break;
  }
}

function canAcceptCurrentVideoContextUpdate(
  context: CurrentVideoContext,
  senderTabUrl: string | null,
): boolean {
  const contextUrlIdentity = bilibiliVideoUrlIdentity(context.url);
  if (!contextUrlIdentity || !contextMatchesVideoUrlIdentity(context, contextUrlIdentity)) {
    return false;
  }

  if (!senderTabUrl) return true;
  const senderUrlIdentity = bilibiliVideoUrlIdentity(senderTabUrl);
  return Boolean(
    senderUrlIdentity
    && senderUrlIdentity.bvid === contextUrlIdentity.bvid
    && senderUrlIdentity.page === contextUrlIdentity.page,
  );
}

function bilibiliVideoUrlIdentity(url: string | null | undefined): BilibiliVideoUrlIdentity | null {
  if (!url || !isBilibiliVideoUrl(url)) return null;
  const bvid = extractBvidFromUrl(url);
  if (!bvid) return null;
  return {
    bvid,
    page: extractPageFromUrl(url),
  };
}

function contextMatchesVideoUrlIdentity(
  context: CurrentVideoContext,
  identity: BilibiliVideoUrlIdentity,
): boolean {
  return context.bvid === identity.bvid
    && context.currentPart.page === identity.page;
}


export async function handleRequest<T>(
  request: BiliVizRequest,
  requestTabId: number | null = null,
): Promise<BiliVizResponse<T>> {
  if (request.action === 'LEARNING_OPEN_SOURCE' || request.action === 'LEARNING_RETURN_SOURCE') {
    try {
      const data = request.action === 'LEARNING_RETURN_SOURCE' ? await returnLearning(request.params?.returnId)
        : await navigateLearning(request.params ?? {}, async (tabId, row) => {
          const lookup = await getCurrentVideoSubtitleViewLookup(undefined, tabId);
          const context = lookup.context;
          if (context.kind !== 'video' || context.bvid !== row.video.bvid || String(context.cid) !== row.part?.cid || context.currentPart.page !== row.part.page) return false;
          return context.transcriptEvidence?.active === true && context.transcriptEvidence.sourceHash === row.snapshot?.source.hash;
        });
      return { success: true, data: data as T };
    } catch { return { success: false, error: '来源操作未完成，请确认视频与笔记仍然可用。' }; }
  }
  if (request.action.startsWith('LEARNING_')) {
    return await handleLearningRequest(request.action, request.params, requestTabId, resolveLearningSource) as BiliVizResponse<T>;
  }
  if (DYNAMIC_BILL_DATA_OPERATION_ACTIONS.has(request.action)) {
    return runDynamicBillDataOperation(async () => {
      await ensureDynamicBill013Migration();
      return handleRequestExclusive<T>(request, requestTabId);
    });
  }
  if (DYNAMIC_BILL_SELF_GATED_ACTIONS.has(request.action)) {
    return handleRequestExclusive<T>(request, requestTabId);
  }
  if (DYNAMIC_BILL_MIGRATION_GATED_ACTIONS.has(request.action)) {
    await ensureDynamicBill013Migration();
  }
  return handleRequestExclusive<T>(request, requestTabId);
}

async function handleRequestExclusive<T>(
  request: BiliVizRequest,
  requestTabId: number | null,
): Promise<BiliVizResponse<T>> {
  switch (request.action) {
    case 'GET_QUICK_STATS':
      return { success: true, data: await getQuickStats() as T };
    case 'GET_DASHBOARD_DATA':
      return { success: true, data: await getDashboardOverview() as T };
    case 'GET_PREFERENCE_DATA':
      return { success: true, data: await getPreferenceData(request.params) as T };
    case 'GET_CREATOR_DATA':
      return { success: true, data: await getCreatorData() as T };
    case 'GET_BEHAVIOR_DATA':
      return { success: true, data: await getBehaviorData() as T };
    case 'GET_EXPERIMENT_DATA':
      return { success: true, data: await getExperimentData() as T };
    case 'GET_DEVICE_DATA':
      return { success: true, data: await getDeviceData() as T };
    case 'SYNC_NOW':
      {
        const requestedMode = request.params?.mode === 'full' ? 'full' : request.params?.mode === 'incremental' ? 'incremental' : null;
        const requestedMaxPages = Number(request.params?.maxPages);
        const maxPages = Number.isFinite(requestedMaxPages) ? requestedMaxPages : undefined;
        const normalizedMaxPages = normalizePageLimit(maxPages);
        const storedCount = await db.watchHistory.count();
        const mode = requestedMode ?? (storedCount === 0 ? 'full' : 'incremental');
        if (await getHistorySyncing() || hasActiveHistoryDataOperation()) {
          throw new Error('HISTORY_SYNC_IN_PROGRESS');
        }

        void runInitialBackfill(mode, requestedMode === 'full', { maxPages })
          .then(async (result) => {
            await setDeviceTypeMigrationComplete();
            await computeStoredHistoryAggregates(result);
          })
          .catch((err) => {
            console.error('[BiliViz] Manual history sync failed:', err);
          });

        return {
          success: true,
          data: {
            synced: true,
            mode,
            requestedPageLimit: maxPages ?? null,
            pageLimit: normalizedMaxPages,
            currentTask: 'sync_started',
            fetchedPages: 0,
            fetchedCount: 0,
            insertedCount: 0,
            updatedCount: 0,
            skippedCount: 0,
            duplicateCount: 0,
            unsupportedBusinessCount: 0,
            liveExcludedCount: 0,
            missingIdCount: 0,
            stoppedReason: 'sync_started',
            reachedEnd: false,
            oldestFetchedAt: null,
            newestFetchedAt: null,
            finalCursor: null,
          } satisfies SyncNowResult as T,
        };
      }
    case 'CANCEL_SYNC':
      await requestHistorySyncCancel();
      abortCurrentHistorySync();
      return { success: true };
    case 'GET_CONFIG':
      return { success: true, data: await loadConfig() as T };
    case 'GET_CONFIG_SNAPSHOT':
      return { success: true, data: await loadConfigSnapshot() as T };
    case 'UPDATE_CONFIG': {
      const {
        expectedConfig: expectedConfigValue,
        expectedConfigRevision,
        ...configPatch
      } = (request.params ?? {}) as Partial<UserConfig> & {
        expectedConfig?: unknown;
        expectedConfigRevision?: unknown;
      };
      const expectedConfig = expectedConfigValue && typeof expectedConfigValue === 'object'
        ? normalizeUserConfig(expectedConfigValue)
        : undefined;
      const expectation = expectedConfig && typeof expectedConfigRevision === 'string'
        ? { config: expectedConfig, revision: expectedConfigRevision }
        : undefined;
      if (!expectation) throw new Error('LOCAL_SETTINGS_STALE_CONFIG');
      const saved = await saveConfig(configPatch, expectation);
      if (currentVideoSummaryHighlightsConfigChanged(saved.previousConfig, saved.snapshot.config)) {
        invalidateCurrentVideoSummaryHighlightsConfig();
        invalidateCurrentVideoFullTextQaConfig();
      }
      return { success: true, data: saved.snapshot as T };
    }
    case 'EXPORT_DATA': {
      const allRecords = await db.watchHistory.toArray();
      const format = (request.params?.format as string) ?? 'json';
      return { success: true, data: { records: allRecords, format } as T };
    }
    case 'EXPORT_DATA_PAGE': {
      const offset = normalizeNonNegativeInteger(request.params?.offset, 0);
      const limit = Math.max(1, Math.min(normalizeNonNegativeInteger(request.params?.limit, 500), EXPORT_PAGE_LIMIT_MAX));
      const [records, total] = await Promise.all([
        db.watchHistory.orderBy('viewAt').offset(offset).limit(limit).toArray(),
        db.watchHistory.count(),
      ]);
      const nextOffset = offset + records.length;
      return {
        success: true,
        data: {
          records,
          total,
          offset,
          nextOffset,
          hasMore: nextOffset < total,
        } as T,
      };
    }
    case 'GET_SYNC_STATUS': {
      if (await getHistorySyncing() && !hasActiveHistorySyncAbortScope()) {
        await clearOrphanedHistorySyncLock();
      }
      const lastSync = await getLastSyncTime();
      const count = await db.watchHistory.count();
      const [syncProgress, backfillComplete] = await Promise.all([
        getHistorySyncProgress(),
        getBackfillComplete(),
      ]);
      return {
        success: true,
        data: {
          lastSyncTime: lastSync,
          totalRecords: count,
          backfillComplete,
          syncProgress,
        } satisfies HistorySyncStatus as T,
      };
    }
    case 'PROBE_HISTORY_TAIL': {
      const requestedMaxPages = Number(request.params?.maxPages);
      if (await getHistorySyncing()) {
        throw new Error('HISTORY_SYNC_IN_PROGRESS');
      }
      return {
        success: true,
        data: await probeHistoryTailCoverage({
          maxPages: Number.isFinite(requestedMaxPages) ? requestedMaxPages : undefined,
        }) as T,
      };
    }
    case 'TEST_AI_CONNECTION':
      return { success: true, data: await testAiConnection(normalizeAiConfigParam(request.params?.ai)) as T };
    case 'GET_LOCAL_DATA_PRIVACY_SUMMARY':
      return { success: true, data: await getLocalDataPrivacySummary() as T };
    case 'CLEAR_CURRENT_VIDEO_SUBTITLE_CACHE':
      return { success: true, data: await clearCurrentVideoSubtitleCache() as T };
    case 'CLEAR_CURRENT_VIDEO_SUMMARY_HIGHLIGHT_CACHE':
      return { success: true, data: await clearCurrentVideoSummaryHighlightCache() as T };
    case 'CLEAR_LOCAL_DATA_CATEGORY': {
      const categoryId = request.params?.categoryId;
      if (!isIndependentlyClearableLocalDataCategoryId(categoryId)) {
        throw new Error('LOCAL_DATA_CATEGORY_NOT_CLEARABLE');
      }
      return { success: true, data: await clearLocalDataCategory(categoryId) as T };
    }
    case 'REBUILD_SMART_FAVORITE_INDEX': {
      const batchSize = Math.min(normalizePositiveInteger(request.params?.batchSize, 25), 100);
      return { success: true, data: await rebuildSmartFavoriteIndex(batchSize) as T };
    }
    case 'CLEAR_ALL_LOCAL_DATA':
      return { success: true, data: await clearAllLocalData(request.params?.confirmation) as T };
    case 'GET_CURRENT_VIDEO_CONTEXT':
      return { success: true, data: await getCurrentVideoContextForActiveTab(currentVideoLookupOptions(request.params), requestTabId) as T };
    case 'SAVE_CURRENT_VIDEO_PRIMARY_TEXT_SELECTION': {
      const bvid = requireStringParam(request.params?.bvid, 'bvid');
      const cid = requirePositiveIntegerParam(request.params?.cid, 'cid');
      const page = requirePositiveIntegerParam(request.params?.page, 'page');
      const saved = await saveCurrentVideoPrimaryTextSelection({
        bvid,
        cid,
        page,
        selectedSourceIdentityKey: requireStringParam(
          request.params?.selectedSourceIdentityKey,
          'selectedSourceIdentityKey',
        ),
      });
      return {
        success: true,
        data: saved as T,
      };
    }
    case 'PROBE_CURRENT_VIDEO_SUBTITLE_SOURCE':
      return { success: true, data: await probeSubtitleSourceForActiveTab(request.params, requestTabId) as T };
    case 'GET_CURRENT_VIDEO_TRANSCRIPT_EVIDENCE':
      return { success: true, data: await getTranscriptEvidenceForActiveTab(request.params, requestTabId) as T };
    case 'GET_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS_CACHE': {
      if (!primaryTextSelectionsReady(request.params)) {
        return { success: true, data: primaryTextSelectionNotReadySummaryHighlights() as T };
      }
      const lookup = await getCurrentVideoContextLookupWithSelection(request.params, requestTabId);
      if (!lookup.primaryTextAuthorized) {
        return { success: true, data: primaryTextSelectionNotReadySummaryHighlights() as T };
      }
      return {
        success: true,
        data: await readCachedCurrentVideoSummaryHighlights(lookup.context) as T,
      };
    }
    case 'GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS': {
      const requestId = optionalStringParam(request.params?.requestId) ?? undefined;
      const sourceIdentityKey = selectedSourceIdentityKey(request.params);
      const preflight = requestId
        ? registerCurrentVideoSummaryHighlightsPreflightRequest({
            requestId,
            sourceIdentityKey,
          })
        : {
            requestId: null,
            configGeneration: getCurrentVideoSummaryHighlightsConfigGeneration(),
          };
      try {
      if (!primaryTextSelectionsReady(request.params)) {
        return { success: true, data: primaryTextSelectionNotReadySummaryHighlights() as T };
      }
      const lookup = await getCurrentVideoContextLookupWithSelection(request.params, requestTabId);
      if (!lookup.primaryTextAuthorized) {
        return { success: true, data: primaryTextSelectionNotReadySummaryHighlights() as T };
      }
      const config = await loadConfig();
      const title = currentVideoSummaryHighlightsTitle(lookup.context);
      const textSize = approximateSizeFromContext(lookup.context);
      if (!config.assistant.currentVideoAiAssistantEnabled) {
        return { success: true, data: disabledCurrentVideoSummaryHighlights(title, config.ai.chatModel.trim() || null, textSize) as T };
      }
      if (!config.ai.baseURL.trim() || !config.ai.chatModel.trim() || !config.ai.apiKey.trim()) {
        return { success: true, data: notConfiguredCurrentVideoSummaryHighlights(title, config.ai.chatModel.trim() || null, textSize) as T };
      }
      const transcriptSegments = await getAuthorizedCurrentVideoTranscriptSegments(lookup);
      if (!transcriptSegments) {
        if (!currentVideoSummaryHighlightsSourceDataStillCurrent(lookup)) {
          return { success: true, data: cancelledCurrentVideoSummaryHighlights(
            title,
            config.ai.chatModel.trim() || null,
            textSize,
          ) as T };
        }
        return { success: true, data: noTextCurrentVideoSummaryHighlights(title, config.ai.chatModel.trim() || null, textSize) as T };
      }
      const liveConfig = await loadConfig();
      if (!liveConfig.assistant.currentVideoAiAssistantEnabled) {
        return { success: true, data: disabledCurrentVideoSummaryHighlights(title, liveConfig.ai.chatModel.trim() || null, textSize) as T };
      }
      if (!currentVideoAiConfigComplete(liveConfig)) {
        return { success: true, data: notConfiguredCurrentVideoSummaryHighlights(title, liveConfig.ai.chatModel.trim() || null, textSize) as T };
      }
      if (
        !canUseCurrentVideoSummaryHighlightsConfigGeneration(preflight.configGeneration)
        || !currentVideoSummaryHighlightsSourceDataStillCurrent(lookup)
      ) {
        return { success: true, data: cancelledCurrentVideoSummaryHighlights(
          title,
          liveConfig.ai.chatModel.trim() || null,
          textSize,
        ) as T };
      }
      return {
        success: true,
        data: await generateCurrentVideoSummaryHighlights(lookup.context, {
          config: liveConfig,
          configGeneration: preflight.configGeneration,
          requestId,
          transcriptSegments,
          resolveLiveConfig: loadConfig,
          resolveCurrentIdentity: () => resolveCurrentVideoSummaryHighlightCommitIdentity(request.params, requestTabId),
          sourceDataStillCurrent: () => currentVideoSummaryHighlightsSourceDataStillCurrent(lookup),
          authorizationStillEnabled: async () => (
            await loadConfig()
          ).assistant.currentVideoAiAssistantEnabled,
        }) as T,
      };
      } finally {
        settleCurrentVideoSummaryHighlightsPreflightRequest(requestId);
      }
    }
    case 'CANCEL_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS': {
      const requestId = optionalStringParam(request.params?.requestId);
      if (requestId) {
        cancelCurrentVideoSummaryHighlightsRequest(requestId);
      } else {
        const sourceIdentityKey = selectedSourceIdentityKey(request.params);
        if (sourceIdentityKey) {
          cancelCurrentVideoSummaryHighlightsForSource(sourceIdentityKey);
        }
      }
      return { success: true, data: { cancelled: true } as T };
    }
    case 'GET_CURRENT_VIDEO_QA_SESSIONS': {
      const sessionId = optionalStringParam(request.params?.sessionId) ?? null;
      return { success: true, data: await getCurrentVideoQaSessionsView(sessionId) as T };
    }
    case 'MEMORY_OPERATION': {
      return { success: true, data: await new ExplicitMemoryRepository(db).operate(request.params as unknown as import('../../shared/explicit-memory.ts').MemoryOperation) as T };
    }
    case 'RENAME_CURRENT_VIDEO_QA_SESSION': {
      const sessionId = requireStringParam(request.params?.sessionId, 'sessionId');
      const title = requireStringParam(request.params?.title, 'title');
      await renameCurrentVideoQaSession(sessionId, title);
      return { success: true, data: await getCurrentVideoQaSessionsView(sessionId) as T };
    }
    case 'DELETE_CURRENT_VIDEO_QA_SESSION': {
      const sessionId = requireStringParam(request.params?.sessionId, 'sessionId');
      cancelCurrentVideoFullTextQaForSession(sessionId);
      return { success: true, data: await deleteCurrentVideoQaSession(sessionId, request.params?.deleteAssociatedMemory === true) as T };
    }
    case 'CLEAR_CURRENT_VIDEO_QA_SESSIONS': {
      invalidateCurrentVideoFullTextQaSources();
      const result = await clearLocalDataCategory('currentVideoQaSessions');
      if (result.status === 'partial_failure') {
        throw new Error('LOCAL_DATA_CATEGORY_CLEAR_FAILED');
      }
      return { success: true, data: await getCurrentVideoQaSessionsView(null) as T };
    }
    case 'GET_LEARNING_CHAT_PROGRESS':
    case 'CANCEL_LEARNING_CHAT': {
      return { success: true, data: learningChatProgress(requireStringParam(request.params?.requestId, 'requestId'), requestTabId, request.action === 'CANCEL_LEARNING_CHAT') as T };
    }
    case 'ASK_LEARNING_CHAT': {
      const data = await askLearningChat({
        requestId: requireStringParam(request.params?.requestId, 'requestId'),
        sessionId: requireStringParam(request.params?.sessionId, 'sessionId'),
        turnId: requireStringParam(request.params?.turnId, 'turnId'),
        question: requireStringParam(request.params?.question, 'question'), tabId: requestTabId,
        resolveSource: async () => {
          const lookup = await getCurrentVideoContextLookupWithSelection(request.params, requestTabId);
          const segments = primaryTextSelectionsReady(request.params) && lookup.primaryTextAuthorized
            ? await getAuthorizedCurrentVideoTranscriptSegments(lookup) : null;
          const source = segments?.length ? currentVideoQaSourceSnapshotFromLookup(lookup, segments) : null;
          return { source, text: segments?.map(segment => segment.text).join('\n') ?? '', stillCurrent: async () => {
            if (!source) return true;
            const identity = await resolveCurrentVideoSummaryHighlightCommitIdentity(request.params, requestTabId);
            return currentVideoSummaryHighlightsSourceDataStillCurrent(lookup) && identity?.sourceIdentityKey === source.sourceIdentityKey;
          } };
        },
      });
      return { success: true, data: data as T };
    }
    case 'ASK_CURRENT_VIDEO_FULL_TEXT': {
      const requestId = requireStringParam(request.params?.requestId, 'requestId');
      const sessionId = optionalStringParam(request.params?.sessionId)
        ?? `current-video-session-${requestTabId ?? 'page'}`;
      const turnId = requireStringParam(request.params?.turnId, 'turnId');
      const question = requireStringParam(request.params?.question, 'question');
      const sourceIdentityKey = selectedSourceIdentityKey(request.params);
      let sessionWriteGuard: CurrentVideoQaSessionWriteGuard | null = null;
      const preflight = registerCurrentVideoFullTextQaPreflightRequest({
        requestId,
        sessionId,
        turnId,
        sourceIdentityKey,
        requestScopeId: requestTabId ? `tab-${requestTabId}` : null,
        bvid: optionalStringParam(request.params?.bvid),
        cid: optionalPositiveIntegerParam(request.params?.cid),
        page: optionalPositiveIntegerParam(request.params?.page),
      });
      try {
        if (!preflight.accepted) {
          return {
            success: true,
            data: unavailableCurrentVideoFullTextQa({
              status: 'error',
              requestId,
              sessionId,
              turnId,
              question,
              message: preflight.blockedReason === 'session_busy'
                ? '当前会话已有问题正在回答，请等它完成后再继续。'
                : '问题没有提交成功，请保留当前问题并重试。',
            }) as T,
          };
        }
        sessionWriteGuard = registerCurrentVideoQaSessionTurnWriteGuard({
          sessionId,
          turnId,
          requestId,
        });
        if (!sessionWriteGuard.writable) {
          return {
            success: true,
            data: unavailableCurrentVideoFullTextQa({
              status: 'cancelled',
              requestId,
              sessionId,
              turnId,
              question,
              message: '问答会话正在清理，本次问题不再写入。',
            }) as T,
          };
        }
        if (!primaryTextSelectionsReady(request.params)) {
          const result = unavailableCurrentVideoFullTextQa({
            status: 'no_text',
            requestId,
            sessionId,
            turnId,
            question,
            message: PRIMARY_TEXT_SELECTION_NOT_READY_MESSAGE,
          });
          await upsertCurrentVideoQaPendingTurn({ sessionId, requestId, turnId, question, source: null, writeGuard: sessionWriteGuard });
          return { success: true, data: await completeAndReturnCurrentVideoQaTurn(sessionId, turnId, result, sessionWriteGuard) as T };
        }
        const lookup = await getCurrentVideoContextLookupWithSelection(request.params, requestTabId);
        let sourceSnapshot = currentVideoQaSourceSnapshotFromLookup(lookup, null);
        if (!lookup.primaryTextAuthorized || !lookup.primaryTextGuard) {
          const result = unavailableCurrentVideoFullTextQa({
            status: 'no_text',
            requestId,
            sessionId,
            turnId,
            question,
            title: lookup.context.kind === 'video' ? lookup.context.title : null,
            partTitle: lookup.context.kind === 'video' ? lookup.context.currentPart.title : null,
            sourceReference: sourceReferenceFromCurrentVideoQaSource(sourceSnapshot),
            textSize: sourceSnapshot?.textSize,
            message: PRIMARY_TEXT_SELECTION_NOT_READY_MESSAGE,
          });
          await upsertCurrentVideoQaPendingTurn({ sessionId, requestId, turnId, question, source: sourceSnapshot, writeGuard: sessionWriteGuard });
          return { success: true, data: await completeAndReturnCurrentVideoQaTurn(sessionId, turnId, result, sessionWriteGuard) as T };
        }
        if (!bindCurrentVideoFullTextQaPreflightPart(requestId, {
          bvid: lookup.primaryTextGuard.bvid,
          cid: lookup.primaryTextGuard.cid,
          page: lookup.primaryTextGuard.page,
          requestScopeId: lookup.tab?.id ? `tab-${lookup.tab.id}` : null,
        })) {
          const result = unavailableCurrentVideoFullTextQa({
            status: 'cancelled',
            requestId,
            sessionId,
            turnId,
            question,
            title: lookup.context.kind === 'video' ? lookup.context.title : null,
            partTitle: lookup.context.kind === 'video' ? lookup.context.currentPart.title : null,
            sourceReference: sourceReferenceFromCurrentVideoQaSource(sourceSnapshot),
            textSize: sourceSnapshot?.textSize,
            message: '本次回答已取消，问题已保留。',
          });
          await upsertCurrentVideoQaPendingTurn({ sessionId, requestId, turnId, question, source: sourceSnapshot, writeGuard: sessionWriteGuard });
          return { success: true, data: await completeAndReturnCurrentVideoQaTurn(sessionId, turnId, result, sessionWriteGuard) as T };
        }
        const transcriptSegments = await getAuthorizedCurrentVideoTranscriptSegments(lookup);
        sourceSnapshot = currentVideoQaSourceSnapshotFromLookup(lookup, transcriptSegments);
        if (!transcriptSegments) {
          const cancelled = !currentVideoSummaryHighlightsSourceDataStillCurrent(lookup);
          const result = unavailableCurrentVideoFullTextQa({
            status: cancelled ? 'cancelled' : 'no_text',
            requestId,
            sessionId,
            turnId,
            question,
            title: lookup.context.kind === 'video' ? lookup.context.title : null,
            partTitle: lookup.context.kind === 'video' ? lookup.context.currentPart.title : null,
            sourceReference: sourceReferenceFromCurrentVideoQaSource(sourceSnapshot),
            textSize: sourceSnapshot?.textSize,
            message: cancelled
              ? '当前主要文本已变化，本次回答已取消，问题已保留。'
              : '当前分 P 没有可用的主要文本，无法回答。问题已保留。',
          });
          await upsertCurrentVideoQaPendingTurn({ sessionId, requestId, turnId, question, source: sourceSnapshot, writeGuard: sessionWriteGuard });
          return { success: true, data: await completeAndReturnCurrentVideoQaTurn(sessionId, turnId, result, sessionWriteGuard) as T };
        }
        const existingSession = await getCurrentVideoQaSessionForSubmit(sessionId);
        const sourceKey = sourceSnapshot?.sourceIdentityKey ?? lookup.primaryTextGuard.sourceIdentityKey;
        const refusal = shouldRefuseCurrentVideoQaBeforeNetwork({
          session: existingSession,
          question,
          sourceIdentityKey: sourceKey,
        });
        const config = await loadConfig();
        await currentVideoPrimaryTextGuardTestHook('before_full_text_qa_session_write');
        await upsertCurrentVideoQaPendingTurn({ sessionId, requestId, turnId, question, source: sourceSnapshot, writeGuard: sessionWriteGuard });
        if (refusal) {
          const result = buildRefusedCurrentVideoQaResult({
            sessionId,
            requestId,
            turnId,
            question,
            message: refusal,
            source: sourceSnapshot,
            model: config.ai.chatModel.trim() || null,
          });
          return { success: true, data: await completeAndReturnCurrentVideoQaTurn(sessionId, turnId, result, sessionWriteGuard) as T };
        }
        const conversationContext = buildCurrentVideoQaConversationContext(existingSession, sourceKey);
        await currentVideoPrimaryTextGuardTestHook('before_full_text_qa_network');
        const result = await generateCurrentVideoFullTextQa(lookup.context, {
          requestId,
          sessionId,
          turnId,
          question,
          transcriptSegments,
          conversationContext,
          config,
          configGeneration: preflight.configGeneration,
          resolveLiveConfig: loadConfig,
          resolveCurrentIdentity: () => resolveCurrentVideoSummaryHighlightCommitIdentity(request.params, requestTabId),
          sourceDataStillCurrent: () => currentVideoSummaryHighlightsSourceDataStillCurrent(lookup),
          authorizationStillEnabled: async () => {
            const liveConfig = await loadConfig();
            return liveConfig.assistant.currentVideoAiAssistantEnabled;
          },
        });
        return { success: true, data: await completeAndReturnCurrentVideoQaTurn(sessionId, turnId, result, sessionWriteGuard) as T };
      } catch (error) {
        if (isCurrentVideoQaSessionWriteInvalidatedError(error)) {
          return {
            success: true,
            data: unavailableCurrentVideoFullTextQa({
              status: 'cancelled',
              requestId,
              sessionId,
              turnId,
              question,
              message: '会话已更新、删除或清空，本次回答不再写入。',
            }) as T,
          };
        }
        if (isCurrentVideoQaSessionStorageLimitError(error)) {
          return {
            success: true,
            data: unavailableCurrentVideoFullTextQa({
              status: 'error',
              requestId,
              sessionId,
              turnId,
              question,
              message: CURRENT_VIDEO_QA_SESSION_STORAGE_LIMIT_MESSAGE,
            }) as T,
          };
        }
        throw error;
      } finally {
        settleCurrentVideoFullTextQaPreflightRequest(requestId);
        if (sessionWriteGuard) settleCurrentVideoQaSessionTurnWriteGuard(sessionWriteGuard);
      }
    }
    case 'CANCEL_CURRENT_VIDEO_FULL_TEXT_QA': {
      const requestId = optionalStringParam(request.params?.requestId);
      if (requestId) {
        cancelCurrentVideoFullTextQaRequest(requestId);
      } else {
        const sessionId = optionalStringParam(request.params?.sessionId);
        if (sessionId) {
          cancelCurrentVideoFullTextQaForSession(sessionId);
          return { success: true, data: { cancelled: true } as T };
        }
        const sourceIdentityKey = selectedSourceIdentityKey(request.params);
        if (sourceIdentityKey) cancelCurrentVideoFullTextQaForSource(sourceIdentityKey);
      }
      return { success: true, data: { cancelled: true } as T };
    }
    case 'GET_VIDEO_KNOWLEDGE': {
      if (!primaryTextSelectionsReady(request.params)) {
        return { success: true, data: primaryTextSelectionNotReadyKnowledge() as T };
      }
      const lookup = await getCurrentVideoContextLookupWithSelection(request.params, requestTabId);
      if (!lookup.primaryTextAuthorized) {
        return { success: true, data: primaryTextSelectionNotReadyKnowledge() as T };
      }
      const transcriptSegments = await getAuthorizedCurrentVideoTranscriptSegments(lookup);
      if (!transcriptSegments) {
        return { success: true, data: primaryTextSelectionNotReadyKnowledge() as T };
      }
      return { success: true, data: buildVideoKnowledgeResult(lookup.context, { transcriptSegments }) as T };
    }
    case 'SEARCH_CURRENT_VIDEO_SEGMENTS': {
      const query = String(request.params?.query ?? '');
      if (!primaryTextSelectionsReady(request.params)) {
        return { success: true, data: primaryTextSelectionNotReadySegmentResult(query) as T };
      }
      const lookup = await getCurrentVideoContextLookupWithSelection(request.params, requestTabId);
      if (!lookup.primaryTextAuthorized) {
        return { success: true, data: primaryTextSelectionNotReadySegmentResult(query) as T };
      }
      const transcriptSegments = await getAuthorizedCurrentVideoTranscriptSegments(lookup);
      if (!transcriptSegments) {
        return { success: true, data: primaryTextSelectionNotReadySegmentResult(query) as T };
      }
      const videoKnowledge = buildVideoKnowledgeResult(lookup.context, { transcriptSegments });
      return {
        success: true,
        data: await searchCurrentVideoSegmentsWithAiRerank(lookup.context, {
          query,
          transcriptSegments,
          videoKnowledge,
        }) as T,
      };
    }
    case 'GET_CURRENT_VIDEO_SUBTITLE_VIEW_SOURCES':
      return { success: true, data: await getCurrentVideoSubtitleViewSources(request.params, requestTabId) as T };
    case 'GET_CURRENT_VIDEO_RELATED_FAVORITES': {
      const context = await getCurrentVideoContextForActiveTab();
      return {
        success: true,
        data: await getCurrentVideoRelatedFavorites(context, request.params) as T,
      };
    }
    case 'REQUEST_CURRENT_VIDEO_SEGMENT_JUMP':
      return { success: true, data: await requestCurrentVideoSegmentJump(request.params, requestTabId) as T };
    case 'REQUEST_CURRENT_VIDEO_HIGHLIGHT_JUMP':
      return { success: true, data: await requestCurrentVideoHighlightJump(request.params, requestTabId) as T };
    case 'REQUEST_CURRENT_VIDEO_QA_CITATION_JUMP':
      return { success: true, data: await requestCurrentVideoQaCitationJump(request.params, requestTabId) as T };
    case 'REQUEST_CURRENT_VIDEO_SUBTITLE_JUMP':
      return { success: true, data: await requestCurrentVideoSubtitleJump(request.params, requestTabId) as T };
    case 'RETURN_CURRENT_VIDEO_SEGMENT_JUMP':
      return { success: true, data: await returnCurrentVideoSegmentJump(request.params, requestTabId) as T };
    case 'RETURN_CURRENT_VIDEO_SUBTITLE_JUMP':
      return { success: true, data: await returnCurrentVideoSubtitleJump(request.params, requestTabId) as T };
    case 'CONSUME_CURRENT_VIDEO_TIMESTAMP_OPERATION_LEASE':
      return {
        success: true,
        data: await consumeCurrentVideoTimestampLease(request.params, requestTabId) as T,
      };
    case 'GET_SMART_FAVORITES':
      return { success: true, data: await getSmartFavoriteOverview() as T };
    case 'GET_SMART_FAVORITES_BY_PATH': {
      const rawPath = request.params?.path;
      const path = Array.isArray(rawPath)
        ? rawPath.map(part => String(part))
        : String(rawPath ?? '').split('/').map(part => part.trim()).filter(Boolean);
      const limit = Number(request.params?.limit);
      return {
        success: true,
        data: await getSmartFavoritesByPath(path, Number.isFinite(limit) ? limit : undefined) as T,
      };
    }
    case 'SYNC_FAVORITES':
      return { success: true, data: await syncFavorites() as T };
    case 'PROBE_FAVORITE_FOLDER_GAP': {
      const mediaId = normalizePositiveInteger(request.params?.mediaId, 0);
      if (mediaId <= 0) {
        throw new Error('INVALID_FAVORITE_MEDIA_ID');
      }
      const maxPages = Math.min(normalizePositiveInteger(request.params?.maxPages, 12), 50);
      return {
        success: true,
        data: await probeFavoriteFolderGap(mediaId, maxPages) as T,
      };
    }
    case 'BUILD_SMART_FAVORITE_INDEX': {
      const maxItems = Number(request.params?.maxItems);
      const includeFailed = request.params?.includeFailed === true;
      const failedOnly = request.params?.failedOnly === true;
      return {
        success: true,
        data: await buildSmartFavoriteIndex(
          Number.isFinite(maxItems) ? maxItems : undefined,
          { includeFailed, failedOnly },
        ) as T,
      };
    }
    case 'SEARCH_SMART_FAVORITES': {
      const query = String(request.params?.query ?? '');
      const limit = Number(request.params?.limit);
      return {
        success: true,
        data: await searchSmartFavorites(query, Number.isFinite(limit) ? limit : undefined) as T,
      };
    }
    case 'ASK_SMART_FAVORITES': {
      const query = String(request.params?.query ?? '');
      const limit = Number(request.params?.limit);
      return {
        success: true,
        data: await answerSmartFavoriteQuestion(query, Number.isFinite(limit) ? limit : undefined) as T,
      };
    }
    case 'GET_DYNAMIC_BILL_OVERVIEW':
      return { success: true, data: await getDynamicOverview() as T };
    case 'SYNC_DYNAMIC_UPDATES':
      return { success: true, data: await syncDynamicBillUpdates() as T };
    case 'GENERATE_DYNAMIC_BILL':
      return { success: true, data: await generateDynamicBillItems() as T };
    case 'BUILD_DYNAMIC_BILL_EXPLANATIONS': {
      const maxItems = normalizePositiveInteger(request.params?.maxItems, 6);
      const includeFailed = request.params?.includeFailed !== false;
      return {
        success: true,
        data: await buildDynamicBillExplanations({ maxItems, includeFailed }) as T,
      };
    }
    case 'GET_DYNAMIC_BILL_ITEMS':
      return { success: true, data: await getDynamicBillItems() as T };
    case 'GET_DYNAMIC_BILL_FILTER':
      return { success: true, data: await getDynamicBillFilterPreference() as T };
    case 'UPDATE_DYNAMIC_BILL_FILTER': {
      const status = normalizeDynamicBillStatusFilter(request.params?.status);
      return { success: true, data: await setDynamicBillFilterPreference(status) as T };
    }
    case 'ADD_DYNAMIC_BILL_FEEDBACK': {
      const billKey = requireStringParam(request.params?.billKey, 'billKey');
      const scope = normalizeDynamicBillFeedbackScope(request.params?.scope);
      return { success: true, data: await addDynamicBillFeedback(billKey, scope) as T };
    }
    case 'GET_DYNAMIC_BILL_FEEDBACK_STATE':
      return { success: true, data: await getDynamicBillFeedbackState() as T };
    case 'APPLY_DYNAMIC_BILL_CREATOR_LESS_REMINDER': {
      const billKey = requireStringParam(request.params?.billKey, 'billKey');
      const idempotencyKey = optionalStringParam(request.params?.idempotencyKey);
      return {
        success: true,
        data: await applyDynamicBillCreatorLessReminder(billKey, { idempotencyKey }) as T,
      };
    }
    case 'UNDO_DYNAMIC_BILL_CREATOR_LESS_REMINDER': {
      const undoToken = requireStringParam(request.params?.undoToken, 'undoToken');
      return { success: true, data: await undoDynamicBillCreatorLessReminder(undoToken) as T };
    }
    case 'DISMISS_DYNAMIC_BILL_CREATOR_REVIEW_PROMPT': {
      const creatorMid = normalizePositiveInteger(request.params?.creatorMid, 0);
      if (creatorMid <= 0) throw new Error('INVALID_CREATOR_MID');
      return {
        success: true,
        data: await resolveDynamicBillCreatorReviewPrompt(creatorMid, 'dismiss') as T,
      };
    }
    case 'OPEN_DYNAMIC_BILL_CREATOR_REVIEW_PROMPT': {
      const creatorMid = normalizePositiveInteger(request.params?.creatorMid, 0);
      if (creatorMid <= 0) throw new Error('INVALID_CREATOR_MID');
      const result = await resolveDynamicBillCreatorReviewPrompt(creatorMid, 'open_space');
      if (result.status === 'resolved' && result.url) {
        await chrome.tabs.create({ url: result.url });
      }
      return { success: true, data: result as T };
    }
    case 'GET_DYNAMIC_BILL_ACTIVE_PAUSES':
      return { success: true, data: await getDynamicBillActiveCreatorPauseViews() as T };
    case 'RESTORE_DYNAMIC_BILL_CREATOR_REMINDER': {
      const creatorMid = normalizePositiveInteger(request.params?.creatorMid, 0);
      const pauseVersion = requireStringParam(request.params?.pauseVersion, 'pauseVersion');
      if (creatorMid <= 0) throw new Error('INVALID_CREATOR_MID');
      return {
        success: true,
        data: await restoreDynamicBillCreatorReminder(creatorMid, pauseVersion) as T,
      };
    }
    case 'OPEN_DYNAMIC_BILL_VIDEO': {
      const billKey = requireStringParam(request.params?.billKey, 'billKey');
      const item = await markDynamicBillItemOpened(billKey);
      if (!item) throw new Error('DYNAMIC_BILL_ITEM_NOT_FOUND');
      await chrome.tabs.create({ url: videoUrl(item.evidence.newVideo.bvid) });
      return { success: true, data: item as T };
    }
    case 'MARK_DYNAMIC_BILL_ITEM_PROCESSED': {
      const billKey = requireStringParam(request.params?.billKey, 'billKey');
      const item = await markDynamicBillItemProcessed(billKey);
      if (!item) throw new Error('DYNAMIC_BILL_ITEM_NOT_FOUND');
      return { success: true, data: item as T };
    }
    default:
      return { success: false, error: `Unknown action: ${request.action}` };
  }
}

async function getCurrentVideoRelatedFavorites(
  context: CurrentVideoContextResult,
  params?: Record<string, unknown>,
): Promise<CurrentVideoRelatedFavoritesResponse> {
  const now = Date.now();
  if (context.kind !== 'video') {
    return emptyCurrentVideoRelatedFavoritesResponse(context, now);
  }

  const hint = buildCurrentVideoRelatedFavoritesHint(context, {
    question: typeof params?.question === 'string' ? params.question : null,
    summaryHint: typeof params?.summaryHint === 'string' ? params.summaryHint : null,
  });

  if (!hint.query) {
    return emptyCurrentVideoRelatedFavoritesResponse(context, now);
  }

  const requestedLimit = Number(params?.limit);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(Math.floor(requestedLimit), 8))
    : 5;
  const favorites = await answerSmartFavoriteQuestion(hint.query, limit);

  return {
    status: 'ready',
    contextTitle: context.title,
    query: hint.query,
    hintSourceLabels: hint.sourceLabels,
    favorites,
    generatedAt: now,
    limitations: hint.limitations,
  };
}

async function getCurrentVideoSubtitleViewSources(
  params: Record<string, unknown> | undefined,
  requestTabId: number | null,
): Promise<CurrentVideoSubtitleViewSourcesResult> {
  const lookup = await getCurrentVideoSubtitleViewLookup(params, requestTabId);
  return await buildCurrentVideoSubtitleViewSourcesForLookup(lookup);
}

async function requestCurrentVideoSubtitleJump(
  params: Record<string, unknown> | undefined,
  requestTabId: number | null,
): Promise<CurrentVideoTimestampJumpResponse> {
  const lineId = requireStringParam(params?.lineId, 'lineId');
  const lineBindingKey = requireStringParam(params?.lineBindingKey, 'lineBindingKey');
  const sourceIdentityKey = requireStringParam(params?.sourceIdentityKey, 'sourceIdentityKey');
  const confirmed = params?.confirmed === true;
  if (!confirmed) {
    return blockedTimestampJumpResponse(
      lineId,
      'confirmation_required',
      formatTimestampJumpFailureReason('confirmation_required'),
    );
  }

  const lookup = await getCurrentVideoSubtitleViewLookup(params, requestTabId);
  const tabId = lookup.tab?.id ?? 0;
  if (!lookup.tab?.url || tabId <= 0 || !isBilibiliVideoUrl(lookup.tab.url) || lookup.context.kind !== 'video') {
    return blockedTimestampJumpResponse(
      lineId,
      'no_context',
      formatTimestampJumpFailureReason('no_context'),
    );
  }
  const context = lookup.context;
  const contextCid = context.cid;
  if (!contextCid) {
    return blockedTimestampJumpResponse(
      lineId,
      'no_context',
      formatTimestampJumpFailureReason('no_context'),
    );
  }

  const source = await getCurrentVideoSubtitleViewingSourceByIdentity(lookup, sourceIdentityKey);
  const line = source?.lines.find(item =>
    item.lineId === lineId
    && item.lineBindingKey === lineBindingKey
    && subtitleLineMatchesCurrentContext(item, context),
  ) ?? null;
  if (!source || !line) {
    return blockedTimestampJumpResponse(
      lineId,
      'candidate_not_found',
      '当前字幕来源或字幕行已变化，请重新打开预览后再跳转。',
    );
  }

  const preview = buildCurrentVideoSubtitleJumpPreview(source, line);
  if (!preview.canJump || preview.targetSeconds === null || preview.targetTimeLabel === null) {
    return blockedTimestampJumpResponse(
      lineId,
      'invalid_timestamp',
      preview.message,
    );
  }

  const transcriptClear = getCurrentVideoTranscriptClearState();
  if (transcriptClear.clearing || !canUseCurrentVideoTranscriptClearGeneration(transcriptClear.generation)) {
    return blockedTimestampJumpResponse(
      lineId,
      'stale_context',
      '字幕缓存正在更新，请稍后重新打开预览。',
    );
  }
  const selection = getCurrentVideoPrimaryTextSelectionMutationState();
  const operationLeaseId = issueCurrentVideoTimestampOperationLease({
    tabId,
    operationKind: 'jump',
    authorizationKind: 'subtitle_view',
    bvid: context.bvid,
    cid: contextCid,
    page: context.currentPart.page,
    sourceIdentityKey: source.identity.sourceIdentityKey,
    selectionGeneration: selection.generation,
    transcriptClearGeneration: transcriptClear.generation,
  });

  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      action: 'CURRENT_VIDEO_TIMESTAMP_JUMP',
      payload: {
        candidateId: line.lineId,
        confirmed: true,
        contextBvid: context.bvid,
        contextCid,
        contextPage: context.currentPart.page,
        contextUrl: context.url,
        contextCollectedAt: context.collectedAt,
        targetSeconds: preview.targetSeconds,
        targetTimeLabel: preview.targetTimeLabel,
        sourceLabel: source.sourceLabel,
        confidence: 1,
        confidenceLabel: '高',
        evidencePreview: line.text,
        sourceIdentityKey: source.identity.sourceIdentityKey,
        operationLeaseId,
        returnAuthorizationKind: 'subtitle_view',
      },
    });
    return response as CurrentVideoTimestampJumpResponse;
  } catch {
    return blockedTimestampJumpResponse(
      lineId,
      'player_unavailable',
      formatTimestampJumpFailureReason('player_unavailable'),
    );
  } finally {
    retireCurrentVideoTimestampOperationLease(operationLeaseId);
  }
}

async function returnCurrentVideoSubtitleJump(
  params: Record<string, unknown> | undefined,
  requestTabId: number | null,
): Promise<CurrentVideoTimestampReturnResponse> {
  const sourceIdentityKey = requireStringParam(params?.sourceIdentityKey, 'sourceIdentityKey');
  const lookup = await getCurrentVideoSubtitleViewLookup(params, requestTabId);
  const tabId = lookup.tab?.id ?? 0;
  if (!lookup.tab?.url || tabId <= 0 || !isBilibiliVideoUrl(lookup.tab.url) || lookup.context.kind !== 'video') {
    return blockedTimestampReturnResponse(formatTimestampJumpFailureReason('no_context'));
  }
  if (!lookup.context.cid) {
    return blockedTimestampReturnResponse(formatTimestampJumpFailureReason('no_context'));
  }

  const source = await getCurrentVideoSubtitleViewingSourceByIdentity(lookup, sourceIdentityKey);
  if (!source) {
    return blockedTimestampReturnResponse('当前字幕来源已变化，请重新打开字幕页后再返回。');
  }

  const transcriptClear = getCurrentVideoTranscriptClearState();
  if (transcriptClear.clearing || !canUseCurrentVideoTranscriptClearGeneration(transcriptClear.generation)) {
    return blockedTimestampReturnResponse('字幕缓存正在更新，请稍后重试。');
  }
  const selection = getCurrentVideoPrimaryTextSelectionMutationState();
  const operationLeaseId = issueCurrentVideoTimestampOperationLease({
    tabId,
    operationKind: 'return',
    authorizationKind: 'subtitle_view',
    bvid: lookup.context.bvid,
    cid: lookup.context.cid,
    page: lookup.context.currentPart.page,
    sourceIdentityKey: source.identity.sourceIdentityKey,
    selectionGeneration: selection.generation,
    transcriptClearGeneration: transcriptClear.generation,
  });

  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      action: 'CURRENT_VIDEO_TIMESTAMP_RETURN',
      payload: {
        contextBvid: lookup.context.bvid,
        contextCid: lookup.context.cid,
        contextPage: lookup.context.currentPart.page,
        sourceIdentityKey: source.identity.sourceIdentityKey,
        operationLeaseId,
      },
    });
    return response as CurrentVideoTimestampReturnResponse;
  } catch {
    return blockedTimestampReturnResponse(formatTimestampJumpFailureReason('player_unavailable'));
  } finally {
    retireCurrentVideoTimestampOperationLease(operationLeaseId);
  }
}

async function requestCurrentVideoSegmentJump(
  params: Record<string, unknown> | undefined,
  requestTabId: number | null,
): Promise<CurrentVideoTimestampJumpResponse> {
  const candidateId = requireStringParam(params?.candidateId, 'candidateId');
  const query = requireStringParam(params?.query, 'query');
  const confirmed = params?.confirmed === true;
  if (!confirmed) {
    return blockedTimestampJumpResponse(
      candidateId,
      'confirmation_required',
      formatTimestampJumpFailureReason('confirmation_required'),
    );
  }
  if (!primaryTextSelectionsReady(params)) {
    return blockedTimestampJumpResponse(
      candidateId,
      'no_context',
      PRIMARY_TEXT_SELECTION_NOT_READY_MESSAGE,
    );
  }

  const lookup = await getCurrentVideoContextLookupWithSelection(params, requestTabId);
  if (!lookup.primaryTextAuthorized) {
    return blockedTimestampJumpResponse(
      candidateId,
      'no_context',
      PRIMARY_TEXT_SELECTION_NOT_READY_MESSAGE,
    );
  }
  const tabId = lookup.tab?.id ?? 0;
  if (!lookup.tab?.url || tabId <= 0 || !isBilibiliVideoUrl(lookup.tab.url)) {
    return blockedTimestampJumpResponse(
      candidateId,
      'no_context',
      formatTimestampJumpFailureReason('no_context'),
    );
  }

  const context = lookup.context;
  if (context.kind !== 'video') {
    return blockedTimestampJumpResponse(
      candidateId,
      'no_context',
      formatTimestampJumpFailureReason('no_context'),
    );
  }

  const transcriptSegments = await getAuthorizedCurrentVideoTranscriptSegments(lookup);
  if (!transcriptSegments) {
    return blockedTimestampJumpResponse(
      candidateId,
      'no_context',
      PRIMARY_TEXT_SELECTION_NOT_READY_MESSAGE,
    );
  }
  const videoKnowledge = buildVideoKnowledgeResult(context, { transcriptSegments });
  const result = searchCurrentVideoSegments(context, {
    query,
    transcriptSegments,
    videoKnowledge,
  });
  const candidate = result.candidates.find(item => item.id === candidateId);
  if (!candidate) {
    const reason = result.status === 'stale_context'
      ? 'stale_context'
      : result.status === 'no_context'
        ? 'no_context'
        : 'candidate_not_found';
    return blockedTimestampJumpResponse(
      candidateId,
      reason,
      formatTimestampJumpFailureReason(reason),
    );
  }

  const preview = candidate.jumpPreview;
  if (!preview.canJump || preview.targetSeconds === null || preview.targetTimeLabel === null) {
    const reason = preview.disabledReason ?? 'invalid_timestamp';
    return blockedTimestampJumpResponse(candidateId, reason, preview.message);
  }

  await currentVideoPrimaryTextGuardTestHook('before_timestamp_message');
  if (!await currentVideoPrimaryTextGuardStillAuthorized(lookup)) {
    return blockedTimestampJumpResponse(
      candidateId,
      'no_context',
      PRIMARY_TEXT_SELECTION_NOT_READY_MESSAGE,
    );
  }
  const operationGuard = lookup.primaryTextGuard;
  if (!operationGuard) {
    return blockedTimestampJumpResponse(
      candidateId,
      'no_context',
      PRIMARY_TEXT_SELECTION_NOT_READY_MESSAGE,
    );
  }
  const operationLeaseId = issueCurrentVideoTimestampOperationLease({
    tabId,
    operationKind: 'jump',
    bvid: operationGuard.bvid,
    cid: operationGuard.cid,
    page: operationGuard.page,
    sourceIdentityKey: operationGuard.sourceIdentityKey,
    selectionGeneration: operationGuard.selectionGeneration,
    transcriptClearGeneration: operationGuard.transcriptClearGeneration,
  });

  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      action: 'CURRENT_VIDEO_TIMESTAMP_JUMP',
      payload: {
        candidateId,
        confirmed: true,
        contextBvid: context.bvid,
        contextCid: context.cid,
        contextPage: context.currentPart.page,
        contextUrl: context.url,
        contextCollectedAt: context.collectedAt,
        targetSeconds: preview.targetSeconds,
        targetTimeLabel: preview.targetTimeLabel,
        sourceLabel: preview.sourceLabel,
        confidence: preview.confidence,
        confidenceLabel: preview.confidenceLabel,
        evidencePreview: preview.evidencePreview,
        sourceIdentityKey: operationGuard.sourceIdentityKey,
        operationLeaseId,
        returnAuthorizationKind: 'primary_text',
      },
    });
    return response as CurrentVideoTimestampJumpResponse;
  } catch {
    return blockedTimestampJumpResponse(
      candidateId,
      'player_unavailable',
      formatTimestampJumpFailureReason('player_unavailable'),
    );
  } finally {
    retireCurrentVideoTimestampOperationLease(operationLeaseId);
  }
}

async function requestCurrentVideoHighlightJump(
  params: Record<string, unknown> | undefined,
  requestTabId: number | null,
): Promise<CurrentVideoTimestampJumpResponse> {
  const highlightId = requireStringParam(params?.highlightId ?? params?.candidateId, 'highlightId');
  const model = requireStringParam(params?.model, 'model');
  const cacheKey = requireStringParam(params?.cacheKey, 'cacheKey');
  const generationRequestId = requireStringParam(params?.requestId, 'requestId');
  const generatedAt = requirePositiveIntegerParam(params?.generatedAt, 'generatedAt');
  const confirmed = params?.confirmed === true;
  if (!confirmed) {
    return blockedTimestampJumpResponse(
      highlightId,
      'confirmation_required',
      formatTimestampJumpFailureReason('confirmation_required'),
    );
  }
  if (!primaryTextSelectionsReady(params)) {
    return blockedTimestampJumpResponse(
      highlightId,
      'no_context',
      PRIMARY_TEXT_SELECTION_NOT_READY_MESSAGE,
    );
  }

  const lookup = await getCurrentVideoContextLookupWithSelection(params, requestTabId);
  if (!lookup.primaryTextAuthorized || !lookup.primaryTextGuard) {
    return blockedTimestampJumpResponse(
      highlightId,
      'no_context',
      PRIMARY_TEXT_SELECTION_NOT_READY_MESSAGE,
    );
  }
  const tabId = lookup.tab?.id ?? 0;
  if (!lookup.tab?.url || tabId <= 0 || !isBilibiliVideoUrl(lookup.tab.url)) {
    return blockedTimestampJumpResponse(
      highlightId,
      'no_context',
      formatTimestampJumpFailureReason('no_context'),
    );
  }
  const context = lookup.context;
  if (context.kind !== 'video') {
    return blockedTimestampJumpResponse(
      highlightId,
      'no_context',
      formatTimestampJumpFailureReason('no_context'),
    );
  }

  const operationGuard = lookup.primaryTextGuard;
  const expectedCacheKey = buildCurrentVideoSummaryHighlightsCacheKey({
    identity: { sourceIdentityKey: operationGuard.sourceIdentityKey },
    model,
  });
  const record = await getCurrentVideoSummaryHighlightsCache({
    identity: { sourceIdentityKey: operationGuard.sourceIdentityKey },
    model,
  });
  const binding = {
    highlightId,
    cacheKey,
    generatedAt,
    requestId: generationRequestId,
    model,
  };
  if (
    !record
    || record.cacheKey !== expectedCacheKey
    || !currentVideoSummaryHighlightBindingMatchesRecord(binding, record)
  ) {
    return blockedTimestampJumpResponse(
      highlightId,
      'candidate_not_found',
      '当前亮点结果已过期，请重新生成后再跳转。',
    );
  }
  const highlight = record.result.highlights.find(item => item.id === highlightId);
  if (!highlight) {
    return blockedTimestampJumpResponse(
      highlightId,
      'candidate_not_found',
      '当前亮点结果已过期，请重新生成后再跳转。',
    );
  }

  await currentVideoPrimaryTextGuardTestHook('before_timestamp_message');
  if (!await currentVideoPrimaryTextGuardStillAuthorized(lookup)) {
    return blockedTimestampJumpResponse(
      highlightId,
      'no_context',
      PRIMARY_TEXT_SELECTION_NOT_READY_MESSAGE,
    );
  }

  const operationLeaseId = issueCurrentVideoTimestampOperationLease({
    tabId,
    operationKind: 'jump',
    bvid: operationGuard.bvid,
    cid: operationGuard.cid,
    page: operationGuard.page,
    sourceIdentityKey: operationGuard.sourceIdentityKey,
    selectionGeneration: operationGuard.selectionGeneration,
    transcriptClearGeneration: operationGuard.transcriptClearGeneration,
  });

  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      action: 'CURRENT_VIDEO_TIMESTAMP_JUMP',
      payload: {
        candidateId: highlightId,
        confirmed: true,
        contextBvid: context.bvid,
        contextCid: context.cid,
        contextPage: context.currentPart.page,
        contextUrl: context.url,
        contextCollectedAt: context.collectedAt,
        targetSeconds: highlight.startSeconds,
        targetTimeLabel: formatTimestampLabel(highlight.startSeconds),
        sourceLabel: '视频亮点',
        confidence: 1,
        confidenceLabel: '高',
        evidencePreview: highlight.description,
        sourceIdentityKey: operationGuard.sourceIdentityKey,
        operationLeaseId,
        returnAuthorizationKind: 'primary_text',
      },
    });
    return response as CurrentVideoTimestampJumpResponse;
  } catch {
    return blockedTimestampJumpResponse(
      highlightId,
      'player_unavailable',
      formatTimestampJumpFailureReason('player_unavailable'),
    );
  } finally {
    retireCurrentVideoTimestampOperationLease(operationLeaseId);
  }
}

async function requestCurrentVideoQaCitationJump(
  params: Record<string, unknown> | undefined,
  requestTabId: number | null,
): Promise<CurrentVideoTimestampJumpResponse> {
  const requestId = requireStringParam(params?.requestId, 'requestId');
  const sessionId = optionalStringParam(params?.sessionId) ?? null;
  const turnId = requireStringParam(params?.turnId, 'turnId');
  const citationId = requireStringParam(params?.citationId ?? params?.candidateId, 'citationId');
  if (params?.confirmed !== true) {
    return blockedTimestampJumpResponse(
      citationId,
      'confirmation_required',
      formatTimestampJumpFailureReason('confirmation_required'),
    );
  }
  if (!primaryTextSelectionsReady(params)) {
    return blockedTimestampJumpResponse(citationId, 'no_context', PRIMARY_TEXT_SELECTION_NOT_READY_MESSAGE);
  }

  const lookup = await getCurrentVideoContextLookupWithSelection(params, requestTabId);
  if (!lookup.primaryTextAuthorized || !lookup.primaryTextGuard) {
    return blockedTimestampJumpResponse(citationId, 'no_context', PRIMARY_TEXT_SELECTION_NOT_READY_MESSAGE);
  }
  const tabId = lookup.tab?.id ?? 0;
  const context = lookup.context;
  if (
    !lookup.tab?.url
    || tabId <= 0
    || !isBilibiliVideoUrl(lookup.tab.url)
    || context.kind !== 'video'
  ) {
    return blockedTimestampJumpResponse(
      citationId,
      'no_context',
      formatTimestampJumpFailureReason('no_context'),
    );
  }

  const operationGuard = lookup.primaryTextGuard;
  const citationLookup = {
    sessionId,
    requestId,
    turnId,
    citationId,
    sourceIdentityKey: operationGuard.sourceIdentityKey,
  };
  let record = getCurrentVideoFullTextQaCitation(citationLookup)
    ?? (sessionId ? await getPersistedCurrentVideoQaCitation({ ...citationLookup, sessionId }) : null);
  if (
    !record
    || record.bvid !== context.bvid
    || record.cid !== context.cid
    || record.page !== context.currentPart.page
  ) {
    return blockedTimestampJumpResponse(
      citationId,
      'candidate_not_found',
      '当前引用已过期，请重新提交问题后再跳转。',
    );
  }

  await currentVideoPrimaryTextGuardTestHook('before_timestamp_message');
  if (!await currentVideoPrimaryTextGuardStillAuthorized(lookup)) {
    return blockedTimestampJumpResponse(citationId, 'no_context', PRIMARY_TEXT_SELECTION_NOT_READY_MESSAGE);
  }
  record = getCurrentVideoFullTextQaCitation(citationLookup)
    ?? (sessionId ? await getPersistedCurrentVideoQaCitation({ ...citationLookup, sessionId }) : null);
  if (
    !record
    || record.bvid !== context.bvid
    || record.cid !== context.cid
    || record.page !== context.currentPart.page
  ) {
    return blockedTimestampJumpResponse(
      citationId,
      'candidate_not_found',
      '当前引用已过期，请重新提交问题后再跳转。',
    );
  }
  const operationLeaseId = issueCurrentVideoTimestampOperationLease({
    tabId,
    operationKind: 'jump',
    bvid: operationGuard.bvid,
    cid: operationGuard.cid,
    page: operationGuard.page,
    sourceIdentityKey: operationGuard.sourceIdentityKey,
    selectionGeneration: operationGuard.selectionGeneration,
    transcriptClearGeneration: operationGuard.transcriptClearGeneration,
  });

  try {
    return await chrome.tabs.sendMessage(tabId, {
      action: 'CURRENT_VIDEO_TIMESTAMP_JUMP',
      payload: {
        candidateId: citationId,
        confirmed: true,
        contextBvid: context.bvid,
        contextCid: context.cid,
        contextPage: context.currentPart.page,
        contextUrl: context.url,
        contextCollectedAt: context.collectedAt,
        targetSeconds: record.citation.startSeconds,
        targetTimeLabel: formatTimestampLabel(record.citation.startSeconds),
        sourceLabel: '引用片段',
        confidence: 1,
        confidenceLabel: '高',
        evidencePreview: record.citation.evidenceText,
        sourceIdentityKey: operationGuard.sourceIdentityKey,
        operationLeaseId,
        returnAuthorizationKind: 'primary_text',
      },
    }) as CurrentVideoTimestampJumpResponse;
  } catch {
    return blockedTimestampJumpResponse(
      citationId,
      'player_unavailable',
      formatTimestampJumpFailureReason('player_unavailable'),
    );
  } finally {
    retireCurrentVideoTimestampOperationLease(operationLeaseId);
  }
}

async function returnCurrentVideoSegmentJump(
  params: Record<string, unknown> | undefined,
  requestTabId: number | null,
): Promise<CurrentVideoTimestampReturnResponse> {
  if (!primaryTextSelectionsReady(params)) {
    return blockedTimestampReturnResponse(PRIMARY_TEXT_SELECTION_NOT_READY_MESSAGE);
  }
  const lookup = await getCurrentVideoContextLookupWithSelection(params, requestTabId);
  if (!lookup.primaryTextAuthorized || !lookup.primaryTextGuard) {
    return blockedTimestampReturnResponse(PRIMARY_TEXT_SELECTION_NOT_READY_MESSAGE);
  }

  const tabId = lookup.tab?.id ?? 0;
  if (!lookup.tab?.url || tabId <= 0 || !isBilibiliVideoUrl(lookup.tab.url)) {
    return blockedTimestampReturnResponse(formatTimestampJumpFailureReason('no_context'));
  }
  if (lookup.context.kind !== 'video') {
    return blockedTimestampReturnResponse(formatTimestampJumpFailureReason('no_context'));
  }
  if (!await currentVideoPrimaryTextGuardStillAuthorized(lookup)) {
    return blockedTimestampReturnResponse(PRIMARY_TEXT_SELECTION_NOT_READY_MESSAGE);
  }
  const operationGuard = lookup.primaryTextGuard;
  const operationLeaseId = issueCurrentVideoTimestampOperationLease({
    tabId,
    operationKind: 'return',
    bvid: operationGuard.bvid,
    cid: operationGuard.cid,
    page: operationGuard.page,
    sourceIdentityKey: operationGuard.sourceIdentityKey,
    selectionGeneration: operationGuard.selectionGeneration,
    transcriptClearGeneration: operationGuard.transcriptClearGeneration,
  });

  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      action: 'CURRENT_VIDEO_TIMESTAMP_RETURN',
      payload: {
        contextBvid: lookup.context.bvid,
        contextCid: lookup.context.cid,
        contextPage: lookup.context.currentPart.page,
        sourceIdentityKey: operationGuard.sourceIdentityKey,
        operationLeaseId,
      },
    });
    return response as CurrentVideoTimestampReturnResponse;
  } catch {
    return blockedTimestampReturnResponse(formatTimestampJumpFailureReason('player_unavailable'));
  } finally {
    retireCurrentVideoTimestampOperationLease(operationLeaseId);
  }
}

async function consumeCurrentVideoTimestampLease(
  params: Record<string, unknown> | undefined,
  requestTabId: number | null,
): Promise<CurrentVideoTimestampOperationLeaseConsumeResult> {
  const operationKind = timestampOperationKind(params?.operationKind);
  const leaseId = optionalNonEmptyString(params?.operationLeaseId);
  const bvid = optionalNonEmptyString(params?.contextBvid);
  const cid = optionalPositiveInteger(params?.contextCid);
  const page = optionalPositiveInteger(params?.contextPage);
  const sourceIdentityKey = optionalNonEmptyString(params?.sourceIdentityKey);
  if (
    !operationKind
    || !leaseId
    || !bvid
    || !cid
    || !page
    || !sourceIdentityKey
    || !requestTabId
    || requestTabId <= 0
  ) {
    return { authorized: false };
  }

  const binding = consumeCurrentVideoTimestampOperationLease({
    leaseId,
    tabId: requestTabId,
    operationKind,
    bvid,
    cid,
    page,
    sourceIdentityKey,
  });
  if (!binding) return { authorized: false };

  if (binding.authorizationKind === 'subtitle_view') {
    return {
      authorized: await currentVideoSubtitleSourceStillAvailable(binding, requestTabId),
    };
  }

  const issuedGuard: CurrentVideoPrimaryTextAuthorizationGuard = {
    bvid: binding.bvid,
    cid: binding.cid,
    page: binding.page,
    sourceIdentityKey: binding.sourceIdentityKey,
    selectionGeneration: binding.selectionGeneration,
    transcriptClearGeneration: binding.transcriptClearGeneration,
  };
  if (!currentVideoPrimaryTextGuardEpochsCurrent(issuedGuard)) {
    return { authorized: false };
  }

  const lookup = await getCurrentVideoContextLookupWithSelection({
    primaryTextSelectionsReady: true,
    selectedSourceIdentityKey: binding.sourceIdentityKey,
  }, requestTabId);
  const currentGuard = lookup.primaryTextGuard;
  if (
    !lookup.primaryTextAuthorized
    || !currentGuard
    || currentGuard.bvid !== binding.bvid
    || currentGuard.cid !== binding.cid
    || currentGuard.page !== binding.page
    || currentGuard.sourceIdentityKey !== binding.sourceIdentityKey
    || !currentVideoPrimaryTextGuardEpochsCurrent(issuedGuard)
  ) {
    return { authorized: false };
  }

  return {
    authorized: await currentVideoPrimaryTextGuardStillAuthorized(lookup)
      && currentVideoPrimaryTextGuardEpochsCurrent(issuedGuard),
  };
}

async function markConsumedFromPlayerEvent(
  payload: PlayerHeartbeatPayload | PlayerActionPayload,
): Promise<void> {
  if (!payload.bvid || !isEffectivePlayerWatch(payload)) return;
  await runDynamicBillDataOperation(
    () => markDynamicBillItemsConsumedByBvid(payload.bvid, Date.now()),
  );
}

async function getCurrentVideoContextForActiveTab(
  options: CurrentVideoLookupOptions = {},
  requestTabId: number | null = null,
): Promise<CurrentVideoContextResult> {
  return (await getCurrentVideoContextLookup(options, requestTabId)).context;
}

async function getCurrentVideoSubtitleViewLookup(
  params: Record<string, unknown> | undefined,
  requestTabId: number | null = null,
): Promise<CurrentVideoContextLookupResult> {
  const lookup = await getRawCurrentVideoContextLookup(currentVideoLookupOptions(params), requestTabId);
  if (lookup.context.kind !== 'video') return lookup;
  return {
    ...lookup,
    context: await enrichCurrentVideoContextWithTranscriptEvidence(lookup.context, lookup.temporaryOwner),
  };
}

async function buildCurrentVideoSubtitleViewSourcesForLookup(
  lookup: CurrentVideoContextLookupResult,
): Promise<CurrentVideoSubtitleViewSourcesResult> {
  const now = Date.now();
  const context = lookup.context;
  if (context.kind !== 'video') {
    return {
      status: 'no_context',
      message: '当前没有可用的视频页，请在 B 站视频页使用字幕。',
      checkedAt: now,
      contextKey: null,
      title: null,
      partTitle: null,
      durationSeconds: null,
      sources: [],
    };
  }

  const base = {
    checkedAt: now,
    contextKey: currentVideoSubtitleContextKey(context),
    title: context.title,
    partTitle: context.currentPart.title,
    durationSeconds: context.durationSeconds,
  };
  if (!context.cid) {
    return {
      ...base,
      status: 'no_context',
      message: '当前分 P 身份还不完整，暂时不能读取字幕全文。',
      sources: [],
    };
  }

  const evidence = context.transcriptEvidence;
  if (evidence?.active && evidence.sourceIdentityKey && evidence.sourceHash) {
    const transcriptClear = getCurrentVideoTranscriptClearState();
    const segments = await getCurrentVideoTranscriptSegments({
      bvid: context.bvid,
      cid: context.cid,
      page: context.currentPart.page,
      language: evidence.language,
      sourceIdentityKey: evidence.sourceIdentityKey,
      sourceHash: evidence.sourceHash,
    }, lookup.temporaryOwner, {
      canUseEvidence: () =>
        !transcriptClear.clearing
        && canUseCurrentVideoTranscriptClearGeneration(transcriptClear.generation),
    });
    const source = buildBilibiliSubtitleViewingSource({
      bvid: context.bvid,
      cid: context.cid,
      page: context.currentPart.page,
      language: evidence.language,
      sourceType: evidence.sourceType,
      temporary: evidence.temporary === true,
      segments,
    });
    if (source) {
      return {
        ...base,
        status: 'ready',
        message: `已读取 ${source.sourceLabel} ${source.lineCount} 条。`,
        sources: [source],
      };
    }
    return {
      ...base,
      status: 'empty',
      message: '字幕来源存在，但没有可展示的有效字幕行。',
      sources: [],
    };
  }

  const status = subtitleViewingUnavailableStatus(context);
  return {
    ...base,
    ...status,
    sources: [],
  };
}

async function getCurrentVideoSubtitleViewingSourceByIdentity(
  lookup: CurrentVideoContextLookupResult,
  sourceIdentityKey: string,
): Promise<CurrentVideoSubtitleViewingSource | null> {
  const result = await buildCurrentVideoSubtitleViewSourcesForLookup(lookup);
  return result.sources.find(source =>
    source.identity.sourceIdentityKey === sourceIdentityKey
    && source.lineCount > 0,
  ) ?? null;
}

async function currentVideoSubtitleSourceStillAvailable(
  binding: {
    bvid: string;
    cid: number;
    page: number;
    sourceIdentityKey: string;
    transcriptClearGeneration: number;
  },
  requestTabId: number,
): Promise<boolean> {
  if (!canUseCurrentVideoTranscriptClearGeneration(binding.transcriptClearGeneration)) {
    return false;
  }
  const lookup = await getCurrentVideoSubtitleViewLookup(undefined, requestTabId);
  if (
    lookup.context.kind !== 'video'
    || lookup.context.bvid !== binding.bvid
    || lookup.context.cid !== binding.cid
    || lookup.context.currentPart.page !== binding.page
  ) {
    return false;
  }
  const activeKeys = await getCurrentVideoActiveTranscriptSourceIdentityKeys({
    bvid: binding.bvid,
    cid: binding.cid,
    page: binding.page,
  }, lookup.temporaryOwner);
  if (!activeKeys.includes(binding.sourceIdentityKey)) return false;
  return Boolean(await getCurrentVideoSubtitleViewingSourceByIdentity(lookup, binding.sourceIdentityKey));
}

function subtitleViewingUnavailableStatus(
  context: CurrentVideoContext,
): Pick<CurrentVideoSubtitleViewSourcesResult, 'status' | 'message'> {
  const evidence = context.transcriptEvidence;
  if (!evidence) {
    return {
      status: 'detecting',
      message: '正在确认当前视频是否已有可读字幕全文。',
    };
  }
  if (evidence.status === 'empty') {
    return {
      status: 'empty',
      message: '已找到字幕来源，但没有返回可展示的字幕行。',
    };
  }
  if (evidence.status === 'malformed') {
    return {
      status: 'malformed',
      message: '字幕正文结构异常，暂时不能展示或导出。',
    };
  }
  if (evidence.status === 'stale') {
    return {
      status: 'unavailable',
      message: '本地字幕证据与当前视频或分 P 不匹配，请重新检测字幕。',
    };
  }
  if (
    context.subtitleProbe?.available
    || context.sources.transcript === 'available'
    || evidence.status === 'track_unavailable'
    || evidence.status === 'missing'
  ) {
    return {
      status: 'requires_user_subtitle',
      message: 'B站字幕需要先在播放器里手动开启中文 AI 字幕；已完成的本地字幕稿只有存在时才会显示。',
    };
  }
  if (evidence.status === 'login_required') {
    return {
      status: 'unavailable',
      message: '字幕需要当前浏览器会话具备访问权限；Bili-Bill 不会读取本地敏感文件。',
    };
  }
  return {
    status: 'unavailable',
    message: '当前没有可展示的字幕全文。',
  };
}

function subtitleLineMatchesCurrentContext(
  line: CurrentVideoSubtitleLine,
  context: CurrentVideoContext,
): boolean {
  return Boolean(
    context.cid
    && line.bvid === context.bvid
    && line.cid === context.cid
    && line.page === context.currentPart.page,
  );
}

async function getCurrentVideoContextForActiveTabWithSelection(
  params: Record<string, unknown> | undefined,
  requestTabId: number | null = null,
): Promise<CurrentVideoContextResult> {
  return (await getCurrentVideoContextLookupWithSelection(params, requestTabId)).context;
}

async function getCurrentVideoContextLookupWithSelection(
  params: Record<string, unknown> | undefined,
  requestTabId: number | null = null,
): Promise<CurrentVideoContextLookupResult> {
  const options = currentVideoLookupOptions(params);
  const requestedSourceIdentityKey = selectedSourceIdentityKey(params);
  const epochs = currentVideoPrimaryTextAuthorizationEpochs();
  if (!currentVideoPrimaryTextAuthorizationEpochsReady(epochs)) {
    const lookup = await getRawCurrentVideoContextLookup(options, requestTabId);
    return {
      ...lookup,
      context: lookup.context.kind === 'video'
        ? withoutSelectedCurrentVideoTranscriptEvidence(lookup.context)
        : lookup.context,
      primaryTextAuthorized: false,
    };
  }
  const lookup = await getRawCurrentVideoContextLookup(options, requestTabId);
  if (lookup.context.kind !== 'video') {
    return {
      ...lookup,
      primaryTextAuthorized: false,
    };
  }
  if (!currentVideoPrimaryTextAuthorizationEpochsCurrent(epochs)) {
    return {
      ...lookup,
      context: withoutSelectedCurrentVideoTranscriptEvidence(lookup.context),
      primaryTextAuthorized: false,
    };
  }
  const readResult = await readCurrentVideoPrimaryTextSelections(chrome.storage.local);
  if (readResult.status !== 'ready' || !currentVideoPrimaryTextAuthorizationEpochsCurrent(epochs)) {
    return {
      ...lookup,
      context: withoutSelectedCurrentVideoTranscriptEvidence(lookup.context),
      primaryTextAuthorized: false,
    };
  }

  await currentVideoPrimaryTextGuardTestHook('before_active_source_check');
  const availableSourceIdentityKeys = lookup.context.cid
    ? getCurrentVideoCurrentOwnerTranscriptSourceIdentityKeys({
        bvid: lookup.context.bvid,
        cid: lookup.context.cid,
        page: lookup.context.currentPart.page,
      }, lookup.temporaryOwner)
    : [];
  if (!currentVideoPrimaryTextAuthorizationEpochsCurrent(epochs)) {
    return {
      ...lookup,
      context: withoutSelectedCurrentVideoTranscriptEvidence(lookup.context),
      primaryTextAuthorized: false,
    };
  }
  const authorization = resolveCurrentVideoPrimaryTextAuthorization({
    readStatus: 'ready',
    identity: {
      bvid: lookup.context.bvid,
      cid: lookup.context.cid,
      page: lookup.context.currentPart.page,
    },
    selections: readResult.selections,
    availableSourceIdentityKeys,
  });
  if (
    !requestedSourceIdentityKey
    || !authorization.ready
    || authorization.selectedSourceIdentityKey !== requestedSourceIdentityKey
  ) {
    return {
      ...lookup,
      context: withoutSelectedCurrentVideoTranscriptEvidence(lookup.context),
      primaryTextAuthorized: false,
    };
  }

  const guard: CurrentVideoPrimaryTextAuthorizationGuard = {
    bvid: lookup.context.bvid,
    cid: lookup.context.cid as number,
    page: lookup.context.currentPart.page,
    sourceIdentityKey: requestedSourceIdentityKey,
    selectionGeneration: epochs.selectionGeneration,
    transcriptClearGeneration: epochs.transcriptClearGeneration,
  };
  if (!currentVideoPrimaryTextGuardEpochsCurrent(guard)) {
    return {
      ...lookup,
      context: withoutSelectedCurrentVideoTranscriptEvidence(lookup.context),
      primaryTextAuthorized: false,
    };
  }
  const withSubtitle = await enrichCurrentVideoContextWithSubtitleProbe(lookup.context, options);
  if (!currentVideoPrimaryTextGuardEpochsCurrent(guard)) {
    return {
      ...lookup,
      context: withoutSelectedCurrentVideoTranscriptEvidence(withSubtitle),
      primaryTextAuthorized: false,
    };
  }
  await currentVideoPrimaryTextGuardTestHook('before_evidence_bind');
  if (!currentVideoPrimaryTextGuardEpochsCurrent(guard)) {
    return {
      ...lookup,
      context: withoutSelectedCurrentVideoTranscriptEvidence(withSubtitle),
      primaryTextAuthorized: false,
    };
  }
  const withEvidence = await bindSelectedCurrentVideoTranscriptEvidence(
    withSubtitle,
    requestedSourceIdentityKey,
    lookup.temporaryOwner,
    guard,
  );
  const authorizedLookup = {
    ...lookup,
    context: withEvidence,
    primaryTextAuthorized: true,
    primaryTextGuard: guard,
  };
  if (!await currentVideoPrimaryTextGuardStillAuthorized(authorizedLookup)) {
    return {
      ...lookup,
      context: withoutSelectedCurrentVideoTranscriptEvidence(withSubtitle),
      primaryTextAuthorized: false,
    };
  }
  return {
    ...authorizedLookup,
    primaryTextAuthorized: true,
  };
}

async function resolveLearningSource(tabId: number, request: LearningSourceRequest) {
  const lookup = await getCurrentVideoContextLookupWithSelection({ selectedSourceIdentityKey: request.sourceIdentityKey }, tabId);
  const context = lookup.context;
  learningAssert(context.kind === 'video' && context.cid && lookup.primaryTextAuthorized && context.transcriptEvidence?.sourceHash, 'stale_capture');
  const segments = await getAuthorizedCurrentVideoTranscriptSegments(lookup);
  learningAssert(segments && segments.length > 0 && segments.every(segment => segment.source === 'bilibili_subtitle' && segment.bvid === context.bvid && segment.cid === context.cid && segment.page === context.currentPart.page), 'stale_capture');
  let result: CurrentVideoSummaryHighlightsResult | CurrentVideoQaSessionTurn | undefined;
  if (request.origin === 'summary' || request.origin === 'highlights') {
    result = await readCachedCurrentVideoSummaryHighlights(context);
  } else if (request.origin === 'answer') {
    learningAssert(typeof request.sessionId === 'string' && request.sessionId.length <= 256, 'stale_capture');
    const session = await getCurrentVideoQaSessionForSubmit(request.sessionId);
    result = session?.turns.find(turn => turn.turnId === request.turnId && turn.requestId === request.requestId);
    learningAssert(result && result.source?.bvid === context.bvid && result.source.cid === context.cid && result.source.page === context.currentPart.page, 'stale_capture');
  }
  let resolvedRequest = request;
  if (request.origin === 'subtitle' && request.subtitleSelection) {
    const view = buildBilibiliSubtitleViewingSource({ bvid: context.bvid, cid: context.cid, page: context.currentPart.page, language: context.transcriptEvidence.language, sourceType: context.transcriptEvidence.sourceType, segments });
    learningAssert(view, 'stale_capture');
    const snapshot = resolveLearningSelection(request, view);
    snapshot.source.hash = context.transcriptEvidence.sourceHash;
    learningAssert(await currentVideoPrimaryTextGuardStillAuthorized(lookup), 'stale_capture');
    return { snapshot, bvid: context.bvid, cid: String(context.cid), page: context.currentPart.page };
  }
  if (request.origin === 'subtitle' && request.subtitleLine) {
    const view = buildBilibiliSubtitleViewingSource({ bvid: context.bvid, cid: context.cid, page: context.currentPart.page, language: context.transcriptEvidence.language, sourceType: context.transcriptEvidence.sourceType, segments });
    const line = view?.lines.find(item => item.lineId === request.subtitleLine?.id && item.lineBindingKey === request.subtitleLine.binding);
    learningAssert(line && view?.identity.sourceIdentityKey === request.sourceIdentityKey, 'stale_capture');
    const matches = segments.filter(segment => Math.round(segment.startSeconds * 1000) === Math.round(line.startSeconds * 1000)
      && Math.round(segment.endSeconds * 1000) === Math.round(line.endSeconds * 1000)
      && segment.text.replace(/\s+/g, ' ').trim() === line.text);
    learningAssert(matches.length === 1, 'stale_capture');
    resolvedRequest = { ...request, segmentIds: [matches[0].segmentId] };
  }
  const snapshot = buildLearningSnapshot(resolvedRequest, { kind: 'bilibili', hash: context.transcriptEvidence.sourceHash }, segments, result);
  learningAssert(await currentVideoPrimaryTextGuardStillAuthorized(lookup), 'stale_capture');
  return { snapshot, bvid: context.bvid, cid: String(context.cid), page: context.currentPart.page };
}

async function getCurrentVideoQaSessionForSubmit(sessionId: string): Promise<CurrentVideoQaSessionRecord | null> {
  const view = await getCurrentVideoQaSessionsView(sessionId);
  return view.activeSession?.sessionId === sessionId ? view.activeSession : null;
}

async function completeAndReturnCurrentVideoQaTurn(
  sessionId: string,
  turnId: string,
  result: CurrentVideoFullTextQaResult,
  writeGuard: CurrentVideoQaSessionWriteGuard,
): Promise<CurrentVideoFullTextQaResult> {
  const saved = await completeCurrentVideoQaTurn(sessionId, turnId, result, Date.now(), writeGuard);
  if (saved) return result;
  return unavailableCurrentVideoFullTextQa({
    status: 'cancelled',
    requestId: result.requestId,
    sessionId,
    turnId,
    question: result.question,
    title: result.title,
    partTitle: result.partTitle,
    sourceReference: result.sourceReference,
    textSize: result.textSize,
    model: result.ai.model,
    message: '会话已更新、删除或清空，本次回答不再写入。',
  });
}

function currentVideoQaSourceSnapshotFromLookup(
  lookup: CurrentVideoContextLookupResult,
  transcriptSegments: CurrentVideoTranscriptSegment[] | null,
): CurrentVideoQaSourceSnapshot | null {
  if (lookup.context.kind !== 'video') return null;
  const context = lookup.context;
  const guard = lookup.primaryTextGuard;
  const evidence = context.transcriptEvidence;
  const charCount = transcriptSegments
    ? transcriptSegments.reduce((sum, segment) => sum + segment.text.length, 0)
    : null;
  const utf8Bytes = transcriptSegments
    ? utf8ByteLength(transcriptSegments.map(segment => segment.text).join('\n'))
    : evidence?.serializedBytes ?? 0;
  return {
    title: context.title?.trim() || '当前视频',
    partTitle: context.currentPart.title?.trim() || null,
    page: guard?.page ?? context.currentPart.page ?? null,
    bvid: guard?.bvid ?? context.bvid ?? null,
    cid: guard?.cid ?? context.cid ?? null,
    url: context.url,
    sourceLabel: evidence?.active || transcriptSegments ? 'B站字幕' : null,
    language: transcriptSegments?.find(segment => segment.language)?.language ?? evidence?.language ?? null,
    sourceIdentityKey: guard?.sourceIdentityKey
      ?? transcriptSegments?.find(segment => segment.sourceIdentityKey)?.sourceIdentityKey
      ?? evidence?.sourceIdentityKey
      ?? null,
    textSize: {
      lineCount: transcriptSegments?.length ?? evidence?.segmentCount ?? 0,
      charCount,
      utf8Bytes,
    },
    capturedAt: Date.now(),
  };
}

function sourceReferenceFromCurrentVideoQaSource(
  source: CurrentVideoQaSourceSnapshot | null,
): CurrentVideoFullTextQaSourceReference | null {
  if (!source) return null;
  return {
    title: source.title,
    partTitle: source.partTitle,
    page: source.page,
    bvid: source.bvid,
    cid: source.cid,
    url: source.url,
    sourceLabel: source.sourceLabel,
    language: source.language,
    sourceIdentityKey: source.sourceIdentityKey,
    textSize: source.textSize,
    capturedAt: source.capturedAt,
  };
}

function utf8ByteLength(value: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).byteLength;
  return value.length;
}

function withoutSelectedCurrentVideoTranscriptEvidence(
  context: CurrentVideoContext,
): CurrentVideoContext {
  return withTranscriptEvidenceState(
    {
      ...context,
      warnings: context.warnings.filter(warning => warning !== 'transcript_evidence_cached'),
    },
    buildCurrentVideoTranscriptEvidenceState({
      status: 'missing',
      target: {
        bvid: context.bvid,
        cid: context.cid,
        page: context.currentPart.page,
      },
      now: Date.now(),
      sourceType: context.subtitleProbe?.sourceType ?? 'none',
      reason: 'primary_text_source_identity_required',
      message: '当前请求没有绑定精确的主要文本来源，因此不会读取字幕正文。',
      warnings: ['primary_text_source_identity_required'],
    }),
  );
}

async function getCurrentVideoContextLookup(
  options: CurrentVideoLookupOptions = {},
  requestTabId: number | null = null,
): Promise<CurrentVideoContextLookupResult> {
  const lookup = await getRawCurrentVideoContextLookup(options, requestTabId);
  if (lookup.context.kind !== 'video') return lookup;
  const withSubtitle = await enrichCurrentVideoContextWithSubtitleProbe(lookup.context, options);
  return {
    ...lookup,
    context: await enrichCurrentVideoContextWithTranscriptEvidence(withSubtitle, lookup.temporaryOwner),
  };
}

async function getRawCurrentVideoContextLookup(
  options: CurrentVideoLookupOptions = {},
  requestTabId: number | null = null,
): Promise<CurrentVideoContextLookupResult> {
  const { tab, context } = await resolveCurrentVideoLookupState(requestTabId);
  const url = tab?.url ?? null;
  let resolvedContext: CurrentVideoContextResult;

  if (!url || !isBilibiliVideoUrl(url)) {
    resolvedContext = buildNoContext(url, 'non_video_page', 'non_video');
  } else if (tab?.id && (options.forceContextRefresh || context?.kind !== 'video')) {
    const refreshed = await requestFreshCurrentVideoContext(tab.id, url);
    resolvedContext = refreshed ?? buildNoContext(url, 'video_context_unavailable', 'video');
  } else if (context?.kind === 'video') {
    resolvedContext = context;
  } else {
    resolvedContext = buildNoContext(url, 'video_context_unavailable', 'video');
  }

  return {
    tab,
    context: resolvedContext,
    temporaryOwner: retainTemporaryTranscriptOwnerForContextSnapshot(resolvedContext, tab?.id ?? null),
  };
}

async function probeSubtitleSourceForActiveTab(
  params: Record<string, unknown> | undefined,
  requestTabId: number | null = null,
): Promise<CurrentVideoSubtitleSourceState> {
  const options = currentVideoLookupOptions({
    ...params,
    forceSubtitleProbe: params?.force === true || params?.forceSubtitleProbe === true,
    forceContextRefresh: params?.force === true || params?.forceContextRefresh === true,
  });
  const context = await getCurrentVideoContextForActiveTab(options, requestTabId);
  if (context.kind === 'video' && context.subtitleProbe) {
    return context.subtitleProbe;
  }
  return await probeCurrentVideoSubtitleSource(context);
}

async function getTranscriptEvidenceForActiveTab(
  params: Record<string, unknown> | undefined,
  requestTabId: number | null = null,
): Promise<CurrentVideoTranscriptEvidenceState> {
  const lookup = await getRawCurrentVideoContextLookup(currentVideoLookupOptions(params), requestTabId);
  const requestedLanguage = typeof params?.language === 'string'
    ? params.language
    : null;
  return await cacheCurrentVideoTranscriptEvidence(lookup.context, {
    requestedLanguage,
    protectedSourceIdentityKeys: currentVideoProtectedSourceIdentityKeys(lookup.context, params),
    temporaryOwner: lookup.temporaryOwner,
  });
}

async function bindSelectedCurrentVideoTranscriptEvidence(
  context: CurrentVideoContextResult,
  sourceIdentityKey: string | null,
  temporaryOwner?: CurrentVideoTemporaryTranscriptOwner,
  guard?: CurrentVideoPrimaryTextAuthorizationGuard,
): Promise<CurrentVideoContextResult> {
  if (context.kind !== 'video' || !sourceIdentityKey || !context.cid) return context;
  const transcriptEvidence = await getCurrentVideoTranscriptEvidenceState({
    bvid: context.bvid,
    cid: context.cid,
    page: context.currentPart.page,
    sourceIdentityKey,
  }, Date.now(), temporaryOwner, {
    canUseEvidence: guard ? () => currentVideoPrimaryTextGuardEpochsCurrent(guard) : undefined,
  });
  return withTranscriptEvidenceState(context, transcriptEvidence);
}

async function enrichCurrentVideoContextWithSubtitleProbe(
  context: CurrentVideoContext,
  options: CurrentVideoLookupOptions = {},
): Promise<CurrentVideoContext> {
  const cacheKey = subtitleProbeCacheKey(context);
  if (options.forceSubtitleProbe) {
    currentVideoSubtitleProbes.delete(cacheKey);
  }

  const existing = context.subtitleProbe;
  if (!options.forceSubtitleProbe && existing && Date.now() - existing.checkedAt < SUBTITLE_PROBE_CACHE_MS) {
    return withSubtitleSourceState(context, existing);
  }

  const cached = currentVideoSubtitleProbes.get(cacheKey);
  if (!options.forceSubtitleProbe && cached && Date.now() - cached.checkedAt < SUBTITLE_PROBE_CACHE_MS) {
    return withSubtitleSourceState(context, cached);
  }

  const existingRequest = currentVideoSubtitleProbeRequests.get(cacheKey);
  if (!options.forceSubtitleProbe && existingRequest) {
    const probe = await existingRequest;
    return withSubtitleSourceState(context, probe);
  }

  const request = probeCurrentVideoSubtitleSource(context).finally(() => {
    currentVideoSubtitleProbeRequests.delete(cacheKey);
  });
  currentVideoSubtitleProbeRequests.set(cacheKey, request);
  const probe = await request;
  currentVideoSubtitleProbes.set(cacheKey, probe);
  return withSubtitleSourceState(context, probe);
}

async function enrichCurrentVideoContextWithTranscriptEvidence(
  context: CurrentVideoContext,
  temporaryOwner?: CurrentVideoTemporaryTranscriptOwner,
): Promise<CurrentVideoContext> {
  if (!context.cid) {
    return withTranscriptEvidenceState(context, buildCurrentVideoTranscriptEvidenceState({
      status: 'unsupported',
      target: {
        bvid: context.bvid,
        cid: context.cid,
        page: context.currentPart.page,
      },
      now: Date.now(),
      reason: 'missing_cid',
      message: '当前视频分 P 身份信息不完整，无法读取本地字幕正文证据状态。',
      warnings: ['cid_unknown'],
    }));
  }

  const identity = {
    bvid: context.bvid,
    cid: context.cid,
    page: context.currentPart.page,
  };
  const now = Date.now();
  const state = temporaryOwner
    && !getTemporaryCurrentVideoTranscriptOwnerReadResolution(temporaryOwner, identity, now)
    ? buildTemporaryCurrentVideoTranscriptUnavailableState(identity, now)
    : await getCurrentVideoTranscriptEvidenceState(identity, now, temporaryOwner);
  return withTranscriptEvidenceState(context, state);
}

async function getAuthorizedCurrentVideoTranscriptSegments(
  lookup: CurrentVideoContextLookupResult,
) {
  const context = lookup.context;
  const guard = lookup.primaryTextGuard;
  if (
    !guard
    || context.kind !== 'video'
    || !context.cid
    || context.transcriptEvidence?.active !== true
    || context.transcriptEvidence.sourceIdentityKey !== guard.sourceIdentityKey
  ) {
    return null;
  }
  if (!await currentVideoPrimaryTextGuardStillAuthorized(lookup)) {
    return null;
  }

  await currentVideoPrimaryTextGuardTestHook('before_segment_body_read');
  if (!currentVideoPrimaryTextGuardEpochsCurrent(guard)) {
    return null;
  }
  const segments = await getCurrentVideoTranscriptSegments({
    bvid: context.bvid,
    cid: context.cid,
    page: context.currentPart.page,
    language: context.transcriptEvidence.language,
    sourceIdentityKey: context.transcriptEvidence.sourceIdentityKey,
    sourceHash: context.transcriptEvidence.sourceHash,
  }, lookup.temporaryOwner, {
    canUseEvidence: () => currentVideoPrimaryTextGuardEpochsCurrent(guard),
  });
  await currentVideoPrimaryTextGuardTestHook('after_segment_body_read');
  if (segments.length <= 0 || !currentVideoPrimaryTextGuardEpochsCurrent(guard)) {
    return null;
  }
  if (!await currentVideoPrimaryTextGuardStillAuthorized(lookup)) {
    return null;
  }
  return segments;
}

function subtitleProbeCacheKey(context: CurrentVideoContext): string {
  return [
    context.bvid,
    context.cid ?? 'cid-unknown',
    context.currentPart.page,
  ].join(':');
}

async function requestFreshCurrentVideoContext(
  tabId: number,
  tabUrl: string,
): Promise<CurrentVideoContextResult | null> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      action: 'COLLECT_CURRENT_VIDEO_CONTEXT',
      payload: {},
    }) as CurrentVideoContextResult;
    if (response?.kind !== 'video') return response ?? null;
    if (!canAcceptCurrentVideoContextUpdate(response, tabUrl)) return null;
    currentVideoContexts.set(tabId, response);
    if (response.cid) {
      retainTemporaryCurrentVideoTranscriptOwner({
        ownerTabId: tabId,
        bvid: response.bvid,
        cid: response.cid,
        page: response.currentPart.page,
      });
    }
    return response;
  } catch {
    return null;
  }
}

function currentVideoLookupOptions(
  params: Record<string, unknown> | undefined,
): CurrentVideoLookupOptions {
  return {
    forceContextRefresh: params?.forceContextRefresh === true,
    forceSubtitleProbe: params?.forceSubtitleProbe === true,
  };
}

function primaryTextSelectionsReady(params: Record<string, unknown> | undefined): boolean {
  return params?.primaryTextSelectionsReady === true;
}

function primaryTextSelectionNotReadySummaryHighlights(now = Date.now()): CurrentVideoSummaryHighlightsResult {
  return {
    status: 'cancelled',
    title: '主要文本来源尚未就绪',
    message: PRIMARY_TEXT_SELECTION_NOT_READY_MESSAGE,
    sourceLabel: null,
    textSize: { lineCount: 0, charCount: null, utf8Bytes: 0 },
    summarySentences: [],
    keyPoints: [],
    highlights: [],
    limitations: ['读取完成前不会读取当前正文，也不会请求 AI。'],
    ai: {
      status: 'not_requested',
      model: null,
      error: null,
      note: '主要文本来源选择尚未读取完成，因此没有请求 AI。',
    },
    generatedAt: now,
    model: null,
    cacheKey: null,
    cacheHit: false,
    current: true,
    requestId: null,
    canGenerate: false,
    priorGenerated: false,
    generationBlockedMessage: PRIMARY_TEXT_SELECTION_NOT_READY_MESSAGE,
  };
}

function primaryTextSelectionNotReadyKnowledge(now = Date.now()): VideoKnowledgeResult {
  return {
    status: 'ready',
    title: '当前视频',
    generatedAt: now,
    sourceState: {
      metadata: false,
      description: false,
      pages: false,
      chapters: false,
      transcript: false,
      transcriptEvidence: false,
      contentText: false,
    },
    transcriptEvidence: null,
    nodes: [],
    warnings: ['primary_text_selection_not_ready'],
    limitations: [
      PRIMARY_TEXT_SELECTION_NOT_READY_MESSAGE,
      '读取完成前不会把当前可见字幕正文当作主要文本来源。',
    ],
  };
}

async function resolveCurrentVideoSummaryHighlightCommitIdentity(
  params: Record<string, unknown> | undefined,
  requestTabId: number | null,
): Promise<{ sourceIdentityKey: string } | null> {
  const config = await loadConfig();
  if (!config.assistant.currentVideoAiAssistantEnabled) return null;
  const lookup = await getCurrentVideoContextLookupWithSelection(params, requestTabId);
  if (lookup.primaryTextAuthorized && lookup.primaryTextGuard) {
    return { sourceIdentityKey: lookup.primaryTextGuard.sourceIdentityKey };
  }
  return null;
}

function formatTimestampLabel(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function primaryTextSelectionNotReadySegmentResult(
  query: string,
  now = Date.now(),
): CurrentVideoSegmentRetrievalResult {
  const normalizedQuery = String(query ?? '').trim();
  const queryRewrite = rewriteCurrentVideoSegmentQuery(normalizedQuery);
  return {
    status: 'no_evidence',
    query: normalizedQuery,
    normalizedQuery: queryRewrite.normalizedQuery,
    title: '当前视频',
    generatedAt: now,
    candidates: [],
    summary: PRIMARY_TEXT_SELECTION_NOT_READY_MESSAGE,
    limitations: [
      '主要文本来源选择读取完成前不会检索当前可见字幕正文。',
      '本次没有请求 AI，也没有读取历史、收藏、关注或本地敏感文件。',
    ],
    queryRewrite,
    evidenceState: {
      transcriptSegmentCount: 0,
      timedKnowledgeNodeCount: 0,
      metadataHintAvailable: false,
      contextFresh: false,
    },
    aiRerank: {
      status: 'not_requested',
      model: null,
      note: '主要文本来源选择尚未读取完成，因此没有请求 AI 重排。',
      error: null,
      generatedAt: now,
      payloadCandidateCount: 0,
      appliedCandidateIds: [],
      explanations: [],
    },
    qa: {
      status: 'insufficient_evidence',
      answer: PRIMARY_TEXT_SELECTION_NOT_READY_MESSAGE,
      confidence: 0,
      confidenceLabel: '低',
      citedSegments: [],
      sourceState: {
        transcriptSegmentCount: 0,
        timedKnowledgeNodeCount: 0,
        metadataHintAvailable: false,
        contextFresh: false,
        hasCitableEvidence: false,
        hasOnlyMetadataHints: false,
      },
      aiState: {
        status: 'not_requested',
        model: null,
        note: '主要文本来源选择尚未读取完成，因此没有请求 AI 整理回答。',
        error: null,
        generatedAt: now,
        payloadCandidateCount: 0,
        citedCandidateIds: [],
      },
      limitations: ['请等本页保存的主要文本来源选择读取完成后再提问。'],
    },
  };
}

function currentVideoProtectedSourceIdentityKeys(
  context: CurrentVideoContextResult,
  params: Record<string, unknown> | undefined,
): string[] {
  const keys = new Set<string>();
  const addKey = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) {
      keys.add(value.trim());
    }
  };

  if (context.kind === 'video') {
    addKey(context.transcriptEvidence?.sourceIdentityKey);
  }
  addKey(params?.sourceIdentityKey);
  addKey(params?.selectedSourceIdentityKey);

  if (Array.isArray(params?.protectedSourceIdentityKeys)) {
    for (const key of params.protectedSourceIdentityKeys) {
      addKey(key);
    }
  }

  return Array.from(keys);
}

function selectedSourceIdentityKey(params: Record<string, unknown> | undefined): string | null {
  const value = params?.selectedSourceIdentityKey ?? params?.sourceIdentityKey;
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : null;
}

function currentVideoPrimaryTextAuthorizationEpochs(): CurrentVideoPrimaryTextAuthorizationEpochs {
  const selection = getCurrentVideoPrimaryTextSelectionMutationState();
  const transcriptClear = getCurrentVideoTranscriptClearState();
  return {
    selectionGeneration: selection.generation,
    selectionMutating: selection.mutating,
    transcriptClearGeneration: transcriptClear.generation,
    transcriptClearing: transcriptClear.clearing,
  };
}

function currentVideoPrimaryTextAuthorizationEpochsReady(
  epochs: CurrentVideoPrimaryTextAuthorizationEpochs,
): boolean {
  return !epochs.selectionMutating
    && !epochs.transcriptClearing;
}

function currentVideoPrimaryTextAuthorizationEpochsCurrent(
  epochs: CurrentVideoPrimaryTextAuthorizationEpochs,
): boolean {
  return canUseCurrentVideoPrimaryTextSelectionGeneration(epochs.selectionGeneration)
    && canUseCurrentVideoTranscriptClearGeneration(epochs.transcriptClearGeneration);
}

function currentVideoPrimaryTextGuardEpochsCurrent(
  guard: CurrentVideoPrimaryTextAuthorizationGuard,
): boolean {
  return canUseCurrentVideoPrimaryTextSelectionGeneration(guard.selectionGeneration)
    && canUseCurrentVideoTranscriptClearGeneration(guard.transcriptClearGeneration);
}

function currentVideoSummaryHighlightsSourceDataStillCurrent(
  lookup: Pick<CurrentVideoContextLookupResult, 'primaryTextGuard'>,
): boolean {
  const guard = lookup.primaryTextGuard;
  return Boolean(guard && canUseCurrentVideoTranscriptClearGeneration(guard.transcriptClearGeneration));
}

function currentVideoSummaryHighlightsConfigChanged(
  previousConfig: UserConfig,
  nextConfig: UserConfig,
): boolean {
  return previousConfig.assistant.currentVideoAiAssistantEnabled
    !== nextConfig.assistant.currentVideoAiAssistantEnabled
    || previousConfig.ai.baseURL.trim() !== nextConfig.ai.baseURL.trim()
    || previousConfig.ai.apiKey.trim() !== nextConfig.ai.apiKey.trim()
    || previousConfig.ai.chatModel.trim() !== nextConfig.ai.chatModel.trim();
}

function currentVideoAiConfigComplete(config: UserConfig): boolean {
  return Boolean(
    config.ai.baseURL.trim()
    && config.ai.chatModel.trim()
    && config.ai.apiKey.trim(),
  );
}

function currentVideoPrimaryTextGuardMatchesContext(
  context: CurrentVideoContextResult,
  guard: CurrentVideoPrimaryTextAuthorizationGuard,
): boolean {
  return context.kind === 'video'
    && context.bvid === guard.bvid
    && context.cid === guard.cid
    && context.currentPart.page === guard.page;
}

async function currentVideoPrimaryTextGuardStillAuthorized(
  lookup: Pick<CurrentVideoContextLookupResult, 'context' | 'temporaryOwner' | 'primaryTextGuard'>,
): Promise<boolean> {
  const guard = lookup.primaryTextGuard;
  const context = lookup.context;
  if (!guard || !currentVideoPrimaryTextGuardMatchesContext(context, guard)) return false;
  if (!currentVideoPrimaryTextGuardEpochsCurrent(guard)) return false;
  if (
    context.kind !== 'video'
    || !context.transcriptEvidence?.active
    || context.transcriptEvidence.sourceIdentityKey !== guard.sourceIdentityKey
  ) {
    return false;
  }

  const readResult = await readCurrentVideoPrimaryTextSelections(chrome.storage.local);
  if (readResult.status !== 'ready' || !currentVideoPrimaryTextGuardEpochsCurrent(guard)) return false;

  const availableSourceIdentityKeys = getCurrentVideoCurrentOwnerTranscriptSourceIdentityKeys({
    bvid: guard.bvid,
    cid: guard.cid,
    page: guard.page,
  }, lookup.temporaryOwner);
  if (!currentVideoPrimaryTextGuardEpochsCurrent(guard)) return false;
  if (!availableSourceIdentityKeys.includes(guard.sourceIdentityKey)) return false;

  const authorization = resolveCurrentVideoPrimaryTextAuthorization({
    readStatus: 'ready',
    identity: {
      bvid: guard.bvid,
      cid: guard.cid,
      page: guard.page,
    },
    selections: readResult.selections,
    availableSourceIdentityKeys,
  });
  return authorization.ready
    && authorization.selectedSourceIdentityKey === guard.sourceIdentityKey;
}

async function currentVideoPrimaryTextGuardTestHook(
  phase: CurrentVideoPrimaryTextGuardTestPhase,
): Promise<void> {
  const hook = (globalThis as typeof globalThis & {
    __biliBillCurrentVideoPrimaryTextGuardTestHook__?: (
      phase: CurrentVideoPrimaryTextGuardTestPhase,
    ) => Promise<void> | void;
  }).__biliBillCurrentVideoPrimaryTextGuardTestHook__;
  if (typeof hook === 'function') {
    await hook(phase);
  }
}

async function resolveCurrentVideoLookupState(
  requestTabId: number | null = null,
): Promise<{
  tab: CurrentVideoTabSnapshot | null;
  context: CurrentVideoContextResult | null;
}> {
  const windows = await chrome.windows.getAll({
    populate: true,
    windowTypes: ['normal'],
  });
  const tabs = windows.flatMap(window => (window.tabs ?? []).map(tab => ({
    id: tab.id ?? 0,
    url: tab.url ?? null,
    active: tab.active ?? false,
    lastAccessed: typeof tab.lastAccessed === 'number' ? tab.lastAccessed : null,
  } satisfies CurrentVideoTabSnapshot)));

  if (requestTabId && requestTabId > 0) {
    const tab = tabs.find(candidate => candidate.id === requestTabId) ?? null;
    return {
      tab,
      context: tab ? resolveFreshMatchingVideoContext(tab, currentVideoContexts) : null,
    };
  }

  return resolveCurrentVideoTabState(tabs, currentVideoContexts);
}

function buildNoContext(
  url: string | null,
  reason: CurrentVideoNoContext['reason'],
  pageType: CurrentVideoNoContext['pageType'],
): CurrentVideoContextResult {
  return {
    kind: 'no_context',
    url,
    collectedAt: Date.now(),
    reason,
    pageType,
  };
}

function isEffectivePlayerWatch(payload: PlayerHeartbeatPayload | PlayerActionPayload): boolean {
  if ('action' in payload) return payload.action === 'complete';
  const duration = Math.max(0, payload.duration);
  const currentTime = Math.max(0, payload.currentTime);
  const completion = duration > 0 ? Math.min(currentTime / duration, 1) : 0;

  return completion >= DYNAMIC_BILL_STRATEGY.positiveCompletionRate
    || currentTime >= DYNAMIC_BILL_STRATEGY.minPositiveWatchSeconds;
}

function normalizeDynamicBillStatusFilter(value: unknown): DynamicBillStatusFilter {
  if (
    value === 'active'
    || value === 'unopened'
    || value === 'opened'
    || value === 'consumed'
    || value === 'processed'
  ) {
    return value;
  }
  throw new Error('INVALID_DYNAMIC_BILL_STATUS_FILTER');
}

function normalizeDynamicBillFeedbackScope(value: unknown): DynamicBillFeedbackScope {
  if (value === 'creator' || value === 'topic') return value;
  throw new Error('INVALID_DYNAMIC_BILL_FEEDBACK_SCOPE');
}

function requireStringParam(value: unknown, name: string): string {
  if (typeof value === 'string' && value.trim()) return value;
  throw new Error(`MISSING_${name.toUpperCase()}`);
}

function requirePositiveIntegerParam(value: unknown, name: string): number {
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric > 0) return numeric;
  throw new Error(`INVALID_${name.toUpperCase()}`);
}

function optionalNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function optionalPositiveInteger(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function timestampOperationKind(value: unknown): CurrentVideoTimestampOperationKind | null {
  return value === 'jump' || value === 'return' ? value : null;
}

function optionalStringParam(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalPositiveIntegerParam(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined;
}

function normalizeAiConfigParam(value: unknown): UserConfig['ai'] {
  if (!value || typeof value !== 'object') {
    throw new Error('MISSING_AI_CONFIG');
  }
  const raw = value as Record<string, unknown>;
  return {
    baseURL: typeof raw.baseURL === 'string' ? raw.baseURL.trim() : '',
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
    chatModel: typeof raw.chatModel === 'string' ? raw.chatModel.trim() : '',
  };
}

function videoUrl(bvid: string): string {
  return `https://www.bilibili.com/video/${encodeURIComponent(bvid)}`;
}

function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.floor(numeric));
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1, Math.floor(numeric));
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
