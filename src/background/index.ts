import { setupAlarms, onAlarm } from './sync/scheduler';
import { resumeToolbarScreenshot } from './player-screenshot.ts';
import { syncLatestHistory } from './sync/history-sync';
import { runInitialBackfill } from './sync/initial-backfill';
import { hasActiveHistorySyncAbortScope } from './sync/sync-control';
import { setupMessageHandlers } from './messages/handlers';
import { deleteOlderThan } from './storage/watch-history-repo';
import { clearOrphanedHistorySyncLock, loadConfig } from './storage/config-store';
import { db } from './storage/db';
import { computeDailyAggregate, computeStoredHistoryAggregates } from './analytics/engine';
import { tryRunLocalSettingsWriteOperation } from './storage/local-settings-operation-control';

console.log('[BiliViz] Service Worker started');

const FLOATING_POPUP_WINDOW_KEY = 'floatingPopupWindowId';
const FLOATING_POPUP_URL = chrome.runtime.getURL('popup/index.html');

function isNotLoggedIn(error: unknown): boolean {
  return error instanceof Error && error.message === 'NOT_LOGGED_IN';
}

function isHistorySyncInProgress(error: unknown): boolean {
  return error instanceof Error && error.message === 'HISTORY_SYNC_IN_PROGRESS';
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

// Register alarms for periodic tasks
setupAlarms();

// Listen for alarm events
onAlarm(async (name) => {
  switch (name) {
    case 'history-sync':
      try {
        const storedCount = await db.watchHistory.count();
        const shouldBackfill = storedCount === 0;
        const changed = shouldBackfill
          ? await runInitialBackfill('full', storedCount === 0)
          : await syncLatestHistory();
        const changedCount = typeof changed === 'number'
          ? changed
          : changed.insertedCount + changed.updatedCount;
        if (changedCount > 0) {
          await computeStoredHistoryAggregates(typeof changed === 'number' ? undefined : changed);
        }
      } catch (e) {
        if (isNotLoggedIn(e)) {
          console.info('[BiliViz] History sync skipped: user is not logged in');
        } else if (isHistorySyncInProgress(e)) {
          if (!hasActiveHistorySyncAbortScope()) {
            await clearOrphanedHistorySyncLock();
          }
          console.info('[BiliViz] History sync skipped: another sync is already running');
        } else {
          console.error(`[BiliViz] History sync failed: ${describeError(e)}`);
        }
      }
      break;

    case 'daily-aggregate':
      try {
        await computeDailyAggregate();
      } catch (e) {
        console.error('[BiliViz] Aggregate computation failed:', e);
      }
      break;

    case 'cleanup':
      try {
        const config = await loadConfig();
        const cutoff = Math.floor(Date.now() / 1000) - config.retentionDays * 86_400;
        const deleted = await deleteOlderThan(cutoff);
        if (deleted > 0) {
          console.log(`[BiliViz] Cleanup: deleted ${deleted} old records`);
        }
      } catch (e) {
        console.error('[BiliViz] Cleanup failed:', e);
      }
      break;
  }
});

// Run initial backfill on install
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[BiliViz] Extension installed/updated:', details.reason);
  if (details.reason === 'install') {
    try {
      const result = await runInitialBackfill('full');
      await computeStoredHistoryAggregates(result);
    } catch (e) {
      if (isNotLoggedIn(e)) {
        console.info('[BiliViz] Initial backfill skipped: user is not logged in');
      } else if (isHistorySyncInProgress(e)) {
        if (!hasActiveHistorySyncAbortScope()) {
          await clearOrphanedHistorySyncLock();
        }
        console.info('[BiliViz] Initial backfill skipped: another sync is already running');
      } else {
        console.error(`[BiliViz] Initial backfill failed: ${describeError(e)}`);
      }
    }
  }
});

// Set up message handlers for popup/dashboard/content-script
setupMessageHandlers();

chrome.action.onClicked.addListener(async (tab) => {
  if (await resumeToolbarScreenshot(tab)) return;
  await tryRunLocalSettingsWriteOperation(async () => {
    const stored = await chrome.storage.local.get(FLOATING_POPUP_WINDOW_KEY);
    const existingWindowId = Number(stored[FLOATING_POPUP_WINDOW_KEY] ?? 0);

    if (existingWindowId > 0) {
      try {
        await chrome.windows.update(existingWindowId, { focused: true });
        return;
      } catch {
        await chrome.storage.local.remove(FLOATING_POPUP_WINDOW_KEY);
      }
    }

    const win = await chrome.windows.create({
      url: FLOATING_POPUP_URL,
      type: 'popup',
      width: 560,
      height: 760,
      focused: true,
    });

    if (win?.id !== undefined) {
      await chrome.storage.local.set({ [FLOATING_POPUP_WINDOW_KEY]: win.id });
    }
  });
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  await tryRunLocalSettingsWriteOperation(async () => {
    const stored = await chrome.storage.local.get(FLOATING_POPUP_WINDOW_KEY);
    if (Number(stored[FLOATING_POPUP_WINDOW_KEY] ?? 0) === windowId) {
      await chrome.storage.local.remove(FLOATING_POPUP_WINDOW_KEY);
    }
  });
});
