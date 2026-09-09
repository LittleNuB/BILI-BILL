import type {
  LocalDataCategorySummary,
  LocalDataOperationResult,
  LocalDataPrivacySummary,
  SmartFavoriteIndexRebuildResult,
} from './types/local-data-privacy';
import type { IndependentlyClearableLocalDataCategoryId } from './local-data-category-contract';

export const LOCAL_DATA_CLEAR_CONFIRMATION = '清理本地数据';

export interface LocalDataSummaryCard {
  id:
    | 'history'
    | 'favorites'
    | 'subtitles'
    | 'summaryHighlights'
    | 'qaSessions'
    | 'dynamicBill'
    | 'blindBoxDrawHistory';
  title: string;
  value: string;
  detail: string;
  meta: string;
}

export interface LocalDataDiagnosticExport {
  '导出时间': string;
  '应用': {
    '产品': 'Bili-Bill';
    '诊断格式版本': 1;
  };
  '隐私边界': {
    '包含': string[];
    '不包含': string[];
  };
  '本地数据类别': Array<{
    '类别': string;
    '数量': number;
    '占用字节': number;
  }>;
  '功能状态': {
    '当前视频文本': {
      'B站字幕来源': number;
      'B站字幕片段': number;
      '已缓存视频分P': number;
      '过期片段': number;
    };
    '当前视频助手': {
      '摘要与亮点分P': number;
      '问答会话': number;
    };
    '动态账单': {
      '账单项': number;
      '暂停中的UP主': number;
      '解释': number;
      '最近生成': string;
      '最近同步': string;
      '同步状态': string;
    };
    '视频盲盒': {
      '最近抽取': number;
      '最多保留': number;
    };
  };
}

export function buildLocalDataSummaryCards(summary: LocalDataPrivacySummary): LocalDataSummaryCard[] {
  const historyUsage = categorySummary(summary, 'history');
  const favoriteUsage = categorySummary(summary, 'favorites');
  const subtitleUsage = categorySummary(summary, 'currentVideoSubtitles');
  const summaryUsage = categorySummary(summary, 'currentVideoSummaryHighlights');
  const qaUsage = categorySummary(summary, 'currentVideoQaSessions');
  const dynamicBillUsage = categorySummary(summary, 'dynamicBill');
  const blindBoxUsage = categorySummary(summary, 'blindBoxDrawHistory');

  return [
    {
      id: 'history',
      title: '观看历史',
      value: `${summary.history.totalRecords} 条`,
      detail: summary.history.totalRecords > 0
        ? `覆盖 ${formatLocalDate(summary.history.oldestViewAt, 'seconds')} 至 ${formatLocalDate(summary.history.newestViewAt, 'seconds')}`
        : '还没有本地观看记录。',
      meta: [
        `占用 ${formatBytes(historyUsage?.usageBytes ?? 0)}`,
        `最近同步：${formatLocalDate(summary.history.lastSyncedAt, 'milliseconds')}`,
        summary.history.syncing ? '正在同步观看历史' : '',
      ].filter(Boolean).join('；'),
    },
    {
      id: 'favorites',
      title: '收藏与智能索引',
      value: `${summary.favorites.storedItems} 条`,
      detail: `已同步 ${summary.favorites.folderCount} 个收藏夹；B站报告 ${summary.favorites.reportedItems} 条，本地保存 ${summary.favorites.storedItems} 条，已索引 ${summary.favorites.indexedItems} 条。`,
      meta: [
        `占用 ${formatBytes(favoriteUsage?.usageBytes ?? 0)}`,
        `最近同步：${formatLocalDate(summary.favorites.lastSyncedAt, 'milliseconds')}`,
        summary.favorites.incompleteFolders > 0
          ? `有 ${summary.favorites.incompleteFolders} 个收藏夹可能尚未同步完整`
          : '',
      ].filter(Boolean).join('；'),
    },
    {
      id: 'subtitles',
      title: 'B站字幕正文',
      value: `${subtitleUsage?.count ?? summary.currentVideoSubtitles.sourceIdentityCount} 个来源`,
      detail: summary.currentVideoSubtitles.segmentCount > 0
        ? `已缓存 ${summary.currentVideoSubtitles.cachedVideoCount} 个视频分P、${summary.currentVideoSubtitles.segmentCount} 段字幕正文。`
        : '还没有缓存的字幕正文。',
      meta: `占用 ${formatBytes(subtitleUsage?.usageBytes ?? summary.currentVideoSubtitles.usageBytes)}；最近缓存：${formatLocalDate(summary.currentVideoSubtitles.lastUpdatedAt, 'milliseconds')}`,
    },
    {
      id: 'summaryHighlights',
      title: '摘要与亮点',
      value: `${summaryUsage?.count ?? summary.currentVideoSummaryHighlights.cachedPartCount} 个分P`,
      detail: summary.currentVideoSummaryHighlights.cachedPartCount > 0
        ? '用于恢复已经生成的摘要与亮点，不会自动补发请求。'
        : '还没有缓存的摘要与亮点结果。',
      meta: `占用 ${formatBytes(summaryUsage?.usageBytes ?? summary.currentVideoSummaryHighlights.usageBytes)}；最近生成：${formatLocalDate(summary.currentVideoSummaryHighlights.latestGeneratedAt, 'milliseconds')}`,
    },
    {
      id: 'qaSessions',
      title: '问答会话',
      value: `${qaUsage?.count ?? summary.currentVideoQaSessions.sessionCount} 个会话`,
      detail: summary.currentVideoQaSessions.sessionCount > 0
        ? '仅保存问题、已验证回答、引用和必要来源，不保存完整视频正文。'
        : '还没有保存的问答会话。',
      meta: `占用 ${formatBytes(qaUsage?.usageBytes ?? summary.currentVideoQaSessions.usageBytes)}；最近使用：${formatLocalDate(summary.currentVideoQaSessions.latestUsedAt, 'milliseconds')}`,
    },
    {
      id: 'dynamicBill',
      title: '动态账单',
      value: `${summary.dynamicBill.billItemCount} 项`,
      detail: `关注快照 ${summary.dynamicBill.activeFollowedCreatorCount} 位，近期视频投稿 ${summary.dynamicBill.followedVideoUpdateCount} 条。`,
      meta: [
        `占用 ${formatBytes(dynamicBillUsage?.usageBytes ?? 0)}`,
        `最近生成：${formatLocalDate(summary.dynamicBill.lastGeneratedAt, 'milliseconds')}`,
        `最近同步：${formatLocalDate(summary.dynamicBill.lastSyncedAt, 'milliseconds')}`,
      ].join('；'),
    },
    {
      id: 'blindBoxDrawHistory',
      title: '盲盒抽取记录',
      value: `${blindBoxUsage?.count ?? summary.blindBoxDrawHistory.recentDrawCount} 条`,
      detail: `只记录最近 ${summary.blindBoxDrawHistory.maxRecentDraws} 次抽取用于减少重复，不提供单独开关或单独清理入口。`,
      meta: `占用 ${formatBytes(blindBoxUsage?.usageBytes ?? summary.blindBoxDrawHistory.usageBytes)}；最近记录：${formatLocalDate(summary.blindBoxDrawHistory.lastUpdatedAt, 'milliseconds')}`,
    },
  ];
}

