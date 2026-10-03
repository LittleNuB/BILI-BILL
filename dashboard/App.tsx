import { useEffect, useState } from 'preact/hooks';
import { activeTab } from './signals';
import { requestSW } from './utils/messaging';
import { AppShell } from './components/AppShell';
import { ErrorBoundary } from './components/ErrorBoundary';
import { OverviewPage } from './modules/overview/OverviewPage';
import { DynamicBillPage } from './modules/dynamic-bill/DynamicBillPage';
import { PreferencePage } from './modules/preference/PreferencePage';
import { CreatorPage } from './modules/creator/CreatorPage';
import { BehaviorPage } from './modules/behavior/BehaviorPage';
import { ExperimentsPage } from './modules/experiments/ExperimentsPage';
import { SmartFavoritesPage } from './modules/favorites/SmartFavoritesPage';
import { SettingsPage } from './modules/settings/SettingsPage';
import { LearningPage } from './modules/learning/LearningPage';
import { VideoWikiPage } from './modules/learning/VideoWikiPage';
import type { WatchHistoryRecord } from '../src/shared/types/watch-event';
import type { HistorySyncStatus } from '../src/shared/types/history-sync';
import { NAV_ITEMS, DEFAULT_DASHBOARD_TAB, dashboardIndexForHash } from './navigation.ts';

const PAGES = [
  OverviewPage,
  DynamicBillPage,
  PreferencePage,
  CreatorPage,
  BehaviorPage,
  ExperimentsPage,
  SmartFavoritesPage,
  SettingsPage,
  LearningPage,
  VideoWikiPage,
];

const EXPORT_PAGE_SIZE = 500;

interface ExportDataPage {
  records: WatchHistoryRecord[];
  total: number;
  offset: number;
  nextOffset: number;
  hasMore: boolean;
}

export function App() {
  const activeIndex = PAGES[activeTab.value] ? activeTab.value : DEFAULT_DASHBOARD_TAB;
  const ActivePage = PAGES[activeIndex];
  const [synced, setSynced] = useState('');
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    requestSW<HistorySyncStatus>('GET_SYNC_STATUS').then(s => {
      if (s.lastSyncTime > 0) {
        const d = new Date(s.lastSyncTime);
        setSynced(`已同步 ${s.totalRecords} 条记录 · 最后更新: ${d.toLocaleString('zh-CN')}`);
      } else {
        setSynced('等待首次同步...');
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    function applyHashRoute() {
      const index = dashboardIndexForHash(window.location.hash);
      if (index >= 0 && index !== activeTab.value) {
        if (window.dispatchEvent(new Event('bb-before-navigate', { cancelable: true }))) activeTab.value = index;
        else window.history.replaceState(null, '', `#${NAV_ITEMS[activeTab.value].id}`);
      }
    }

    applyHashRoute();
    window.addEventListener('hashchange', applyHashRoute);
    return () => window.removeEventListener('hashchange', applyHashRoute);
  }, []);

  async function handleExport(format: 'json' | 'csv') {
    setExporting(true);
    try {
      let content: string;
      let mime: string;
      let ext: string;
      let offset = 0;

      if (format === 'csv') {
        const header = 'bvid,title,authorName,tagName,viewAt,progress,duration,completion';
        const chunks: string[] = ['\uFEFF' + header];
        while (true) {
          const page = await requestSW<ExportDataPage>('EXPORT_DATA_PAGE', { offset, limit: EXPORT_PAGE_SIZE });
          chunks.push(...page.records.map(recordToCsvRow));
          offset = page.nextOffset;
          if (!page.hasMore) break;
        }
        content = chunks.join('\n');
        mime = 'text/csv;charset=utf-8';
        ext = 'csv';
      } else {
        const chunks: string[] = ['['];
        let firstRecord = true;
        while (true) {
          const page = await requestSW<ExportDataPage>('EXPORT_DATA_PAGE', { offset, limit: EXPORT_PAGE_SIZE });
          for (const record of page.records) {
            chunks.push(`${firstRecord ? '' : ','}\n${JSON.stringify(record, null, 2)}`);
            firstRecord = false;
          }
          offset = page.nextOffset;
          if (!page.hasMore) break;
        }
        chunks.push(firstRecord ? ']' : '\n]');
        content = chunks.join('');
        mime = 'application/json';
        ext = 'json';
      }

      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `bilibili-history-export.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Export failed:', e);
    } finally {
      setExporting(false);
    }
  }

  function handleNavigate(index: number) {
    if (index !== activeTab.value && !window.dispatchEvent(new Event('bb-before-navigate', { cancelable: true }))) return;
    activeTab.value = index;
    const pageId = NAV_ITEMS[index]?.id ?? NAV_ITEMS[0].id;
    const nextPath = `${window.location.pathname}${window.location.search}#${pageId}`;
    window.history.replaceState(null, '', nextPath);
  }

  return (
    <AppShell
      navItems={NAV_ITEMS}
      activeIndex={activeIndex}
      synced={synced}
      exporting={exporting}
      onNavigate={handleNavigate}
      onExport={handleExport}
    >
      <ErrorBoundary>
        <ActivePage />
      </ErrorBoundary>
    </AppShell>
  );
}

function recordToCsvRow(r: WatchHistoryRecord): string {
  return [r.bvid, r.title, r.authorName, r.tagName, r.viewAt, r.progress, r.duration, Math.round(r.actualCompletion * 100)]
    .map(csvEscape)
    .join(',');
}

function csvEscape(value: string | number | boolean | null | undefined): string {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@]/.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replace(/"/g, '""')}"`;
}
