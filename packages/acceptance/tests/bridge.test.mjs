import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { createServer, connect } from 'node:net';
import { startBridge } from '../bridge.mjs';
import { connectSession } from '../client.mjs';
import { encode, receive, MAX_FRAME_BYTES } from '../framing.mjs';
import { htmlReport, verdict } from '../report.mjs';

const id = 'a'.repeat(32), code = 'b'.repeat(48), planHash = 'c'.repeat(64);
test('native framing uses UTF-8 byte length and accepts fragmented/coalesced frames', () => {
  const stream = new PassThrough(), got = [], errors = [];
  receive(stream, v => got.push(v), e => errors.push(e));
  const bytes = Buffer.concat([encode({ text: '中文🙂' }), encode({ next: true })]);
  for (let i = 0; i < bytes.length; i++) stream.write(bytes.subarray(i, i + 1));
  assert.deepEqual(got, [{ text: '中文🙂' }, { next: true }]); assert.deepEqual(errors, []);
});
test('oversized and truncated native frames fail closed', async () => {
  assert.throws(() => encode({ text: 'x'.repeat(MAX_FRAME_BYTES) }), /SIZE/);
  const input = new PassThrough(), errors = []; receive(input, () => assert.fail(), e => errors.push(e.message));
  const header = Buffer.alloc(4); header.writeUInt32LE(MAX_FRAME_BYTES + 1); input.write(header); assert.deepEqual(errors, ['ACCEPTANCE_FRAME_SIZE']);
  const truncated = new PassThrough(); receive(truncated, () => assert.fail(), e => errors.push(e.message)); truncated.end(Buffer.from([1, 0]));
  await new Promise(r => setImmediate(r)); assert.equal(errors.at(-1), 'ACCEPTANCE_FRAME_TRUNCATED');
});
test('separate native and IPC streams pair, reject unapproved commands and isolate reader disconnects', async t => {
  const input = new PassThrough(), output = new PassThrough(), observed = [];
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\bb-acceptance-test-${randomUUID()}` : `/tmp/bb-acceptance-${randomUUID()}.sock`;
  const bridge = startBridge({ input, output, extensionId: id, endpoint }); t.after(bridge.close);
  let readyResolve; const ready = new Promise(r => { readyResolve = r; });
  receive(output, msg => {
    if (msg.ready) { readyResolve(); return; }
    observed.push(msg);
    if (msg.action === 'status') input.write(encode({ id: msg.id, result: { connected: true } }));
    if (msg.action === 'stop') input.write(encode({ id: msg.id, result: { stopped: true } }));
  }, e => assert.fail(e));
  input.write(encode({ hello: 1, extensionId: id, code, planHash, expiresAt: new Date(Date.now() + 60000).toISOString() })); await ready;
  await assert.rejects(connectSession({ extensionId: id, code: 'a'.repeat(48), endpoint }), /DISCONNECTED/);
  const writer = await connectSession({ extensionId: id, code, endpoint }); t.after(writer.close);
  assert.deepEqual(await writer.request('status'), { connected: true });
  await assert.rejects(writer.request('eval', { code: 'arbitrary' }), /INPUT/);
  const running = writer.request('run', { step: 'chat' }); const interrupted = assert.rejects(running, /DISCONNECTED/);
  await new Promise(r => setTimeout(r, 20));
  const reader = await connectSession({ extensionId: id, code, endpoint }); await reader.request('status'); reader.close();
  await new Promise(r => setTimeout(r, 20)); assert.equal(observed.some(m => m.action === 'stop'), false);
  writer.close(); await interrupted; await new Promise(r => setTimeout(r, 20));
  assert.equal(observed.filter(m => m.action === 'stop').length, 1);
});
test('HTML report escapes untrusted model content and never self-awards semantic pass', () => {
  const row = { id: '<script>', state: 'complete', checks: { format: true }, text: '<img onerror=evil()>', model: 'mock' };
  assert.equal(verdict(row), '待审阅');
  row.grade = { scores: [2, 2, 2, 2, 2], hardFactsPass: true, severe: true }; assert.equal(verdict(row), '未通过');
  const html = htmlReport({ plan: { id: 'test', steps: [] }, planHash, legacy: { tokens: 58493, calls: 32, callLimit: 48 }, rows: [row] });
  assert.ok(html.includes('&lt;img onerror=evil()&gt;')); assert.ok(!html.includes('<script>'));
});

test('continuation grant is fixed by approved native handshake, echoed before ready and immutable at checkpoints', async t => {
  const input = new PassThrough(), output = new PassThrough(), checkpoints = [], received = [];
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\bb-acceptance-retry-${randomUUID()}` : `/tmp/bb-acceptance-${randomUUID()}.sock`;
  const bridge = startBridge({ input, output, extensionId: id, endpoint,
    checkpoint: (...args) => checkpoints.push(args) }); t.after(bridge.close);
  let resolve; const ready = new Promise(r => { resolve = r; });
  receive(output, message => { received.push(message); if (message.ready) resolve(); }, e => assert.fail(e));
  const continuation = { planHash, stepIds: ['image'], retainedUnknown: [{ id: 'd'.repeat(64) + ':prior', reservation: 100000 }] };
  const ledgerId = randomUUID();
  input.write(encode({ hello: 1, extensionId: id, code, planHash, ledgerId, charges: [], continuation, expiresAt: new Date(Date.now() + 60000).toISOString() }));
  await ready; assert.equal(received[0].continuationPlanHash, planHash);
  input.write(encode({ checkpoint: 1, id: 'check', charges: [], continuation: { ...continuation, stepIds: ['unapproved'] } }));
  await new Promise(r => setImmediate(r));
  assert.deepEqual(checkpoints.map(c => c[2]), [continuation, continuation]);
});

