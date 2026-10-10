import type { ComponentChildren } from 'preact';
import { SideNav, type SideNavItem } from './SideNav';
import { Settings, Download, ArrowLeft } from 'lucide-preact';

interface Props {
  navItems: SideNavItem[];
  activeIndex: number;
  synced: string;
  exporting: boolean;
  children: ComponentChildren;
  onNavigate: (index: number) => void;
  onExport: (format: 'json' | 'csv') => void;
  onReturnToKnowledge?: () => void;
}

export function AppShell({
  navItems,
  activeIndex,
  synced,
  exporting,
  children,
  onNavigate,
  onExport,
  onReturnToKnowledge,
}: Props) {
  const activeItem = navItems[activeIndex] ?? navItems[0];
  const learningSurface = activeItem.id === 'learning-notes' || activeItem.id === 'video-wiki';

  return (
    <div className="bb-shell">
      <SideNav items={navItems} activeIndex={activeIndex} onChange={onNavigate} />
      <main className="bb-workspace">
        <header className="bb-topbar">
          <div className="bb-title-block">
            <span>{activeItem.label}</span>
          </div>
          <div className="bb-topbar-tools">
          {onReturnToKnowledge && <button type="button" className="bb-return-knowledge" onClick={onReturnToKnowledge}><ArrowLeft size={17} />返回知识库</button>}
          {activeItem.group === 'tools' && <>
            {synced && <div className="bb-sync-status">{synced}</div>}
            <div className="bb-export-actions" aria-label="导出本地历史">
              <button type="button" onClick={() => onExport('json')} disabled={exporting}>
                <Download size={15} aria-hidden="true" />
                {exporting ? '导出中...' : '导出 JSON'}
              </button>
              <button type="button" onClick={() => onExport('csv')} disabled={exporting}>
                导出 CSV
              </button>
            </div>
          </>}
          {activeItem.group !== 'settings' && <button className="bb-icon-action" type="button" title="设置" aria-label="设置" onClick={() => onNavigate(navItems.findIndex(item => item.id === 'settings'))}><Settings size={19} aria-hidden="true" /></button>}
          </div>
        </header>
        <section className={`bb-page-frame${learningSurface ? ' bb-page-frame-learning' : ''}`}>
          {children}
        </section>
      </main>
    </div>
  );
}
