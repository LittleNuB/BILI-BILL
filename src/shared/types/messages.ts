import type {
  QuickStats,
  DashboardOverview,
  PreferenceAnalytics,
  CreatorFollowDataCoverage,
  CreatorFollowStatusGroup,
  CreatorRanking,
  NewCreator,
  BehaviorMetrics,
  ExperimentData,
} from './analytics';
import type {
  DynamicBillExplanationResult,
  DynamicBillFeedbackStateView,
  DynamicBillFeedbackResult,
  DynamicBillFilterPreference,
  DynamicBillGenerateResult,
  DynamicBillItem,
  DynamicBillCreatorPauseView,
  DynamicBillLessReminderResult,
  DynamicBillOverview,
  DynamicBillRestoreCreatorReminderResult,
  DynamicBillReviewPromptResolveResult,
  DynamicSyncResult,
  DynamicBillUndoFeedbackResult,
} from './dynamic-bill';
import type {
  FavoriteFolderGapProbeResult,
  FavoriteSyncResult,
  SmartFavoriteOverview,
  SmartFavoriteQaResponse,
  SmartFavoriteResult,
  SmartFavoriteSearchResponse,
  SmartIndexResult,
} from './favorite';
import type { CurrentVideoContextResult, CurrentVideoSubtitleSourceState } from './current-video-context';
import type { CurrentVideoTranscriptEvidenceState } from './current-video-transcript';
import type {
  CurrentVideoSegmentRetrievalResult,
  CurrentVideoTimestampJumpResponse,
  CurrentVideoTimestampReturnResponse,
} from './current-video-segment-retrieval';
import type { CurrentVideoSubtitleViewSourcesResult } from '../current-video-subtitle-view.ts';
import type { CurrentVideoRelatedFavoritesResponse } from './current-video-related-favorites';
import type { CurrentVideoSummaryHighlightsResult } from './current-video-summary';
import type { CurrentVideoFullTextQaResult } from './current-video-full-text-qa';
import type { CurrentVideoQaSessionsView } from './current-video-qa-session';
import type { VideoKnowledgeResult } from './video-knowledge';
import type { HistoryTailProbeReport } from './history-tail-probe';
import type { HistorySyncCursorSnapshot, HistorySyncMode } from './history-sync';
import type { AiConnectionTestResult } from './config';
import type {
  LocalDataOperationResult,
  LocalDataPrivacySummary,
  SmartFavoriteIndexRebuildResult,
} from './local-data-privacy';

