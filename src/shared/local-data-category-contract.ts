export type LocalDataCategoryId =
  | 'explicitMemory'
  | 'history'
  | 'favorites'
  | 'currentVideoSubtitles'
  | 'currentVideoSummaryHighlights'
  | 'currentVideoQaSessions'
  | 'dynamicBill'
  | 'blindBoxDrawHistory'
  | 'localSettings';

export type IndependentlyClearableLocalDataCategoryId =
  | 'history'
  | 'favorites'
  | 'currentVideoSubtitles'
  | 'currentVideoSummaryHighlights'
  | 'currentVideoQaSessions'
  | 'dynamicBill';

const INDEPENDENTLY_CLEARABLE_LOCAL_DATA_CATEGORY_IDS = new Set<string>([
  'history',
  'favorites',
  'currentVideoSubtitles',
  'currentVideoSummaryHighlights',
  'currentVideoQaSessions',
  'dynamicBill',
]);

export function isIndependentlyClearableLocalDataCategoryId(
  value: unknown,
): value is IndependentlyClearableLocalDataCategoryId {
  return typeof value === 'string'
    && INDEPENDENTLY_CLEARABLE_LOCAL_DATA_CATEGORY_IDS.has(value);
}

export interface LocalDataClearedCounts {
  explicitMemory?: number;
  historyRecords?: number;
  playerEvents?: number;
  dailyAggregates?: number;
  favoriteFolders?: number;
  favoriteItems?: number;
  smartFavoriteIndexes?: number;
  followedCreators?: number;
  followedVideoUpdates?: number;
  dynamicBillItems?: number;
  dynamicBillExplanations?: number;
  dynamicBillCreatorPauses?: number;
  dynamicBillFeedbackActions?: number;
  dynamicBillCreatorFeedbackCounts?: number;
  dynamicBillCreatorReviewPrompts?: number;
  dynamicBillRotationRecords?: number;
  blindBoxDrawHistory?: number;
  currentVideoSubtitleSources?: number;
  currentVideoSubtitleSegments?: number;
  currentVideoSummaryHighlightParts?: number;
  currentVideoSummaryHighlightBytes?: number;
  currentVideoQaSessions?: number;
  currentVideoQaSessionBytes?: number;
  localSettings?: boolean;
}

export interface LocalDataCategoryUsage {
  count: number;
  usageBytes: number;
  details?: LocalDataClearedCounts;
}

export interface LocalDataCategoryClearResult {
  cleared: LocalDataClearedCounts;
}

export interface LocalDataCategoryReadback extends LocalDataCategoryUsage {
  empty: boolean;
}

export interface LocalDataCategoryRegistration {
  id: LocalDataCategoryId;
  label: string;
  includeInClearAll: boolean;
  collectUsage: () => Promise<LocalDataCategoryUsage>;
  clear: () => Promise<LocalDataCategoryClearResult>;
  readAfterClear: () => Promise<LocalDataCategoryReadback>;
}

export type LocalDataCategoryFailureStage = 'collect_usage' | 'clear' | 'readback';

export type LocalDataCategoryFailureReason =
  | 'usage_unavailable'
  | 'clear_failed'
  | 'readback_unavailable'
  | 'data_remaining';

export interface LocalDataCategoryLifecycleSuccess {
  status: 'success';
  id: LocalDataCategoryId;
  label: string;
  before: LocalDataCategoryUsage;
  clearResult: LocalDataCategoryClearResult;
  after: LocalDataCategoryReadback;
}

export interface LocalDataCategoryLifecycleFailure {
  status: 'failure';
  id: LocalDataCategoryId;
  label: string;
  failedStage: LocalDataCategoryFailureStage;
  failureReason: LocalDataCategoryFailureReason;
  message: string;
  before: LocalDataCategoryUsage | null;
  clearResult: LocalDataCategoryClearResult | null;
  after: LocalDataCategoryReadback | null;
}

export type LocalDataCategoryLifecycleResult =
  | LocalDataCategoryLifecycleSuccess
  | LocalDataCategoryLifecycleFailure;

export async function runLocalDataCategoryLifecycle(
  registration: LocalDataCategoryRegistration,
): Promise<LocalDataCategoryLifecycleResult> {
  let before: LocalDataCategoryUsage;
  try {
    before = await registration.collectUsage();
  } catch {
    return lifecycleFailure(registration, 'collect_usage', 'usage_unavailable', null, null, null);
  }

  let clearResult: LocalDataCategoryClearResult;
  try {
    clearResult = await registration.clear();
  } catch {
    return lifecycleFailure(registration, 'clear', 'clear_failed', before, null, null);
  }

  try {
    const after = await registration.readAfterClear();
    if (!after.empty || after.count !== 0 || after.usageBytes !== 0) {
      return lifecycleFailure(
        registration,
        'readback',
        'data_remaining',
        before,
        clearResult,
        after,
      );
    }
    return {
      status: 'success',
      id: registration.id,
      label: registration.label,
      before,
      clearResult,
      after,
    };
  } catch {
    return lifecycleFailure(
      registration,
      'readback',
      'readback_unavailable',
      before,
      clearResult,
      null,
    );
  }
}

export async function runLocalDataCategoryLifecycles(
  registrations: LocalDataCategoryRegistration[],
): Promise<LocalDataCategoryLifecycleResult[]> {
  const results: LocalDataCategoryLifecycleResult[] = [];
  for (const registration of registrations) {
    results.push(await runLocalDataCategoryLifecycle(registration));
  }
  return results;
}

export function validateLocalDataCategoryRegistration(
  registration: LocalDataCategoryRegistration,
): string[] {
  const issues: string[] = [];
  if (!registration.id) issues.push('missing_id');
  if (!registration.label.trim()) issues.push('missing_label');
  if (typeof registration.collectUsage !== 'function') issues.push('missing_collect_usage');
  if (typeof registration.clear !== 'function') issues.push('missing_clear');
  if (typeof registration.readAfterClear !== 'function') issues.push('missing_readback');
  if (typeof registration.includeInClearAll !== 'boolean') issues.push('missing_clear_all_hook');
  return issues;
}

function lifecycleFailure(
  registration: LocalDataCategoryRegistration,
  failedStage: LocalDataCategoryFailureStage,
  failureReason: LocalDataCategoryFailureReason,
  before: LocalDataCategoryUsage | null,
  clearResult: LocalDataCategoryClearResult | null,
  after: LocalDataCategoryReadback | null,
): LocalDataCategoryLifecycleFailure {
  return {
    status: 'failure',
    id: registration.id,
    label: registration.label,
    failedStage,
    failureReason,
    message: lifecycleFailureMessage(registration.label, failureReason),
    before,
    clearResult,
    after,
  };
}

function lifecycleFailureMessage(label: string, reason: LocalDataCategoryFailureReason): string {
  if (reason === 'usage_unavailable') return `${label}的数据统计失败，暂时无法开始清理。`;
  if (reason === 'readback_unavailable') return `${label}已执行清理，但结果回读失败，请刷新后核对。`;
  if (reason === 'data_remaining') return `${label}已执行清理，但回读后仍有本地数据，请重试。`;
  return `${label}清理失败，已完成的其他类别不会受影响。`;
}
