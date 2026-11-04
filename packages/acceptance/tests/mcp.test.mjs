import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { startBridge } from '../bridge.mjs';
import { encode, receive } from '../framing.mjs';

test('MCP stdio process reaches paired native broker and exposes only finite tools', async t => {
  const extensionId = 'b'.repeat(32), code = 'a'.repeat(48), input = new PassThrough(), output = new PassThrough();
  const bridge = startBridge({ input, output, extensionId }); t.after(bridge.close);
  let resolveReady; const ready = new Promise(r => { resolveReady = r; });
  const commands = [];
  receive(output, message => {
    if (message.ready) { resolveReady(); return; }
    commands.push(message); input.write(encode({ id: message.id, result: { mock: true, action: message.action } }));
  }, error => assert.fail(error));
  input.write(encode({ hello: 1, extensionId, code, planHash: 'c'.repeat(64), expiresAt: new Date(Date.now() + 60000).toISOString() })); await ready;
  const entry = process.env.BB_ACCEPTANCE_MCP_ENTRY ?? fileURLToPath(new URL('../server-entry.mjs', import.meta.url));
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, '--extension-id', extensionId, '--code', code, '--output', process.cwd()], stderr: 'pipe' });
  const client = new Client({ name: 'offline-test', version: '1.0' }); t.after(() => client.close()); await client.connect(transport);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ['acceptance_capture', 'acceptance_export_report', 'acceptance_grade', 'acceptance_read_report', 'acceptance_run_step', 'acceptance_status', 'acceptance_stop'].sort());
  assert.equal((await client.callTool({ name: 'acceptance_status', arguments: {} })).structuredContent.mock, true);
  const invalid = await client.callTool({ name: 'acceptance_run_step', arguments: { step: 'chat', eval: 'x' } });
  assert.equal(invalid.isError, true); assert.equal(commands.length, 1);
  const result = await client.callTool({ name: 'acceptance_run_step', arguments: { step: 'chat' } });
  assert.equal(result.structuredContent.action, 'run'); assert.equal(commands.length, 2);
  assert.ok(!listed.tools.some(tool => /authorize|read_file|settings|key|eval$/.test(tool.name)));
});
