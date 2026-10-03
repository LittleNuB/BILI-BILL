import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, symlink, link, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { NodeKnowledgeFiles } from '../../open-knowledge/node-files.mjs';
import { KnowledgeDirectory } from '../../../src/shared/open-knowledge/directory.ts';
import { createRevision, jsonBytes } from '../../../src/shared/open-knowledge/format.ts';
import { createProposal } from '../../../src/shared/open-knowledge/proposals.ts';
import { personalPage } from '../../../src/shared/open-knowledge/workspace.ts';
import { KnowledgeAgent } from '../service.mjs';
import { loadConfiguration, readSelectedFile } from '../config.mjs';

const project = fileURLToPath(new URL('../../../', import.meta.url));
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
async function fixture(t, ai = false) {
  const artifacts = join(project, 'release-artifacts'); await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(join(artifacts, 'codex-agent-test-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(artifacts) + '\\') || resolve(root).startsWith(resolve(artifacts) + '/')); await rm(root, { recursive: true, force: true }); });
  const libraryPath = join(root, 'Bili-Bill'); await mkdir(libraryPath);
  const directory = new KnowledgeDirectory(await NodeKnowledgeFiles.open(libraryPath));
  const library = await directory.connect({ create: true });
  const row = await createRevision({ ...personalPage('接口实践'), body: '原始个人结论：保留边界。', aiNotes: '已有补充' }, [], 'browser');
  await directory.append(row);
  const reference = join(root, 'selected.md'); await writeFile(reference, '# 只读资料\n\n独特检索词。');
  const config = { libraryPath, libraryId: library.id, allowAiNotesWrites: ai, readOnlyMarkdown: [{ id: 'selected', path: reference }] };
  const configPath = join(root, 'configuration.json'); await writeFile(configPath, JSON.stringify(config));
  return { root, directory, row, config, configPath, reference, agent: await KnowledgeAgent.open(await loadConfiguration(configPath)) };
}
test('bounded retrieval and immutable references; changes require host confirmation and preserve history', async t => {
  const { agent, directory, row, reference } = await fixture(t);
  assert.equal((await agent.search('边界')).results[0].pageId, row.pageId);
  assert.equal((await agent.search('独特检索词')).results[0].referenceId, 'selected');
  assert.equal((await agent.readPage(row.pageId, { limit: 4 })).text.length, 4);
  await assert.rejects(agent.readReference('../not-selected'), /scope/);
  const original = await readFile(reference);
  const proposal = await agent.propose({ pageId: row.pageId, base: [row.id], changes: { body: '我实践后的新结论。' }, reason: '补充实践' });
  assert.match(proposal.diff, /-原始个人结论/); assert.match(proposal.diff, /\+我实践/);
  await assert.rejects(agent.apply(proposal.proposalId), /confirmation_unavailable/);
  assert.equal((await agent.apply(proposal.proposalId, async () => false)).status, 'not_applied');
  assert.equal((await directory.readPage(row.pageId)).heads[0].id, row.id);
  assert.equal((await agent.apply(proposal.proposalId, async review => !!review.diff)).status, 'applied');
  assert.equal((await agent.apply(proposal.proposalId)).status, 'already_applied');
  let history = await directory.readPage(row.pageId);
  assert.equal(history.revisions.length, 2); assert.equal(history.heads[0].body, '我实践后的新结论。');
  const restore = await agent.propose({ pageId: row.pageId, base: [history.heads[0].id], changes: {}, kind: 'restore', restoreId: row.id, reason: '恢复早先结论' });
  await agent.apply(restore.proposalId, async () => true);
  history = await directory.readPage(row.pageId);
  assert.equal(history.heads[0].body, row.body); assert.equal(history.revisions.length, 3);
  assert.deepEqual(await readFile(reference), original);
});
test('concurrent browser changes invalidate confirmation; AI setting cannot authorize personal text changes', async t => {
  const { agent, directory, row, config } = await fixture(t, true);
  const proposal = await agent.propose({ pageId: row.pageId, base: [row.id], changes: { body: 'Agent 的变更' }, reason: '实践' });
  await assert.rejects(agent.apply(proposal.proposalId, async () => {
    await directory.append(await createRevision({ ...row, body: '浏览器刚保存' }, [row.id], 'browser')); return true;
  }), /conflict/);
  const latest = (await directory.readPage(row.pageId)).heads[0];
  assert.equal(latest.body, '浏览器刚保存');
  const ai = await agent.propose({ pageId: row.pageId, base: [latest.id], changes: { aiNotes: '清楚标注为 AI 的补充' }, reason: 'AI 补充', kind: 'ai' });
  await agent.apply(ai.proposalId);
  const after = (await directory.readPage(row.pageId)).heads[0];
  assert.equal(after.body, latest.body);
  const malicious = await createProposal({ libraryId: config.libraryId, pageId: row.pageId, base: [after.id], next: { ...after, body: '假装只改 AI 区' }, kind: 'ai', restoreId: null, reason: '不应通过', createdAt: Date.now() });
  await directory.files.putImmutable(`proposals/${malicious.id}.json`, jsonBytes(malicious));
  await assert.rejects(agent.apply(malicious.id), /scope/);
  assert.equal((await directory.readPage(row.pageId)).heads[0].body, latest.body);
});
test('selected Markdown readers reject symlink replacement, credentials and unsupported files', async t => {
  const { root, reference, configPath, config } = await fixture(t);
  const other = join(root, 'outside.md'); await writeFile(other, 'not selected');
  await rm(reference); await link(other, reference);
  await assert.rejects(readSelectedFile(reference, 2048), /scope/);
  await rm(reference);
  const linked = join(root, 'linked'); await symlink(root, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readSelectedFile(join(linked, 'outside.md'), 2048), /link/);
  if (process.platform !== 'win32') {
    await symlink(other, reference);
  await assert.rejects(readSelectedFile(reference, 2048), /link/);
  }
  await assert.rejects(readSelectedFile(join(root, 'Key.txt'), 2048), /scope/);
  await writeFile(configPath, JSON.stringify({ ...config, readOnlyMarkdown: [{ id: 'other', path: other.replace('.md', '.json') }] }));
  await assert.rejects(loadConfiguration(configPath), /scope/);
});
test('stdio MCP discovers tools, requests actual host confirmation, and fails closed without it', async t => {
  const { directory, configPath } = await fixture(t);
  for (const support of [true, false]) {
    const client = new Client({ name: 'synthetic-acceptance-client', version: '1.0.0' }, { capabilities: support ? { elicitation: { form: {} } } : {} });
    let confirmations = 0;
    if (support) client.setRequestHandler('elicitation/create', async request => {
      assert.match(request.params.message, /知识页修改确认/); assert.match(request.params.message, /\+stdio 中文笔记/); confirmations++;
      return { action: 'accept', content: { approve: true } };
    });
    const entry = process.env.BB_CODEX_TEST_ENTRY ?? join(packageRoot, 'cli.mjs');
    const transport = new StdioClientTransport({ command: process.execPath, args: [entry, '--config', configPath], stderr: 'pipe' });
    const errors = []; transport.stderr?.on('data', chunk => errors.push(chunk.toString()));
    try {
      await client.connect(transport);
      assert.equal((await client.listTools()).tools.length, 11);
      const read = result => JSON.parse(result.content[0].text);
      const proposal = read(await client.callTool({ name: 'create_page', arguments: { title: '协议测试', body: 'stdio 中文笔记', reason: '合成测试' } }));
      assert.ok(proposal.proposalId);
      const result = await client.callTool({ name: 'apply_proposal', arguments: { proposalId: proposal.proposalId } });
      if (support) {
        assert.equal(read(result).status, 'applied'); assert.equal(confirmations, 1);
        assert.equal((await directory.readPage(proposal.pageId)).heads[0].body, 'stdio 中文笔记');
      } else {
        assert.equal(result.isError, true); assert.equal(read(result).code, 'knowledge_confirmation_unavailable');
        assert.equal((await directory.readPage(proposal.pageId)).heads.length, 0);
      }
      const unknown = await client.callTool({ name: 'read_reference', arguments: { referenceId: 'other', path: '../../Key.txt' } });
      assert.equal(unknown.isError, true);
    } finally { await client.close(); }
  }
});