export function hasLocalDataCategoryContent(
  summary: LocalDataPrivacySummary,
  id: IndependentlyClearableLocalDataCategoryId,
): boolean {
  const category = categorySummary(summary, id);
  return category !== null && (category.count > 0 || category.usageBytes > 0);
}

export function buildLocalDataOperationMessage(result: LocalDataOperationResult): string {
  const base = buildCompletedOperationMessage(result);
  if (result.status !== 'partial_failure') return base;

  const failed = result.categoryResults?.failed ?? [];
  if (failed.length === 0) return base;

  const successfulCount = result.categoryResults?.completed.length ?? 0;
  const failedNames = failed.map(item => item.label).join('、');
  return [
    successfulCount > 0 ? `已完成 ${successfulCount} 类数据清理并完成回读。` : '',
    `以下类别清理失败：${failedNames}。已完成的类别不会回滚，请稍后重试失败类别。`,
  ].filter(Boolean).join(' ');
}

export function buildSmartFavoriteRebuildMessage(result: SmartFavoriteIndexRebuildResult): string {
  return [
    `智能收藏索引已重新生成：本地收藏 ${result.totalItems} 条，处理 ${result.processed} 条，成功 ${result.indexed} 条，失败 ${result.failed} 条，跳过 ${result.skipped} 条。`,
    result.failed > 0 ? '失败项可在确认 AI 设置后再次重建。' : '',
  ].filter(Boolean).join(' ');
}

export function dangerousLocalDataClearScope(): string[] {
  return [
    '观看历史、播放器事件和统计聚合。',
    '收藏夹快照、智能收藏索引和收藏问答本地依据。',
    'B站字幕正文、摘要与亮点、问答会话、动态账单记录、动态账单反馈和解释、盲盒抽取记录。',
    '本地 AI 服务设置、密钥保存状态、功能开关、当前视频主要文本选择和浮窗状态。',
    '主动保存的目标与偏好，以及记忆 AI 授权。',
  ];
}

