import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearKnowledgeResume, knowledgeNavigationUrl, knowledgeResumePage, knowledgeSetupTarget, knowledgeSetupUrl } from '../dashboard/modules/knowledge/setup-navigation.ts';

const id = 'page-12345678-1234-1234-1234-123456789abc';
const href = 'https://extension.invalid/dashboard/index.html?keep=1#video-wiki';
test('setup and return use only internal routes and identity, preserving draft resume once', () => {
  const setup = knowledgeSetupUrl(href, 'vision', id, true);
  assert.equal(setup.origin, new URL(href).origin);
  assert.equal(setup.pathname, new URL(href).pathname);
  assert.equal(setup.hash, '#settings');
  assert.equal(knowledgeSetupTarget(setup.search), 'vision');
  assert.equal(knowledgeResumePage(setup.search), id);
  const returned = knowledgeNavigationUrl(setup.href, 'video-wiki');
  assert.equal(knowledgeSetupTarget(returned.search), null);
  assert.equal(knowledgeResumePage(returned.search), id);
  const consumed = clearKnowledgeResume(returned.href);
  assert.equal(knowledgeResumePage(consumed.search), null);
  assert.equal(consumed.searchParams.get('knowledgePage'), id);
  assert.equal(consumed.searchParams.get('keep'), '1');
});
test('empty library setup never carries an old selection or a draft marker', () => {
  const url = knowledgeSetupUrl(`${href}&unused`, 'ai', '', true);
  assert.equal(url.searchParams.has('knowledgePage'), false);
  assert.equal(knowledgeResumePage(url.search), null);
});
test('saved page return does not resurrect an old closed draft', () => {
  const url = knowledgeNavigationUrl(knowledgeSetupUrl(href, 'ai', id, false).href, 'video-wiki');
  assert.equal(url.searchParams.get('knowledgePage'), id);
  assert.equal(knowledgeResumePage(url.search), null);
});
test('other navigation clears resume and setup, and arbitrary targets are rejected', () => {
  const url = knowledgeNavigationUrl(knowledgeSetupUrl(href, 'ai', id, true).href, 'smart-favorites');
  assert.equal(knowledgeResumePage(url.search), null);
  assert.equal(knowledgeSetupTarget(url.search), null);
  for (const value of ['https://bad.invalid', 'javascript:alert(1)', '../notes', '']) {
    const setup = knowledgeSetupUrl(href, 'ai', value, true);
    assert.equal(setup.searchParams.has('knowledgePage'), false);
    assert.equal(knowledgeResumePage(`?knowledgeResume=1&knowledgePage=${encodeURIComponent(value)}`), null);
    assert.equal(knowledgeSetupTarget(`?knowledgeSetup=${encodeURIComponent(value)}`), null);
  }
});
