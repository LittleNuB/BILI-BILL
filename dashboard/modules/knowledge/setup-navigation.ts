import { pageId } from '../../../src/shared/open-knowledge/format.ts';

export type KnowledgeSetup = 'ai' | 'vision';
const setupKey = 'knowledgeSetup', resumeKey = 'knowledgeResume';

function validPage(value: string | null): string | null {
  try { pageId(value); return value; } catch { return null; }
}
export function knowledgeSetupTarget(search: string): KnowledgeSetup | null {
  const value = new URLSearchParams(search).get(setupKey);
  return value === 'ai' || value === 'vision' ? value : null;
}
export function knowledgeSetupUrl(href: string, target: KnowledgeSetup, selectedId: string, resume: boolean): URL {
  const url = new URL(href), id = validPage(selectedId);
  url.searchParams.set(setupKey, target);
  url.searchParams.delete(resumeKey);
  if (id) {
    url.searchParams.set('knowledgePage', id);
    if (resume) url.searchParams.set(resumeKey, '1');
  } else url.searchParams.delete('knowledgePage');
  url.hash = 'settings';
  return url;
}
export function knowledgeResumePage(search: string): string | null {
  const params = new URLSearchParams(search);
  return params.get(resumeKey) === '1' ? validPage(params.get('knowledgePage')) : null;
}
export function knowledgeNavigationUrl(href: string, destination: string): URL {
  const url = new URL(href), returning = knowledgeSetupTarget(url.search) && destination === 'video-wiki';
  if (destination !== 'settings') url.searchParams.delete(setupKey);
  if (!returning && destination !== 'settings') url.searchParams.delete(resumeKey);
  url.hash = destination;
  return url;
}
export function clearKnowledgeResume(href: string): URL {
  const url = new URL(href);
  url.searchParams.delete(resumeKey);
  return url;
}
