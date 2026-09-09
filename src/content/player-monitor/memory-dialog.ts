import { memoryError, type MemoryOperation, type MemoryState } from '../../shared/explicit-memory.ts';

type RequestMemory = (input: MemoryOperation) => Promise<MemoryState>;
function modal(title: string) {
  document.querySelector<HTMLDialogElement>('.bdc-memory-modal')?.close();
  const dialog = document.createElement('dialog'); dialog.className = 'bdc-memory-modal';
  dialog.style.cssText = 'width:min(420px,calc(100vw - 32px));box-sizing:border-box;max-height:85vh;overflow:auto;padding:20px;border:1px solid #e3e5e7;border-radius:8px;background:#fff;color:#18191c;font:14px/1.6 system-ui;letter-spacing:0;color-scheme:light';
  const heading = document.createElement('h3'); heading.textContent = title; heading.id = 'bdc-memory-modal-heading';
  heading.style.cssText = 'font-size:16px;margin:0 0 12px'; dialog.setAttribute('aria-labelledby', heading.id); dialog.append(heading);
  document.body.append(dialog); dialog.addEventListener('close', () => dialog.remove(), { once: true });
  return dialog;
}
function command(text: string, action: () => void) {
  const node = document.createElement('button'); node.type = 'button'; node.textContent = text;
  node.style.cssText = 'padding:7px 12px;border:1px solid #e3e5e7;border-radius:6px;background:#f6f7f8;color:#18191c;font:inherit;cursor:pointer';
  node.addEventListener('click', action); return node;
}
export async function showRememberDialog(text: string, sessionId: string, request: RequestMemory): Promise<void> {
  const dialog = modal('记住目标或偏好');
  const form = document.createElement('form'); form.style.cssText = 'display:grid;gap:12px'; dialog.append(form);
  const kindLabel = document.createElement('label'); kindLabel.textContent = '类型';
  const kind = document.createElement('select'); kind.setAttribute('aria-label', '记忆类型');
  kind.style.cssText = 'margin-left:8px;padding:5px 8px;border:1px solid #e3e5e7;border-radius:6px;background:#f6f7f8;color:#18191c;font:inherit';
  for (const [value, label] of [['preference', '回答偏好'], ['goal', '学习目标']]) { const option = document.createElement('option'); option.value = value; option.textContent = label; kind.append(option); }
  kindLabel.append(kind); form.append(kindLabel);
  const label = document.createElement('label'); label.textContent = '记忆内容';
  const input = document.createElement('textarea'); input.value = text; input.required = true; input.maxLength = 512;
  input.setAttribute('aria-label', '记忆内容'); input.style.cssText = 'display:block;box-sizing:border-box;width:100%;min-height:110px;padding:10px;border:1px solid #e3e5e7;border-radius:6px;background:#f6f7f8;color:#18191c;font:inherit;resize:vertical'; label.append(input); form.append(label);
  const useLabel = document.createElement('label'); const selected = document.createElement('input'); selected.type = 'checkbox'; useLabel.append(selected, ' 选用于后续对话'); form.append(useLabel);
  const info = document.createElement('p'); info.style.cssText = 'margin:0;color:#61666d;font-size:12px';
  info.textContent = '最多 512 字节，约 170 个汉字。不要保存密码、密钥或登录信息。用于 AI 还需在设置中单独开启记忆授权。'; form.append(info);
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.style.cssText = 'margin:0;color:#61666d'; form.append(status);
  const actions = document.createElement('div'); actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
  const submit = command('确认记住', () => {}); submit.type = 'submit'; submit.disabled = true;
  const cancel = command('取消', () => dialog.close());
  const refresh = command('刷新并保留草稿', () => { void read(); }); refresh.hidden = true;
  actions.append(submit, cancel, refresh); form.append(actions);
  let revision = 0; let busy = false; let saved = false;
  async function read() {
    try { const state = await request({ op: 'read' }); revision = state.revision; submit.disabled = false; refresh.hidden = true; status.textContent = ''; }
    catch (error) { status.textContent = memoryError(error); refresh.hidden = false; }
  }
  dialog.addEventListener('cancel', event => { if (busy || (!saved && input.value.trim() && !window.confirm('放弃当前记忆草稿？'))) event.preventDefault(); });
  form.addEventListener('submit', event => {
    event.preventDefault(); if (busy || saved) return; busy = true; submit.disabled = true; cancel.disabled = true;
    void request({ op: 'save', revision, draft: { kind: kind.value as 'goal' | 'preference', text: input.value, selected: selected.checked, originSessionId: sessionId } })
      .then(() => { saved = true; status.textContent = '已记住。可在设置的「目标与偏好」中管理。'; submit.hidden = true; refresh.hidden = true; cancel.textContent = '完成'; input.disabled = true; kind.disabled = true; selected.disabled = true; })
      .catch(error => { status.textContent = memoryError(error); refresh.hidden = !String(error).includes('MEMORY_STALE'); })
      .finally(() => { busy = false; submit.disabled = false; cancel.disabled = false; });
  });
  dialog.showModal(); input.focus(); await read();
}
export function confirmDeleteChatMemory(): Promise<{ deleteAssociatedMemory: boolean } | null> {
  return new Promise(resolve => {
    const dialog = modal('删除这个本地会话？');
    const text = document.createElement('p'); text.textContent = '默认保留已独立保存的目标与偏好。'; dialog.append(text);
    const label = document.createElement('label'); const check = document.createElement('input'); check.type = 'checkbox'; label.append(check, ' 同时删除从此会话保存的关联记忆'); dialog.append(label);
    const actions = document.createElement('div'); actions.style.cssText = 'display:flex;gap:8px;margin-top:16px';
    let answer: { deleteAssociatedMemory: boolean } | null = null;
    actions.append(command('取消', () => dialog.close()), command('确认删除', () => { answer = { deleteAssociatedMemory: check.checked }; dialog.close(); })); dialog.append(actions);
    dialog.addEventListener('close', () => resolve(answer), { once: true }); dialog.showModal();
  });
}
