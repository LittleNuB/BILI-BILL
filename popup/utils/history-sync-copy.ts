import type { HistorySyncMode, HistorySyncProgress } from '../../src/shared/types/history-sync.ts';

export function historySyncModeLabel(mode: HistorySyncMode | null | undefined): string {
  if (mode === 'full') return '历史全量同步';
  if (mode === 'incremental') return '历史增量同步';
  return '历史同步';
}

export function historySyncStopReasonLabel(reason: string | undefined): string {
  switch (reason) {
    case 'page_limit':
      return '已到本次扫描上限，较早记录可能尚未同步';
    case 'empty_page_cursor_anomaly':
      return '历史接口返回异常，本次同步未完成';
    case 'cancelled':
    case 'sync_cancelled':
      return '已停止本次同步';
    case 'service_worker_restarted':
      return '同步因扩展重启而中断，可重新同步';
    case 'stale_lock_cleared':
      return '上次同步已中断，可重新同步';
    case 'sync_started':
      return '同步已开始，尚无结束结果';
    case 'already_complete':
      return '此前已完成历史同步';
    case 'no_new_records':
      return '本次未发现新记录，不代表较早记录已全部同步';
    case 'boundary_records_seen':
      return '已扫描到本地已有记录，不代表较早记录已全部同步';
    case 'api_end':
    case 'api_end_empty_page':
      return '已到历史接口可提供的末尾';
    default:
      return '本次同步已结束，完整性尚未确认';
  }
}

export function historySyncProgressLabel(
  progress: Pick<HistorySyncProgress, 'syncing' | 'currentTask' | 'stoppedReason' | 'fetchedPages'> | null,
): string {
  if (!progress) return '正在准备同步';
  if (!progress.syncing) return historySyncStopReasonLabel(progress.stoppedReason);
  if (progress.currentTask === '正在停止同步...' || progress.currentTask === 'sync_cancelled') {
    return '正在停止同步';
  }
  if (progress.currentTask === 'sync_complete') return '正在完成本次同步';
  // The executor uses page_limit as its initial task, not as a live stop signal.
  return progress.fetchedPages > 0 ? '正在同步历史记录' : '正在准备同步';
}