// 弹窗 / 面板 → Service Worker
export type RequestAction =
  | 'LEARNING_LIST'
  | 'LEARNING_GET'
  | 'LEARNING_EDIT'
  | 'LEARNING_DELETE'
  | 'LEARNING_PREPARE'
  | 'LEARNING_SAVE'
  | 'LEARNING_CANCEL'
  | 'GET_QUICK_STATS'
  | 'GET_DASHBOARD_DATA'
  | 'GET_PREFERENCE_DATA'
  | 'GET_CREATOR_DATA'
  | 'GET_BEHAVIOR_DATA'
  | 'GET_EXPERIMENT_DATA'
  | 'GET_DEVICE_DATA'
  | 'SYNC_NOW'
  | 'CANCEL_SYNC'
  | 'GET_CONFIG'
  | 'GET_CONFIG_SNAPSHOT'
  | 'UPDATE_CONFIG'
  | 'TEST_AI_CONNECTION'
  | 'GET_LOCAL_DATA_PRIVACY_SUMMARY'
  | 'CLEAR_LOCAL_DATA_CATEGORY'
  | 'CLEAR_CURRENT_VIDEO_SUBTITLE_CACHE'
  | 'CLEAR_CURRENT_VIDEO_SUMMARY_HIGHLIGHT_CACHE'
  | 'REBUILD_SMART_FAVORITE_INDEX'
  | 'CLEAR_ALL_LOCAL_DATA'
  | 'EXPORT_DATA'
  | 'EXPORT_DATA_PAGE'
  | 'GET_SYNC_STATUS'
  | 'PROBE_HISTORY_TAIL'
  | 'GET_CURRENT_VIDEO_CONTEXT'
  | 'SAVE_CURRENT_VIDEO_PRIMARY_TEXT_SELECTION'
  | 'PROBE_CURRENT_VIDEO_SUBTITLE_SOURCE'
  | 'GET_CURRENT_VIDEO_TRANSCRIPT_EVIDENCE'
  | 'GET_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS_CACHE'
  | 'GENERATE_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS'
  | 'CANCEL_CURRENT_VIDEO_SUMMARY_HIGHLIGHTS'
  | 'GET_CURRENT_VIDEO_QA_SESSIONS'
  | 'RENAME_CURRENT_VIDEO_QA_SESSION'
  | 'DELETE_CURRENT_VIDEO_QA_SESSION'
  | 'CLEAR_CURRENT_VIDEO_QA_SESSIONS'
  | 'ASK_CURRENT_VIDEO_FULL_TEXT'
  | 'CANCEL_CURRENT_VIDEO_FULL_TEXT_QA'
  | 'GET_VIDEO_KNOWLEDGE'
  | 'SEARCH_CURRENT_VIDEO_SEGMENTS'
  | 'GET_CURRENT_VIDEO_SUBTITLE_VIEW_SOURCES'
  | 'GET_CURRENT_VIDEO_RELATED_FAVORITES'
  | 'REQUEST_CURRENT_VIDEO_SEGMENT_JUMP'
  | 'REQUEST_CURRENT_VIDEO_HIGHLIGHT_JUMP'
  | 'REQUEST_CURRENT_VIDEO_QA_CITATION_JUMP'
  | 'REQUEST_CURRENT_VIDEO_SUBTITLE_JUMP'
  | 'RETURN_CURRENT_VIDEO_SEGMENT_JUMP'
  | 'RETURN_CURRENT_VIDEO_SUBTITLE_JUMP'
  | 'CONSUME_CURRENT_VIDEO_TIMESTAMP_OPERATION_LEASE'
  | 'GET_SMART_FAVORITES'
  | 'GET_SMART_FAVORITES_BY_PATH'
  | 'SYNC_FAVORITES'
  | 'PROBE_FAVORITE_FOLDER_GAP'
  | 'BUILD_SMART_FAVORITE_INDEX'
  | 'SEARCH_SMART_FAVORITES'
  | 'ASK_SMART_FAVORITES'
  | 'GET_DYNAMIC_BILL_OVERVIEW'
  | 'SYNC_DYNAMIC_UPDATES'
  | 'GENERATE_DYNAMIC_BILL'
  | 'BUILD_DYNAMIC_BILL_EXPLANATIONS'
  | 'GET_DYNAMIC_BILL_ITEMS'
  | 'GET_DYNAMIC_BILL_FILTER'
  | 'UPDATE_DYNAMIC_BILL_FILTER'
  | 'ADD_DYNAMIC_BILL_FEEDBACK'
  | 'GET_DYNAMIC_BILL_FEEDBACK_STATE'
  | 'APPLY_DYNAMIC_BILL_CREATOR_LESS_REMINDER'
  | 'UNDO_DYNAMIC_BILL_CREATOR_LESS_REMINDER'
  | 'DISMISS_DYNAMIC_BILL_CREATOR_REVIEW_PROMPT'
  | 'OPEN_DYNAMIC_BILL_CREATOR_REVIEW_PROMPT'
  | 'GET_DYNAMIC_BILL_ACTIVE_PAUSES'
  | 'RESTORE_DYNAMIC_BILL_CREATOR_REMINDER'
  | 'OPEN_DYNAMIC_BILL_VIDEO'
  | 'MARK_DYNAMIC_BILL_ITEM_PROCESSED';

// Content Script → Service Worker
export type ContentAction =
  | 'PLAYER_HEARTBEAT'
  | 'PLAYER_ACTION'
  | 'PAGE_NAVIGATION'
  | 'CURRENT_VIDEO_CONTEXT_UPDATE';

// Player events from content script
export interface PlayerHeartbeatPayload {
  bvid: string;
  cid: number;
  currentTime: number;
  duration: number;
  playbackRate: number;
}

export interface PlayerActionPayload {
  action: 'play' | 'pause' | 'seek' | 'complete' | 'ratechange';
  bvid: string;
  cid: number;
  currentTime: number;
  duration: number;
  seekFrom?: number;
  seekTo?: number;
  playbackRate?: number;
}

export interface PageNavigationPayload {
  page: 'homepage' | 'video' | 'space' | 'other';
  url: string;
}

// Request/Response protocol
export interface BiliVizRequest {
  action: RequestAction;
  params?: Record<string, unknown>;
}

export interface BiliVizContentMessage {
  action: ContentAction;
  payload: PlayerHeartbeatPayload | PlayerActionPayload | PageNavigationPayload | CurrentVideoContextResult;
}

export interface BiliVizResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface SyncNowResult {
  synced: true;
  mode: HistorySyncMode;
  requestedPageLimit: number | null;
  pageLimit: number;
  currentTask: string;
  fetchedPages: number;
  fetchedCount: number;
  insertedCount: number;
  updatedCount: number;
  skippedCount: number;
  duplicateCount: number;
  unsupportedBusinessCount: number;
  liveExcludedCount: number;
  missingIdCount: number;
  stoppedReason: string;
  reachedEnd: boolean;
  oldestFetchedAt: number | null;
  newestFetchedAt: number | null;
  finalCursor: HistorySyncCursorSnapshot | null;
}

