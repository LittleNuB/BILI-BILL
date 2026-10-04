import type { KnowledgeReference } from '../../shared/knowledge-chat.ts';
import { stableDigestHex } from '../../shared/stable-digest.ts';
import type { LearningAsset } from '../../shared/learning.ts';
import { requestLearning } from './learning-request.ts';
import { renderKnowledgeMarkdown } from '../../shared/open-knowledge/markdown.ts';

export function appendKnowledgeAnswer(parent: HTMLElement, answer: string, references: KnowledgeReference[], visible: (text: string) => string): void {
  const body = document.createElement('div'); body.className = 'bdc-chat-answer'; parent.append(body);
  body.innerHTML = renderKnowledgeMarkdown(visible(answer));
  body.addEventListener('click', event => {
    const link = (event.target as Element).closest<HTMLAnchorElement>('a');
    if (!link) return;
    event.preventDefault();
    const url = link.dataset.knowledgeLink;
    if (url && /^https?:\/\//.test(url) && window.confirm(`打开外部链接？\n${url}`)) window.open(url, '_blank', 'noopener,noreferrer');
  });
  if (!references.length) return;
  const refs = references.slice(0, 6).filter(r => /^[a-f0-9]{64}$/.test(r.id));
  let preview: HTMLElement | null = null;
  const show = async (ref: KnowledgeReference) => {
    preview?.remove();
    const panel = document.createElement('div'); panel.className = 'bdc-knowledge-preview';
    panel.setAttribute('role', 'region'); panel.setAttribute('aria-label', `知识引用 ${ref.number}`); preview = panel; body.after(panel);
    const close = document.createElement('button'); close.type = 'button'; close.className = 'bdc-assistant-button bdc-assistant-icon-button';
    close.textContent = '×'; close.title = '关闭引用'; close.setAttribute('aria-label', close.title); close.onclick = () => panel.remove(); panel.append(close);
    const title = document.createElement('strong'); title.textContent = visible(ref.title || '学习笔记'); panel.append(title);
    const source = document.createElement('p'); source.textContent = visible(`${ref.label} · ${ref.videoTitle}${ref.page ? ` · P${ref.page}` : ''}`); panel.append(source);
    const excerpt = document.createElement('blockquote'); excerpt.textContent = visible(ref.excerpt); panel.append(excerpt);
    const status = document.createElement('small'); status.textContent = '正在核对保存条目…'; panel.append(status);
    try {
      if (ref.location) {
        const result = await requestLearning<{ available: boolean; current: boolean }>('KNOWLEDGE_REFERENCE_STATUS', { ...ref.location, digest: ref.digest });
        if (!panel.isConnected) return;
        status.textContent = !result.available ? '原资料暂不可用；以上为回答时的节选。' : result.current
          ? '保存内容节选；模型解读仍需核对。' : '原资料已有更新；以上为回答时的节选。';
        if (result.available) {
          const link = document.createElement('a'); link.className = 'bdc-assistant-link'; link.textContent = '打开完整条目';
          const url = new URL(chrome.runtime.getURL('dashboard/index.html'));
          if (ref.location.kind === 'page') { url.searchParams.set('knowledgePage', ref.location.pageId); url.hash = 'video-wiki'; }
          else { url.searchParams.set('knowledgeReference', ref.location.referenceId); url.hash = 'smart-favorites'; }
          link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; panel.append(link);
        }
        return;
      }
      const row = await requestLearning<LearningAsset | null>('LEARNING_GET', { id: ref.id });
      if (!panel.isConnected) return;
      status.textContent = !row ? '原条目已删除；以上为本次回答保存时的节选。' : stableDigestHex(JSON.stringify(row)) === ref.digest
        ? '保存内容节选；模型对材料的解读仍需核对。' : '原条目已有更新；以上为本次回答保存时的节选。';
      if (row) {
        const link = document.createElement('a'); link.className = 'bdc-assistant-link'; link.textContent = '打开完整条目';
        const url = new URL(chrome.runtime.getURL('dashboard/index.html')); url.searchParams.set('learningAsset', ref.id); url.hash = 'learning-notes';
        link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; panel.append(link);
      }
    } catch { status.textContent = '暂时无法核对原条目；以上为保存时的节选。'; }
  };
  // Insert verified citation controls into prose, not code blocks or links.
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT), nodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.parentElement?.closest('code,pre,a,button')) nodes.push(node);
  }
  for (const node of nodes) {
    const text = node.data, fragment = document.createDocumentFragment(); let offset = 0;
    for (const match of text.matchAll(/\[(\d{1,2})\]/g)) {
      fragment.append(document.createTextNode(text.slice(offset, match.index)));
      const ref = refs.find(r => r.number === Number(match[1]));
      if (ref) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'bdc-knowledge-citation';
        button.textContent = match[0]; button.title = visible(ref.title || ref.label); button.setAttribute('aria-label', `查看知识引用 ${ref.number}`);
        button.onclick = () => { void show(ref); }; fragment.append(button);
      } else fragment.append(document.createTextNode(`${match[0]}（未关联来源）`));
      offset = match.index! + match[0].length;
    }
    fragment.append(document.createTextNode(text.slice(offset))); node.replaceWith(fragment);
  }
}
