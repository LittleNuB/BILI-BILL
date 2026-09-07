import type { ComponentChildren } from 'preact';
import { SideNav, type SideNavItem } from './SideNav';

interface Props {
  navItems: SideNavItem[];
  activeIndex: number;
  synced: string;
  exporting: boolean;
  children: ComponentChildren;
  onNavigate: (index: number) => void;
  onExport: (format: 'json' | 'csv') => void;
}

export function AppShell({
  navItems,
  activeIndex,
  synced,
  exporting,
  children,
  onNavigate,
  onExport,
}: Props) {
  const activeItem = navItems[activeIndex] ?? navItems[0];

  return (
    <div className="bb-shell">
      <SideNav items={navItems} activeIndex={activeIndex} onChange={onNavigate} />
      <main className="bb-workspace">
        <header className="bb-topbar">
          <div className="bb-title-block">
            <span>面板 / {activeItem.label}</span>
            <h1>Bili-Bill</h1>
          </div>
          <div className="bb-topbar-tools">
            {synced && <div className="bb-sync-status">{synced}</div>}
            <div className="bb-export-actions" aria-label="导出本地历史">
              <button type="button" onClick={() => onExport('json')} disabled={exporting}>
                {exporting ? '导出中...' : '导出 JSON'}
              </button>
              <button type="button" onClick={() => onExport('csv')} disabled={exporting}>
                导出 CSV
              </button>
            </div>
          </div>
        </header>
        <section className={`bb-page-frame${activeItem.id === 'learning-notes' ? ' bb-page-frame-learning' : ''}`}>
          {children}
        </section>
      </main>
    </div>
  );
}
