import type { QuickStats } from '../../shared/types/analytics';
import { SIDEBAR_CARD_ID } from './placement';

const STYLE_ID = 'bdc-sidebar-styles';

const CSS = `
.bdc-card {
  background: #1A1A2E;
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 12px;
  color: #e0e0e0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans SC", sans-serif;
  box-shadow: 0 2px 8px rgba(0,0,0,0.3);
}
.bdc-card--feed {
  align-self: stretch;
  box-sizing: border-box;
  min-width: 0;
  margin-bottom: 0;
}
.bdc-card-header {
  font-size: 15px;
  font-weight: 600;
  color: #FB7299;
  margin-bottom: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.bdc-card-header::before {
  content: '';
  display: inline-block;
  width: 4px;
  height: 16px;
  background: #FB7299;
  border-radius: 2px;
}
.bdc-stat-row {
  display: flex;
  justify-content: space-between;
  margin-bottom: 10px;
}
.bdc-stat-item {
  text-align: center;
  flex: 1;
}
.bdc-stat-value {
  font-size: 20px;
  font-weight: 700;
  color: #fff;
  line-height: 1.2;
}
.bdc-stat-label {
  font-size: 11px;
  color: #9090a0;
  margin-top: 2px;
}
.bdc-button {
  display: block;
  width: 100%;
  padding: 8px 0;
  margin-top: 12px;
  background: #FB7299;
  color: #fff;
  border: none;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  text-align: center;
  transition: background 0.2s;
  text-decoration: none;
}
.bdc-button:hover {
  background: #FC8CAB;
}
`;

function formatWatchTime(seconds: number): string {
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}分钟`;
  return `${Math.round((seconds / 3600) * 10) / 10}小时`;
}

export function buildSidebarCard(data: QuickStats): HTMLElement {
  // Inject styles once
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  const card = document.createElement('div');
  card.className = 'bdc-card';
  card.id = SIDEBAR_CARD_ID;

  card.innerHTML = `
    <div class="bdc-card-header">本周消费小结</div>
    <div class="bdc-stat-row">
      <div class="bdc-stat-item">
        <div class="bdc-stat-value">${formatWatchTime(data.todayWatchTime)}</div>
        <div class="bdc-stat-label">今日观看</div>
      </div>
      <div class="bdc-stat-item">
        <div class="bdc-stat-value">${data.streakDays}天</div>
        <div class="bdc-stat-label">连续观看</div>
      </div>
      <div class="bdc-stat-item">
        <div class="bdc-stat-value">${data.efficiencyScore}分</div>
        <div class="bdc-stat-label">效率评分</div>
      </div>
    </div>
    <a class="bdc-button" id="bdc-open-dashboard">查看完整面板 →</a>
  `;

  // Wire button to open dashboard
  const btn = card.querySelector('#bdc-open-dashboard');
  if (btn) {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const dashUrl = chrome.runtime.getURL('dashboard/index.html#overview');
      window.open(dashUrl, '_blank');
    });
  }

  return card;
}
