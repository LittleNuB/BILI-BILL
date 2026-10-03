export function OpenDashboard() {
  const openDashboard = (hash = '') => {
    chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard/index.html${hash}`) });
  };
  return (
    <nav className="popup-nav" aria-label="工作台入口">
      <button onClick={() => openDashboard('#video-wiki')}>打开知识库</button>
      <button onClick={() => openDashboard('#overview')}>观看账单</button>
    </nav>
  );
}
