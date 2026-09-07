import { useEffect, useRef } from 'preact/hooks';

export interface SideNavItem {
  id: string;
  label: string;
  caption: string;
  shortLabel: string;
}

interface Props {
  items: SideNavItem[];
  activeIndex: number;
  onChange: (index: number) => void;
}

export function SideNav({ items, activeIndex, onChange }: Props) {
  const navigation = useRef<HTMLElement>(null);
  useEffect(() => {
    navigation.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeIndex]);
  return (
    <aside className="bb-sidebar" aria-label="Bili-Bill 面板导航">
      <div className="bb-brand">
        <div className="bb-brand-mark" aria-hidden="true">BB</div>
        <div className="bb-brand-text">
          <strong>Bili-Bill</strong>
          <span>个人内容账单</span>
        </div>
      </div>

      <nav className="bb-nav-list" ref={navigation}>
        {items.map((item, index) => (
          <button
            key={item.id}
            className={`bb-nav-item ${activeIndex === index ? 'is-active' : ''}`}
            type="button"
            onClick={() => onChange(index)}
            title={item.label}
            aria-current={activeIndex === index ? 'page' : undefined}
          >
            <span className="bb-nav-copy">
              <strong>{item.label}</strong>
            </span>
          </button>
        ))}
      </nav>

    </aside>
  );
}
