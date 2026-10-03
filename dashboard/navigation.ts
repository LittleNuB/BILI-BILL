export interface DashboardNavItem {
  id: string;
  label: string;
  caption: string;
  shortLabel: string;
  group: 'knowledge' | 'sources' | 'tools' | 'settings';
}
// Existing indices stay stable for callers that retain the selected tab in memory.
export const NAV_ITEMS: DashboardNavItem[] = [
  { id: 'overview', label: '观看账单', caption: '观看历史概览', shortLabel: '览', group: 'tools' },
  { id: 'dynamic-bill', label: '动态账单', caption: '兴趣再平衡', shortLabel: '账', group: 'tools' },
  { id: 'preference', label: '内容偏好', caption: '分区与标签', shortLabel: '偏', group: 'tools' },
  { id: 'creator', label: 'UP 主', caption: '创作者关系', shortLabel: 'UP', group: 'tools' },
  { id: 'behavior', label: '观看节奏', caption: '节奏与时段', shortLabel: '行', group: 'tools' },
  { id: 'experiments', label: '视频盲盒', caption: '随机探索', shortLabel: '盒', group: 'tools' },
  { id: 'smart-favorites', label: 'B站收藏夹', caption: '资料来源', shortLabel: '藏', group: 'sources' },
  { id: 'settings', label: '设置', caption: '模型与隐私', shortLabel: '设', group: 'settings' },
  { id: 'learning-notes', label: '笔记与摘录', caption: '已保存的记录', shortLabel: '记', group: 'knowledge' },
  { id: 'video-wiki', label: '知识库', caption: '视频与主题', shortLabel: '知', group: 'knowledge' },
];
export const DEFAULT_DASHBOARD_TAB = 9;
export function dashboardIndexForHash(hash: string): number {
  const index = NAV_ITEMS.findIndex(item => item.id === hash.replace(/^#/, ''));
  return index < 0 ? DEFAULT_DASHBOARD_TAB : index;
}
