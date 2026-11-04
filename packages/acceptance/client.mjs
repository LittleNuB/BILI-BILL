import { connect } from 'node:net';
import { randomUUID, createHash } from 'node:crypto';
import { encode, receive } from './framing.mjs';
import { pipePath } from './bridge.mjs';

export async function connectSession({ extensionId, code, endpoint = pipePath(extensionId), timeout = 130000 }) {
  if (!/^[a-f0-9]{48}$/.test(code ?? '')) throw Error('ACCEPTANCE_PAIR_CODE');
  const socket = connect(endpoint), pending = new Map(); let paired = false;
  const fail = () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('ACCEPTANCE_DISCONNECTED')); } pending.clear(); };
  let pairResolve, pairReject;
  const ready = new Promise((resolve, reject) => { pairResolve = resolve; pairReject = reject; });
  const deadline = setTimeout(() => { pairReject(Error('ACCEPTANCE_PAIR_TIMEOUT')); socket.destroy(); }, 12000);
  receive(socket, message => {
    if (!paired) {
      if (message.paired !== true) { socket.destroy(); return; }
      paired = true; clearTimeout(deadline); pairResolve(message); return;
    }
    const p = pending.get(message.id); if (!p) return;
    pending.delete(message.id); clearTimeout(p.timer);
    if (message.error) p.reject(Error(/^ACCEPTANCE_[A-Z_]+$|^CHAT_[A-Z_]+$|^AI_[A-Z_]+(?:_\d{3})?$/.test(message.error) ? message.error : 'ACCEPTANCE_REQUEST_FAILED'));
    else p.resolve(message.result);
  }, () => socket.destroy());
  socket.once('connect', () => socket.write(encode({ code })));
  socket.on('error', () => { pairReject(Error('ACCEPTANCE_DISCONNECTED')); fail(); });
  socket.on('close', () => { clearTimeout(deadline); pairReject(Error('ACCEPTANCE_DISCONNECTED')); fail(); });
  const pairing = await ready;
  const request = (action, params = {}) => new Promise((resolve, reject) => {
    if (socket.destroyed) { reject(Error('ACCEPTANCE_DISCONNECTED')); return; }
    const id = randomUUID(), timer = setTimeout(() => { pending.delete(id); reject(Error('ACCEPTANCE_TIMEOUT')); socket.destroy(); }, timeout);
    pending.set(id, { resolve, reject, timer });
    try { socket.write(encode({ ...params, id, action })); }
    catch { clearTimeout(timer); pending.delete(id); reject(Error('ACCEPTANCE_INPUT')); }
  });
  const report = async () => {
    let offset = 0, hash, text = '';
    do {
      const part = await request('report', { offset, limit: 12000, ...(hash ? { hash } : {}) });
      if (part.offset !== offset || typeof part.text !== 'string' || part.text.length > 12000 || (hash && hash !== part.hash)
        || !Number.isSafeInteger(part.total) || part.total > 32 * 1024 * 1024) throw Error('ACCEPTANCE_REPORT_INVALID');
      hash = part.hash; text += part.text; offset = part.nextOffset;
      if (offset !== null && (offset !== text.length || part.text.length === 0)) throw Error('ACCEPTANCE_REPORT_INVALID');
      if (text.length > part.total || (offset === null && text.length !== part.total)) throw Error('ACCEPTANCE_REPORT_INVALID');
    } while (offset !== null);
    if (createHash('sha256').update(text).digest('hex') !== hash) throw Error('ACCEPTANCE_REPORT_INVALID');
    return JSON.parse(text);
  };
  return { request, report, pairing, close: () => socket.end() };
}