// Typed response data
export type QuickStatsResponse = BiliVizResponse<QuickStats>;
export type DashboardResponse = BiliVizResponse<DashboardOverview>;
export type PreferenceResponse = BiliVizResponse<PreferenceAnalytics>;
export type CreatorResponse = BiliVizResponse<{
  topCreators: CreatorRanking[];
  deepBondCreators: CreatorRanking[];
  newCreators: NewCreator[];
  followGroups: CreatorFollowStatusGroup[];
  followDataCoverage: CreatorFollowDataCoverage;
  overDependency: { creator: CreatorRanking; percentage: number } | null;
}>;
export type BehaviorResponse = BiliVizResponse<BehaviorMetrics>;
export type ExperimentResponse = BiliVizResponse<ExperimentData>;
export type DeviceResponse = BiliVizResponse<{
  breakdown: { label: string; deviceType: number; watchTime: number; videoCount: number; avgCompletion: number; percentage: number }[];
  hourly: { mobile: number[]; pc: number[] };
  deviceCompletion: { mobile: number; pc: number };
}>;
export type SmartFavoritesResponse = BiliVizResponse<SmartFavoriteOverview>;
export type FavoriteSyncResponse = BiliVizResponse<FavoriteSyncResult>;
export type FavoriteFolderGapProbeResponse = BiliVizResponse<FavoriteFolderGapProbeResult>;
export type SmartFavoriteIndexResponse = BiliVizResponse<SmartIndexResult>;
export type SmartFavoriteSearchMessageResponse = BiliVizResponse<SmartFavoriteSearchResponse>;
export type SmartFavoriteQaMessageResponse = BiliVizResponse<SmartFavoriteQaResponse>;
export type SmartFavoritePathResponse = BiliVizResponse<SmartFavoriteResult[]>;
export type CurrentVideoContextResponse = BiliVizResponse<CurrentVideoContextResult>;
export type CurrentVideoSubtitleSourceResponse = BiliVizResponse<CurrentVideoSubtitleSourceState>;
export type CurrentVideoTranscriptEvidenceResponse = BiliVizResponse<CurrentVideoTranscriptEvidenceState>;
export type CurrentVideoSummaryHighlightsResponse = BiliVizResponse<CurrentVideoSummaryHighlightsResult>;
export type CurrentVideoFullTextQaResponse = BiliVizResponse<CurrentVideoFullTextQaResult>;
export type CurrentVideoQaSessionsResponse = BiliVizResponse<CurrentVideoQaSessionsView>;
export type VideoKnowledgeResponse = BiliVizResponse<VideoKnowledgeResult>;
export type CurrentVideoSegmentRetrievalResponse = BiliVizResponse<CurrentVideoSegmentRetrievalResult>;
export type CurrentVideoSubtitleViewSourcesResponse = BiliVizResponse<CurrentVideoSubtitleViewSourcesResult>;
export type CurrentVideoRelatedFavoritesMessageResponse = BiliVizResponse<CurrentVideoRelatedFavoritesResponse>;
export type CurrentVideoTimestampJumpMessageResponse = BiliVizResponse<CurrentVideoTimestampJumpResponse>;
export type CurrentVideoTimestampReturnMessageResponse = BiliVizResponse<CurrentVideoTimestampReturnResponse>;
export type DynamicBillOverviewResponse = BiliVizResponse<DynamicBillOverview>;
export type DynamicSyncResponse = BiliVizResponse<DynamicSyncResult>;
export type DynamicBillGenerateResponse = BiliVizResponse<DynamicBillGenerateResult>;
export type DynamicBillExplanationResponse = BiliVizResponse<DynamicBillExplanationResult>;
export type DynamicBillItemsResponse = BiliVizResponse<DynamicBillItem[]>;
export type DynamicBillItemResponse = BiliVizResponse<DynamicBillItem | null>;
export type DynamicBillFilterResponse = BiliVizResponse<DynamicBillFilterPreference>;
export type DynamicBillFeedbackResponse = BiliVizResponse<DynamicBillFeedbackResult>;
export type DynamicBillFeedbackStateResponse = BiliVizResponse<DynamicBillFeedbackStateView>;
export type DynamicBillLessReminderResponse = BiliVizResponse<DynamicBillLessReminderResult | null>;
export type DynamicBillUndoFeedbackResponse = BiliVizResponse<DynamicBillUndoFeedbackResult>;
export type DynamicBillCreatorPauseListResponse = BiliVizResponse<DynamicBillCreatorPauseView[]>;
export type DynamicBillRestoreCreatorReminderResponse = BiliVizResponse<DynamicBillRestoreCreatorReminderResult>;
export type DynamicBillReviewPromptResolveResponse = BiliVizResponse<DynamicBillReviewPromptResolveResult>;
export type HistoryTailProbeResponse = BiliVizResponse<HistoryTailProbeReport>;
export type AiConnectionTestResponse = BiliVizResponse<AiConnectionTestResult>;
export type LocalDataPrivacySummaryResponse = BiliVizResponse<LocalDataPrivacySummary>;
export type LocalDataOperationResponse = BiliVizResponse<LocalDataOperationResult>;
export type SmartFavoriteIndexRebuildResponse = BiliVizResponse<SmartFavoriteIndexRebuildResult>;
