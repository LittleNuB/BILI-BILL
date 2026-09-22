import assert from 'node:assert/strict';
import test from 'node:test';
import {
  historySyncModeLabel,
  historySyncProgressLabel,
  historySyncStopReasonLabel,
} from '../popup/utils/history-sync-copy.ts';

const preparing = { syncing: true, currentTask: 'page_limit', stoppedReason: 'page_limit', fetchedPages: 0 };

test('initial page_limit is preparation, not a terminal result', () => {
  assert.equal(historySyncProgressLabel(preparing), '正在准备同步');
  assert.equal(historySyncProgressLabel(null), '正在准备同步');
  assert.equal(historySyncProgressLabel({ ...preparing, fetchedPages: 2 }), '正在同步历史记录');
});

test('running, stopping and finalizing remain distinct', () => {
  assert.equal(historySyncProgressLabel({ ...preparing, currentTask: '正在停止同步...' }), '正在停止同步');
  assert.equal(historySyncProgressLabel({ ...preparing, currentTask: 'sync_cancelled' }), '正在停止同步');
  assert.equal(historySyncProgressLabel({ ...preparing, currentTask: 'sync_complete' }), '正在完成本次同步');
});

test('mode copy distinguishes full, incremental and unknown modes', () => {
  assert.equal(historySyncModeLabel('full'), '历史全量同步');
  assert.equal(historySyncModeLabel('incremental'), '历史增量同步');
  assert.equal(historySyncModeLabel(null), '历史同步');
  assert.equal(historySyncModeLabel(undefined), '历史同步');
});

const reasons = [
  ['page_limit', '已到本次扫描上限，较早记录可能尚未同步'],
  ['empty_page_cursor_anomaly', '历史接口返回异常，本次同步未完成'],
  ['cancelled', '已停止本次同步'],
  ['sync_cancelled', '已停止本次同步'],
  ['service_worker_restarted', '同步因扩展重启而中断，可重新同步'],
  ['stale_lock_cleared', '上次同步已中断，可重新同步'],
  ['sync_started', '同步已开始，尚无结束结果'],
  ['already_complete', '此前已完成历史同步'],
  ['no_new_records', '本次未发现新记录，不代表较早记录已全部同步'],
  ['boundary_records_seen', '已扫描到本地已有记录，不代表较早记录已全部同步'],
  ['api_end', '已到历史接口可提供的末尾'],
  ['api_end_empty_page', '已到历史接口可提供的末尾'],
];

for (const [reason, expected] of reasons) {
  test(`stopped result translates ${reason} without claiming full coverage`, () => {
    assert.equal(historySyncStopReasonLabel(reason), expected);
    assert.equal(historySyncProgressLabel({ ...preparing, syncing: false, currentTask: 'sync_complete', stoppedReason: reason }), expected);
  });
}

test('unknown status is never echoed to the popup', () => {
  for (const currentTask of ['unknown_internal_status', '<script>internal</script>', 'constructor', '']) {
    assert.equal(historySyncProgressLabel({ ...preparing, currentTask, fetchedPages: 1 }), '正在同步历史记录');
    assert.equal(historySyncStopReasonLabel(currentTask), '本次同步已结束，完整性尚未确认');
  }
  assert.equal(historySyncStopReasonLabel(undefined), '本次同步已结束，完整性尚未确认');
});
