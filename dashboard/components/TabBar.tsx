import { BILI_PINK } from '../../src/shared/constants';

const TABS = ['总览', '偏好', 'UP主', '行为', '盲盒', '智能收藏'];

interface Props {
  activeTab: number;
  onChange: (index: number) => void;
}

export function TabBar({ activeTab, onChange }: Props) {
  return (
    <div style={{
      display: 'flex',
      borderBottom: '1px solid #E3E5E7',
      padding: '0 16px',
      background: '#F6F7F8',
      position: 'sticky',
      top: 0,
      zIndex: 10,
    }}>
      {TABS.map((tab, i) => (
        <button
          key={tab}
          onClick={() => onChange(i)}
          style={{
            padding: '12px 20px',
            background: 'transparent',
            border: 'none',
            borderBottom: activeTab === i ? `2px solid ${BILI_PINK}` : '2px solid transparent',
            color: activeTab === i ? '#18191C' : '#9090A0',
            fontSize: '14px',
            fontWeight: activeTab === i ? 600 : 400,
            cursor: 'pointer',
            transition: 'color 0.2s, border-color 0.2s',
          }}
        >
          {tab}
        </button>
      ))}
    </div>
  );
}
