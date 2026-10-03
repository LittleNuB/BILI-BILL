import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({ html: false, linkify: false, breaks: true });
export function safeKnowledgeLink(value: string): string | null {
  if (/^\.\.\/\.\.\/sources\/[a-f0-9]{64}\.json$/.test(value)) return value;
  try { const url = new URL(value); return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
markdown.renderer.rules.link_open = (tokens, index) => {
  const link = safeKnowledgeLink(String(tokens[index].attrGet('href') ?? ''));
  return link ? `<a href="#" data-knowledge-link="${markdown.utils.escapeHtml(link)}">` : '<a aria-disabled="true">';
};
markdown.renderer.rules.image = (tokens, index) => `<span class="knowledge-inline-image">[${markdown.utils.escapeHtml(tokens[index].content || '图片')}]</span>`;
export function renderKnowledgeMarkdown(text: string): string {
  // Large source documents remain readable without an expensive Markdown parse.
  if (text.length > 256 * 1024) return `<pre>${markdown.utils.escapeHtml(text)}</pre>`;
  return markdown.render(text);
}
