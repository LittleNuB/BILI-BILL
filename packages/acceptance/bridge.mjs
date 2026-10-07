import { createServer } from 'node:net';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { encode, receive } from './framing.mjs';

export function pipePath(extensionId) {
  if (!/^[a-p]{32}$/.test(extensionId)) throw Error('ACCEPTANCE_EXTENSION_ID');
  if (process.platform !== 'win32') throw Error('ACCEPTANCE_WINDOWS_REQUIRED');
  return `\\\\.\\pipe\\bili-bill-acceptance-${extensionId}`;
}
export function startBridge({ input, output, extensionId, endpoint = pipePath(extensionId), checkpoint = () => {} }) {
  let hello = null, listening = false, closed = false;
  const pending = new Map(), sockets = new Set();
  let timer = setTimeout(() => close(), 12000);
  const native = value => { if (!closed) output.write(encode(value)); };
  const close = () => {
    if (closed) return; closed = true; clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    pending.clear(); if (server.listening) server.close();
  };
  const server = createServer(socket => {
    sockets.add(socket); let authenticated = false, busy = false;
    const authTimeout = setTimeout(() => socket.destroy(), 3000);
    const send = value => { if (!socket.destroyed) socket.write(encode(value)); };
    receive(socket, message => {
      if (!hello || Date.now() >= Date.parse(hello.taskExpiresAt ?? hello.expiresAt)) { socket.destroy(); return; }
      if (!authenticated) {
        const code = typeof message.code === 'string' ? Buffer.from(message.code) : Buffer.alloc(0);
        const expected = Buffer.from(hello.code);
        if (Object.keys(message).join() !== 'code' || code.length !== expected.length || !timingSafeEqual(code, expected)) { socket.destroy(); return; }
        authenticated = true; clearTimeout(authTimeout);
        send({ paired: true, planHash: hello.planHash, expiresAt: hello.expiresAt,
          ...(hello.taskExpiresAt ? { autoRenew: true, taskExpiresAt: hello.taskExpiresAt } : {}) }); return;
      }
      if (!['status', 'renew', 'capture', 'run', 'report', 'grade', 'stop', 'revoke'].includes(message.action)
        || !/^[a-zA-Z0-9-]{1,64}$/.test(message.id ?? '') || Object.keys(message).some(k => !['id', 'action', 'planHash', 'target', 'step', 'offset', 'limit', 'hash', 'row', 'grade'].includes(k))) {
        send({ id: message.id, error: 'ACCEPTANCE_INPUT' }); return;
      }
      if (message.action === 'renew' && (!hello.taskExpiresAt || message.planHash !== hello.planHash)) {
        send({ id: message.id, error: 'ACCEPTANCE_REVOKED' }); return;
      }
      if (Date.now() >= Date.parse(hello.expiresAt) && ['capture', 'run', 'grade'].includes(message.action)) {
        send({ id: message.id, error: 'ACCEPTANCE_REVOKED' }); return;
      }
      if ((busy && message.action !== 'stop') || pending.size >= 16) { send({ id: message.id, error: 'ACCEPTANCE_BUSY' }); return; }
      const id = randomUUID();
      pending.set(id, { socket, id: message.id, action: message.action, done: () => { busy = false; } });
      if (message.action !== 'stop') busy = true;
      native({ ...message, id });
    }, () => socket.destroy());
    socket.on('close', () => {
      clearTimeout(authTimeout); sockets.delete(socket);
      let cancel = false;
      for (const [id, request] of pending) if (request.socket === socket) {
        cancel ||= ['run', 'capture'].includes(request.action); pending.delete(id);
      }
      // Closing a reader cannot cancel a different client's generation.
      if (cancel) native({ id: randomUUID(), action: 'stop' });
    });
  });
  server.on('error', close);
  receive(input, message => {
    if (!hello) {
      if (message.hello !== 1 || message.extensionId !== extensionId || !/^[a-f0-9]{48}$/.test(message.code ?? '')
        || !/^[a-f0-9]{64}$/.test(message.planHash ?? '') || !Number.isFinite(Date.parse(message.expiresAt))
        || Date.parse(message.expiresAt) <= Date.now() || Date.parse(message.expiresAt) > Date.now() + 31 * 60000) { close(); return; }
      if (message.continuation && message.continuation.planHash !== message.planHash) { close(); return; }
      if (message.taskExpiresAt !== undefined && (message.autoRenew !== true || !Number.isFinite(Date.parse(message.taskExpiresAt))
        || Date.parse(message.taskExpiresAt) < Date.parse(message.expiresAt)
        || Date.parse(message.taskExpiresAt) > Date.now() + 24 * 60 * 60 * 1000)) { close(); return; }
      try { checkpoint(message.ledgerId, message.charges, message.continuation); } catch { close(); return; }
      hello = message; clearTimeout(timer); timer = setTimeout(close, Date.parse(hello.taskExpiresAt ?? hello.expiresAt) - Date.now());
      server.listen(endpoint, () => { listening = true; native({ ready: true,
        renewalVersion: 1,
        ...(hello.continuation ? { continuationPlanHash: hello.continuation.planHash } : {}) }); }); return;
    }
    if (message.checkpoint === 1) {
      try { checkpoint(hello.ledgerId, message.charges, hello.continuation); native({ checkpointAck: message.id }); }
      catch { native({ checkpointAck: message.id, error: 'ACCEPTANCE_LEDGER_CONFLICT' }); }
      return;
    }
    const request = pending.get(message.id); if (!request) return;
    pending.delete(message.id); request.done();
    if (request.action === 'renew' && !message.error) {
      const grant = message.result;
      if (!grant || grant.autoRenew !== true || grant.taskExpiresAt !== hello.taskExpiresAt
        || !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= Date.now()
        || Date.parse(grant.expiresAt) > Math.min(Date.now() + 31 * 60000, Date.parse(hello.taskExpiresAt))) { close(); return; }
      hello.expiresAt = grant.expiresAt;
    }
    request.socket.write(encode({ id: request.id, ...(typeof message.error === 'string' ? { error: message.error } : { result: message.result }) }));
  }, close);
  input.on('end', close);
  output.on('error', close);
  return { close, ready: () => listening && !closed };
}
