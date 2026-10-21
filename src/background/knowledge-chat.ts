import { db } from './storage/db.ts';
import { LearningRepository } from './storage/learning-repo.ts';
import { retrieveKnowledge, retrieveKnowledgeSections, knowledgeSafeSession, type KnowledgeReference } from '../shared/knowledge-chat.ts';
import { retrieveOpenKnowledge, openKnowledgeStamp } from './open-knowledge-chat.ts';
export { attachKnowledge } from '../shared/knowledge-chat.ts';
import type { CurrentVideoQaSessionRecord } from '../shared/types/current-video-qa-session.ts';

const stampOf = (meta: { epoch: number; revision: number } | undefined) => `${meta?.epoch ?? 0}:${meta?.revision ?? 0}`;
const grant = (value: any): string | null => value?.enabled === true && typeof value.generation === 'string' && value.generation.length > 0 && value.generation.length <= 64 ? value.generation : null;
export async function prepareKnowledge(question: string, session: CurrentVideoQaSessionRecord | null, controller: AbortController) {
  const generation = grant((await chrome.storage.local.get('knowledgeAiAuthorization')).knowledgeAiAuthorization);
  const enabled = generation !== null;
  let refs: KnowledgeReference[] = []; let stamp: string | null = null; let failed = false;
  if (enabled) {
    try {
      const state = await new LearningRepository(db).state(), open = await retrieveOpenKnowledge(question);
      stamp = `${generation}:${stampOf(state.meta)}${open.stamp}`;
      refs = retrieveKnowledgeSections(question, [...open.refs, ...retrieveKnowledge(question, state.assets.filter(row => !open.migrated.has(row.id)))]
        .map(ref => ({ ...ref, text: ref.excerpt })));
    } catch { failed = true; stamp = null; refs = []; }
  }
  const safe = knowledgeSafeSession(session, stamp);
  const check = async () => {
    if (controller.signal.aborted) throw Error('CHAT_CANCELLED');
    const live = grant((await chrome.storage.local.get('knowledgeAiAuthorization')).knowledgeAiAuthorization);
    if (live !== generation || (stamp !== null && `${generation}:${stampOf(await db.lgMeta.get('state'))}${await openKnowledgeStamp()}` !== stamp)) {
      controller.abort(); throw Error('CHAT_CANCELLED');
    }
  };
  const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && changes.knowledgeAiAuthorization && grant(changes.knowledgeAiAuthorization.newValue) !== generation) controller.abort();
  };
  chrome.storage.onChanged?.addListener(changed);
  let checking = false;
  const timer = setInterval(() => {
    if (checking) return; checking = true;
    void check().catch(() => controller.abort()).finally(() => { checking = false; });
  }, 250);
  return { session: safe.session, stamp, refs, enabled, check,
    notice: safe.omitted ? '知识授权或材料已变化，本次未带入相关旧讨论；本地记录仍保留。'
      : failed ? '学习笔记暂不可检索，本次继续一般讨论。' : '',
    dispose: () => { clearInterval(timer); chrome.storage.onChanged?.removeListener(changed); },
  };
}
