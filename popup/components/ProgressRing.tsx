import { todayPercent } from '../signals';

export function ProgressRing() {
  const percent = todayPercent.value;
  return (
    <div className="popup-goal">
      <progress max={100} value={Math.min(100, Math.max(0, percent))} aria-label="今日观看目标" />
      <span>{percent}%</span>
    </div>
  );
}