test('authenticated renewal keeps the task deadline and pauses while expired paid actions stay blocked', async t => {
  const input = new PassThrough(), output = new PassThrough(), commands = [];
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\bb-renew-${randomUUID()}` : `/tmp/bb-renew-${randomUUID()}.sock`;
  const bridge = startBridge({ input, output, extensionId: id, endpoint }); t.after(bridge.close);
  const taskExpiresAt = new Date(Date.now() + 3600000).toISOString();
  let resolve; const ready = new Promise(r => { resolve = r; });
  receive(output, message => {
    if (message.ready) { assert.equal(message.renewalVersion, 1); resolve(); return; }
    commands.push(message);
    const result = message.action === 'renew' ? { autoRenew: true, taskExpiresAt, expiresAt: new Date(Date.now() + 1800000).toISOString() }
      : { pause: 'ACCEPTANCE_USAGE_UNKNOWN', calls: 23 };
    input.write(encode({ id: message.id, result }));
  }, e => assert.fail(e));
  input.write(encode({ hello: 1, extensionId: id, code, planHash, autoRenew: true, taskExpiresAt,
    expiresAt: new Date(Date.now() + 50).toISOString() })); await ready;
  await new Promise(r => setTimeout(r, 70));
  // A raw authenticated client cannot send paid work until the validated lease renewal.
  const raw = connect(endpoint); t.after(() => raw.destroy()); const replies = [];
  receive(raw, m => replies.push(m), e => assert.fail(e)); raw.write(encode({ code }));
  await new Promise(r => setTimeout(r, 10));
  raw.write(encode({ id: 'paid', action: 'run', step: 'chat' }));
  raw.write(encode({ id: 'foreign', action: 'renew', planHash: 'd'.repeat(64) }));
  await new Promise(r => setTimeout(r, 10));
  assert.equal(replies.find(r => r.id === 'paid').error, 'ACCEPTANCE_REVOKED');
  assert.equal(replies.find(r => r.id === 'foreign').error, 'ACCEPTANCE_REVOKED'); assert.deepEqual(commands, []);
  const client = await connectSession({ extensionId: id, code, endpoint }); t.after(client.close);
  assert.deepEqual(await client.request('status'), { pause: 'ACCEPTANCE_USAGE_UNKNOWN', calls: 23 });
  assert.deepEqual(commands.map(c => c.action), ['renew', 'status']);
  assert.equal(client.pairing.taskExpiresAt, taskExpiresAt);
  await client.request('status'); assert.equal(commands.filter(c => c.action === 'renew').length, 1);
});

test('client reconnects idle transport for the next command but never replays a lost running command', async t => {
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\bb-reconnect-${randomUUID()}` : `/tmp/bb-reconnect-${randomUUID()}.sock`;
  const sockets = [], actions = [];
  const server = createServer(socket => {
    sockets.push(socket); let paired = false;
    receive(socket, message => {
      if (!paired) { paired = true; socket.write(encode({ paired: true, planHash, expiresAt: new Date(Date.now() + 600000).toISOString() })); return; }
      actions.push(message.action);
      if (message.action === 'run') socket.destroy(); else socket.write(encode({ id: message.id, result: { ok: true } }));
    }, () => socket.destroy());
  });
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  await new Promise(r => server.listen(endpoint, r));
  const client = await connectSession({ extensionId: id, code, endpoint }); t.after(client.close);
  await client.request('status'); sockets[0].destroy(); await new Promise(r => setTimeout(r, 20));
  await client.request('status'); assert.equal(sockets.length, 2);
  await assert.rejects(client.request('run', { step: 'chat' }), /DISCONNECTED/);
  assert.deepEqual(actions, ['status', 'status', 'run']);
  await client.request('status'); assert.equal(sockets.length, 3);
  assert.deepEqual(actions, ['status', 'status', 'run', 'status']);
});
