import { useEffect, useState } from 'preact/hooks';
import { Camera, Save, Plug } from 'lucide-preact';
import { visionSettings, VISION_SETTINGS_KEY } from '../../../src/shared/chat-images.ts';
import { requestSW } from '../../utils/messaging.ts';
import type { SettingsConfigSnapshot } from '../../../src/shared/settings-managed-config.ts';
import type { AiConnectionTestResult } from '../../../src/shared/types/config.ts';
export function VisionSettings() {
  const [value, setValue] = useState(visionSettings(null)), [loaded, setLoaded] = useState(false), [status, setStatus] = useState('');
  const [checking, setChecking] = useState(false);
  useEffect(() => { void chrome.storage.local.get(VISION_SETTINGS_KEY).then(rows => { setValue(visionSettings(rows[VISION_SETTINGS_KEY])); setLoaded(true); }).catch(() => setStatus('图片模型设置未读取成功，请刷新。')); }, []);
  async function checkConnection() {
    setChecking(true); setStatus('');
    try {
      const snapshot = await requestSW<SettingsConfigSnapshot>('GET_CONFIG_SNAPSHOT');
      const result = await requestSW<AiConnectionTestResult>('TEST_AI_CONNECTION', { ai: { ...snapshot.config.ai, chatModel: value.model.trim() } });
      setStatus(`模型 ${result.model} 已响应。此检查使用文字消息，不代表图片识别已验证。`);
    } catch { setStatus('连接检查失败，请先保存上方服务配置并检查图片模型名。'); }
    finally { setChecking(false); }
  }
  return <section className="settings-panel" id="knowledge-setup-vision" tabIndex={-1}>
    <div className="settings-section-head"><h3><Camera size={18} /> 图片模型</h3></div>
    <div className="settings-form-grid"><label className="settings-field"><span>图片模型名</span>
      <input value={value.model} maxLength={200} disabled={!loaded || checking} onInput={event => setValue({ ...value, model: event.currentTarget.value })} /></label></div>
    <label className="settings-checkbox"><input type="checkbox" checked={value.enabled} disabled={!loaded}
      onChange={event => setValue({ ...value, enabled: event.currentTarget.checked })} />启用图片解读（此模型需支持图片）</label>
    <p>沿用上方服务地址。仅主动解读或继续相关对话时发送选中的图片；未启用不影响截图保存。</p>
    <div className="settings-actions"><button className="settings-action" type="button" disabled={!loaded || checking || !value.model.trim()} onClick={() => void checkConnection()}><Plug size={16} />{checking ? '检查中…' : '检查模型连接'}</button>
    <button className="settings-action" type="button" disabled={!loaded || checking || value.enabled && !value.model.trim()} onClick={() => {
      void chrome.storage.local.set({ [VISION_SETTINGS_KEY]: visionSettings(value) }).then(() => setStatus('图片模型设置已保存')).catch(() => setStatus('保存未完成，请重试。'));
    }}><Save size={16} /> 保存图片设置</button></div><span role="status">{status}</span>
  </section>;
}
