import { useEffect, useState } from 'preact/hooks';

const isEnabled = (value: unknown) => !!value && typeof value === 'object' && 'enabled' in value && value.enabled === true
  && 'generation' in value && typeof value.generation === 'string' && value.generation.length > 0 && value.generation.length <= 64;

export function KnowledgeAiToggle() {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true; let changed = false;
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes.knowledgeAiAuthorization) { changed = true; setEnabled(isEnabled(changes.knowledgeAiAuthorization.newValue)); }
    };
    chrome.storage.onChanged.addListener(listener);
    void chrome.storage.local.get('knowledgeAiAuthorization').then(values => {
      if (active && !changed) setEnabled(isEnabled(values.knowledgeAiAuthorization));
    }).catch(() => { if (active) setError('授权状态暂不可读取，请重新打开设置。'); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; chrome.storage.onChanged.removeListener(listener); };
  }, []);
  async function toggle(value: boolean) {
    setBusy(true); setError('');
    try { await chrome.storage.local.set({ knowledgeAiAuthorization: { enabled: value, generation: crypto.randomUUID() } }); setEnabled(isEnabled((await chrome.storage.local.get('knowledgeAiAuthorization')).knowledgeAiAuthorization)); }
    catch { setError('授权设置未保存，请重试。'); }
    finally { setBusy(false); }
  }
  return <label className={`settings-toggle ${enabled ? 'is-on' : 'is-off'}`}>
    <input type="checkbox" checked={enabled} disabled={busy} onChange={event => { void toggle(event.currentTarget.checked); }} />
    <span className="settings-toggle-control" aria-hidden="true" />
    <span className="settings-toggle-copy">
      <span className="settings-toggle-title-row"><strong>学习笔记用于 AI 问答</strong><span className="settings-toggle-state">{enabled ? '已开启' : '未开启'}</span></span>
      <small>主动提问时本地查找相关笔记，将有限节选发送到你配置的 AI 服务。即时保存，开启本身不发送内容；需同时开启当前视频 AI 助手。</small>
      <small>关闭后不再带入相关材料及其旧讨论。本地记录保留，已发送内容无法收回。</small>
      {error && <span role="alert">{error}</span>}
    </span>
  </label>;
}
