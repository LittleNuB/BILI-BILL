import { connect } from 'node:net';
import { randomUUID, createHash } from 'node:crypto';
import { encode, receive } from './framing.mjs';
import { pipePath } from './bridge.mjs';

export async function connectSession({ extensionId, code, endpoint = pipePath(extensionId), timeout = 130000 }) {
  if (!/^[a-f0-9]{48}$/.test(code ?? '')) throw Error('ACCEPTANCE_PAIR_CODE');
  let socket, connecting, renewing, pairing, closed = false;
  const pending = new Map();
  const open = () => {
    if (closed) return Promise.reject(Error('ACCEPTANCE_DISCONNECTED'));
    if (connecting) return connecting;
    if (socket && !socket.destroyed) return Promise.resolve();
    connecting = new Promise((resolve, reject) => {
      const current = connect(endpoint); socket = current; let paired = false;
      const deadline = setTimeout(() => { reject(Error('ACCEPTANCE_PAIR_TIMEOUT')); current.destroy(); }, 12000);
      receive(current, message => {
        if (!paired) {
          if (message.paired !== true || !/^[a-f0-9]{64}$/.test(message.planHash ?? '')
            || !Number.isFinite(Date.parse(message.expiresAt)) || (pairing && pairing.planHash !== message.planHash)
            || (pairing?.autoRenew && pairing.taskExpiresAt !== message.taskExpiresAt)) { current.destroy(); return; }
          paired = true; pairing = message; clearTimeout(deadline); resolve(); return;
        }
        const p = pending.get(message.id); if (!p || p.socket !== current) return;
        pending.delete(message.id); clearTimeout(p.timer);
        if (message.error) p.reject(Error(/^ACCEPTANCE_[A-Z_]+$|^CHAT_[A-Z_]+$|^AI_[A-Z_]+(?:_\d{3})?$/.test(message.error) ? message.error : 'ACCEPTANCE_REQUEST_FAILED'));
        else p.resolve(message.result);
      }, () => current.destroy());
      current.once('connect', () => current.write(encode({ code })));
      current.on('error', () => { reject(Error('ACCEPTANCE_DISCONNECTED')); current.destroy(); });
      current.on('close', () => {
        clearTimeout(deadline); reject(Error('ACCEPTANCE_DISCONNECTED'));
        for (const [id, p] of pending) if (p.socket === current) {
          clearTimeout(p.timer); p.reject(Error('ACCEPTANCE_DISCONNECTED')); pending.delete(id);
        }
      });
    }).finally(() => { connecting = null; });
    return connecting;
  };
  const send = (action, params = {}) => new Promise((resolve, reject) => {
    const current = socket;
    if (closed || !current || current.destroyed) { reject(Error('ACCEPTANCE_DISCONNECTED')); return; }
    const id = randomUUID(), timer = setTimeout(() => { pending.delete(id); reject(Error('ACCEPTANCE_TIMEOUT')); current.destroy(); }, timeout);
    pending.set(id, { resolve, reject, timer, socket: current });
    try { current.write(encode({ ...params, id, action })); }
    catch { clearTimeout(timer); pending.delete(id); reject(Error('ACCEPTANCE_INPUT')); }
  });
  const renew = async () => {
    await open();
    if (!pairing.autoRenew || Date.now() >= Date.parse(pairing.taskExpiresAt)) throw Error('ACCEPTANCE_REVOKED');
    if (!renewing) renewing = send('renew', { planHash: pairing.planHash }).then(result => {
      if (result?.autoRenew !== true || result.taskExpiresAt !== pairing.taskExpiresAt
        || !Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt) <= Date.now()
        || Date.parse(result.expiresAt) > Math.min(Date.now() + 31 * 60000, Date.parse(pairing.taskExpiresAt))) throw Error('ACCEPTANCE_SESSION_INVALID');
      pairing = { ...pairing, ...result }; return result;
    }).finally(() => { renewing = null; });
    return renewing;
  };
  const request = async (action, params = {}) => {
    // Reconnect only before a new command. A lost response never replays a command.
    await open();
    if (action === 'renew') return renew();
    if (!['stop', 'revoke', 'report'].includes(action) && pairing.autoRenew
      && Date.parse(pairing.expiresAt) - Date.now() < 60000) await renew();
    return send(action, params);
  };
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
  await open();
  return { request, report, renew, get pairing() { return pairing; }, close: () => { closed = true; socket?.end(); } };
}
