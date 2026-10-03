import test from 'node:test';
import assert from 'node:assert/strict';
import { renderKnowledgeMarkdown, safeKnowledgeLink } from '../src/shared/open-knowledge/markdown.ts';
test('knowledge Markdown escapes HTML, never loads remote images and previews only safe links', () => {
  const output = renderKnowledgeMarkdown('# 标题\n\n<script>alert(1)</script>\n\n![图片](https://tracker.invalid/a.png)\n\n[来源](https://www.bilibili.com/video/BV1234567890/)\n\n[危险](javascript:alert(1))');
  assert.match(output, /<h1>标题<\/h1>/); assert.doesNotMatch(output, /<script|<img|src="|href="https|href="javascript/);
  assert.match(output, /data-knowledge-link="https:\/\/www.bilibili.com/);
  assert.equal(safeKnowledgeLink('file:///C:/private/note.md'), null);
  assert.equal(safeKnowledgeLink('https://user:secret@example.test/'), null);
  assert.equal(safeKnowledgeLink('../../sources/' + 'a'.repeat(64) + '.json'), '../../sources/' + 'a'.repeat(64) + '.json');
});
