export function OpenDashboard() {
  const openDashboard = (hash = '') => {
    chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard/index.html${hash}`) });
  };
  return (
    <nav className="popup-nav" aria-label="账单入口">
      <button onClick={() => openDashboard()}>打开总览</button>
      <button onClick={() => openDashboard('#dynamic-bill')}>动态账单</button>
    </nav>
  );
}
