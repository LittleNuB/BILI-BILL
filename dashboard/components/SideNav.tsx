import { useEffect, useRef, useState } from 'preact/hooks';
import { Library, NotebookPen, FolderClosed, Settings, ChartNoAxesCombined, Clock3, Users, Shuffle, Compass, PanelsTopLeft, ChevronRight } from 'lucide-preact';
import type { DashboardNavItem } from '../navigation.ts';
export type SideNavItem = DashboardNavItem;
const icons = { 'video-wiki': Library, 'learning-notes': NotebookPen, 'smart-favorites': FolderClosed, settings: Settings,
  overview: ChartNoAxesCombined, 'dynamic-bill': Compass, preference: PanelsTopLeft, creator: Users, behavior: Clock3, experiments: Shuffle };

interface Props {
  items: SideNavItem[];
  activeIndex: number;
  onChange: (index: number) => void;
}

export function SideNav({ items, activeIndex, onChange }: Props) {
  const navigation = useRef<HTMLElement>(null);
  const [toolsOpen, setToolsOpen] = useState(items[activeIndex]?.group === 'tools');
  useEffect(() => {
    if (items[activeIndex]?.group === 'tools') setToolsOpen(true);
    navigation.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeIndex]);
  const itemButton = (item: SideNavItem) => {
    const index = items.indexOf(item), Icon = icons[item.id as keyof typeof icons] ?? Library;
    return <button key={item.id} className={`bb-nav-item ${activeIndex === index ? 'is-active' : ''}`} type="button"
      onClick={() => onChange(index)} title={item.label} aria-current={activeIndex === index ? 'page' : undefined}>
      <Icon size={19} strokeWidth={1.7} aria-hidden="true" /><span className="bb-nav-copy"><strong>{item.label}</strong></span>
    </button>;
  };
  return (
    <aside className="bb-sidebar" aria-label="Bili-Bill 面板导航">
      <div className="bb-brand">
        <div className="bb-brand-text">
          <strong>Bili-Bill</strong>
          <span>我的学习空间</span>
        </div>
      </div>

      <nav className="bb-nav-list" ref={navigation}>
        <div className="bb-nav-group"><span className="bb-nav-label">我的知识</span>
          {[...items].filter(item => item.group === 'knowledge').reverse().map(itemButton)}
        </div>
        <div className="bb-nav-group"><span className="bb-nav-label">资料来源</span>
          {items.filter(item => item.group === 'sources').map(itemButton)}
        </div>
        <div className="bb-nav-group bb-secondary-nav">
          <button type="button" className="bb-nav-item" aria-expanded={toolsOpen} aria-controls="bb-more-tools" onClick={() => setToolsOpen(!toolsOpen)}>
            <PanelsTopLeft size={19} strokeWidth={1.7} aria-hidden="true" /><span className="bb-nav-copy"><strong>更多工具</strong></span>
            <ChevronRight size={16} className={toolsOpen ? 'is-open' : ''} aria-hidden="true" />
          </button>
          {toolsOpen && <div id="bb-more-tools" className="bb-tools-list">{items.filter(item => item.group === 'tools').map(itemButton)}</div>}
          {items.filter(item => item.group === 'settings').map(itemButton)}
        </div>
      </nav>

    </aside>
  );
}
