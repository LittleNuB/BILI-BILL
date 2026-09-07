interface Props {
  label: string;
  value: string | number;
  change?: number;
  accent?: string;
}

export function StatCard({ label, value, change, accent }: Props) {
  const cardBg = '#FFFFFF';
  const accentColor = accent ?? '#FB7299';

  return (
    <div style={{
      background: cardBg,
      borderRadius: '6px',
      padding: '14px 16px',
      textAlign: 'center',
      borderLeft: accent ? `3px solid ${accentColor}` : 'none',
    }}>
      <div style={{
        fontSize: '24px',
        fontWeight: 700,
        color: '#18191C',
        lineHeight: 1.3,
      }}>
        {value}
      </div>
      <div style={{ fontSize: '13px', color: '#61666D', marginTop: '2px' }}>
        {label}
      </div>
      {change !== undefined && (
        <div style={{
          fontSize: '11px',
          color: change >= 0 ? '#00D4AA' : '#FF6B6B',
          marginTop: '4px',
        }}>
          {change >= 0 ? '↑' : '↓'} {Math.abs(change)}%
        </div>
      )}
    </div>
  );
}