export function buildLocalDataDiagnosticExport(summary: LocalDataPrivacySummary): LocalDataDiagnosticExport {
  return {
    '导出时间': new Date(summary.checkedAt).toISOString(),
    '应用': {
      '产品': 'Bili-Bill',
      '诊断格式版本': 1,
    },
    '隐私边界': {
      '包含': [
        '本地数据类别名称、数量和占用',
        '动态账单与盲盒的宽泛状态和必要时间',
      ],
      '不包含': [
        '完整记录或正文',
        '站点凭据、登录状态和浏览器资料目录',
        '完整或可恢复的密钥',
        '原始字幕地址',
        '本地敏感路径',
        '视频内部标识、内容哈希和内部字段',
      ],
    },
    '本地数据类别': summary.categories.map(category => ({
      '类别': category.label,
      '数量': category.count,
      '占用字节': category.usageBytes,
    })),
    '功能状态': {
      '当前视频文本': {
        'B站字幕来源': summary.currentVideoSubtitles.sourceIdentityCount,
        'B站字幕片段': summary.currentVideoSubtitles.segmentCount,
        '已缓存视频分P': summary.currentVideoSubtitles.cachedVideoCount,
        '过期片段': summary.currentVideoSubtitles.staleSegmentCount,
      },
      '当前视频助手': {
        '摘要与亮点分P': summary.currentVideoSummaryHighlights.cachedPartCount,
        '问答会话': summary.currentVideoQaSessions.sessionCount,
      },
      '动态账单': {
        '账单项': summary.dynamicBill.billItemCount,
        '暂停中的UP主': summary.dynamicBill.creatorPauseCount,
        '解释': summary.dynamicBill.explanationCount,
        '最近生成': formatDiagnosticDate(summary.dynamicBill.lastGeneratedAt),
        '最近同步': formatDiagnosticDate(summary.dynamicBill.lastSyncedAt),
        '同步状态': dynamicSyncStatusLabel(summary.dynamicBill.syncStatus),
      },
      '视频盲盒': {
        '最近抽取': summary.blindBoxDrawHistory.recentDrawCount,
        '最多保留': summary.blindBoxDrawHistory.maxRecentDraws,
      },
    },
  };
}

export function formatLocalDataError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'LOCAL_DATA_CLEAR_CONFIRMATION_REQUIRED') {
    return `请输入“${LOCAL_DATA_CLEAR_CONFIRMATION}”后再确认清理。`;
  }
  if (message === 'HISTORY_SYNC_IN_PROGRESS') {
    return '观看历史正在同步中。请先停止或等待同步结束，再清理本地数据。';
  }
  return '本地数据操作失败，请稍后重试。';
}

function buildCompletedOperationMessage(result: LocalDataOperationResult): string {
  if (result.operation === 'clear_local_data_category') {
    const completed = result.categoryResults?.completed[0];
    if (completed) {
      if (completed.beforeCount === 0 && completed.beforeUsageBytes > 0) {
        return `已清理${completed.label}：清理前存在本地状态，回读后已清空。`;
      }
      return `已清理${completed.label}：清理前共 ${completed.beforeCount} 项本地数据，回读后为 0。`;
    }
    return '已执行本地数据清理并完成回读。';
  }
  if (result.operation === 'clear_current_video_subtitle_cache') {
    const sourceCount = result.cleared.currentVideoSubtitleSources ?? 0;
    const segmentCount = result.cleared.currentVideoSubtitleSegments ?? 0;
    return `已清理B站字幕正文：移除 ${sourceCount} 条来源记录和 ${segmentCount} 段字幕正文。`;
  }
  if (result.operation === 'clear_current_video_summary_highlight_cache') {
    const partCount = result.cleared.currentVideoSummaryHighlightParts ?? 0;
    return `已清理摘要与亮点：移除 ${partCount} 个分P的生成结果。`;
  }
  if (result.operation === 'clear_dynamic_bill_data') {
    return `已清理动态账单本地数据：账单 ${result.cleared.dynamicBillItems ?? 0} 项、解释 ${result.cleared.dynamicBillExplanations ?? 0} 条。`;
  }

  const completedCategories = result.categoryResults?.completed.map(item => item.label) ?? [];
  return [
    '已清理本地数据并完成回读。',
    completedCategories.length > 0 ? `已完成类别：${completedCategories.join('、')}。` : '',
    result.cleared.localSettings
      ? '本地 AI 设置、密钥保存状态、功能开关、当前视频主要文本选择和浮窗状态也已恢复为默认状态。'
      : '',
  ].filter(Boolean).join(' ');
}

function categorySummary(
  summary: LocalDataPrivacySummary,
  id: LocalDataCategorySummary['id'],
): LocalDataCategorySummary | null {
  return summary.categories.find(category => category.id === id) ?? null;
}

function formatLocalDate(value: number | null, unit: 'milliseconds' | 'seconds'): string {
  if (!value || value <= 0) return '暂无记录';
  const timestamp = unit === 'seconds' ? value * 1000 : value;
  return new Date(timestamp).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatDiagnosticDate(value: number | null): string {
  if (!value || value <= 0) return '暂无记录';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '暂无记录' : date.toISOString();
}

function formatBytes(value: number): string {
  const safe = Math.max(0, Math.floor(value));
  if (safe < 1024) return `${safe} B`;
  if (safe < 1024 * 1024) return `${(safe / 1024).toFixed(1)} KB`;
  return `${(safe / 1024 / 1024).toFixed(1)} MB`;
}

function dynamicSyncStatusLabel(status: string): string {
  if (status === 'success') return '同步完成';
  if (status === 'syncing') return '同步中';
  if (status === 'failed') return '同步失败';
  return '等待同步';
}
