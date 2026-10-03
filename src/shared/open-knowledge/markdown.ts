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
markdown.renderer.rules.image = (tokens, index, _options, env) => {
  const id = /^\.\.\/\.\.\/attachments\/([a-f0-9]{64})\.(png|jpg|webp)$/.exec(String(tokens[index].attrGet('src') ?? ''))?.[1];
  const url = id ? (env as { images?: Record<string, string | null> } | undefined)?.images?.[id] : undefined, alt = markdown.utils.escapeHtml(tokens[index].content || '学习图片');
  return typeof url === 'string' && url.startsWith('blob:') ? `<img src="${markdown.utils.escapeHtml(url)}" alt="${alt}" loading="lazy">`
    : `<span class="knowledge-inline-image">${id ? url === null ? '图片暂不可用' : '图片加载中' : '外部图片未载入'}</span>`;
};
export function renderKnowledgeMarkdown(text: string, images: Record<string, string | null> = {}): string {
  // Large source documents remain readable without an expensive Markdown parse.
  if (text.length > 256 * 1024) return `<pre>${markdown.utils.escapeHtml(text)}</pre>`;
  return markdown.render(text, { images });
}
export function knowledgeExcerpt(text: string): string {
  return markdown.parse(text.slice(0, 4096), {}).filter(token => token.type === 'inline').map(token => (token.children ?? [])
    .filter(child => ['text', 'code_inline', 'softbreak', 'hardbreak'].includes(child.type)).map(child => child.content || ' ').join('')).join(' ').replace(/\s+/g, ' ').trim().slice(0, 220);
}
