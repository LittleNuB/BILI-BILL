import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
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
