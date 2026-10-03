import { useEffect, useState } from 'preact/hooks';
import { Camera, Save } from 'lucide-preact';
import { visionSettings, VISION_SETTINGS_KEY } from '../../../src/shared/chat-images.ts';
export function VisionSettings() {
  const [value, setValue] = useState(visionSettings(null)), [loaded, setLoaded] = useState(false), [status, setStatus] = useState('');
  useEffect(() => { void chrome.storage.local.get(VISION_SETTINGS_KEY).then(rows => { setValue(visionSettings(rows[VISION_SETTINGS_KEY])); setLoaded(true); }).catch(() => setStatus('图片模型设置未读取成功，请刷新。')); }, []);
  return <section className="settings-panel">
    <div className="settings-section-head"><h3><Camera size={18} /> 图片模型</h3></div>
    <div className="settings-form-grid"><label className="settings-field"><span>图片模型名</span>
      <input value={value.model} maxLength={200} disabled={!loaded} onInput={event => setValue({ ...value, model: event.currentTarget.value })} /></label></div>
    <label className="settings-checkbox"><input type="checkbox" checked={value.enabled} disabled={!loaded}
      onChange={event => setValue({ ...value, enabled: event.currentTarget.checked })} />启用图片解读（此模型需支持图片）</label>
    <p>沿用上方服务地址。仅主动解读或继续相关对话时发送选中的图片；未启用不影响截图保存。</p>
    <button className="settings-action" type="button" disabled={!loaded || value.enabled && !value.model.trim()} onClick={() => {
      void chrome.storage.local.set({ [VISION_SETTINGS_KEY]: visionSettings(value) }).then(() => setStatus('图片模型设置已保存')).catch(() => setStatus('保存未完成，请重试。'));
    }}><Save size={16} /> 保存图片设置</button><span role="status">{status}</span>
  </section>;
}
