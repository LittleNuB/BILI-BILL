import type { CurrentVideoQaSourceSnapshot } from '../shared/types/current-video-qa-session.ts';
import { chatBudget } from '../shared/learning-chat.ts';
import { prepareLearningChatContext } from './learning-chat-context.ts';
import { readableModelOutput } from '../shared/readable-model-output.ts';
import { unavailableCurrentVideoFullTextQa } from './current-video-full-text-qa.ts';
import { loadConfig } from './storage/config-store.ts';
import { canUseCurrentVideoQaSessionWriteGuard, registerCurrentVideoQaSessionTurnWriteGuard, settleCurrentVideoQaSessionTurnWriteGuard,
  getCurrentVideoQaSessionsView, saveLearningChatPartial, saveLearningChatContext, upsertCurrentVideoQaPendingTurn, completeCurrentVideoQaTurn } from './storage/current-video-qa-session-repo.ts';
import { streamLearningChat } from './ai/learning-chat-transport.ts';
import { prepareKnowledge, attachKnowledge } from './knowledge-chat.ts';
import { prepareMemory, attachMemory } from './memory-chat.ts';

import { activeLearningChats as active, type RunningLearningChat as Running } from './learning-chat-control.ts';
export function learningChatProgress(requestId: string, tabId: number | null, cancel = false): { text: string; notice?: string } {
  const running = active.get(requestId);
  if (!running || running.tabId !== tabId) return { text: '' };
  if (cancel) running.controller.abort();
  return { text: running.text, notice: running.notice };
}

export async function askLearningChat(input: {
  requestId: string; sessionId: string; turnId: string; question: string; tabId: number | null;
  resolveSource: () => Promise<{ source: CurrentVideoQaSourceSnapshot | null; text: string; stillCurrent: () => Promise<boolean> }>;
}) {
  if (!input.question.trim() || input.question.length > 500 || [input.requestId, input.sessionId, input.turnId].some(id => !id || id.length > 200)) throw new Error('CHAT_INPUT_INVALID');
  if (active.has(input.requestId) || [...active.values()].some(value => value.sessionId === input.sessionId)) throw new Error('CHAT_BUSY');
  const running: Running = { controller: new AbortController(), tabId: input.tabId, sessionId: input.sessionId, turnId: input.turnId, text: '' };
  active.set(input.requestId, running);
  const guard = registerCurrentVideoQaSessionTurnWriteGuard(input);
  const result = unavailableCurrentVideoFullTextQa({ ...input, status: 'error', message: '回答未完成，请重试。' });
  result.answerMode = 'learning';
  let pending = false;
  let persistedAt = 0;
  let persistQueue = Promise.resolve();
  let storageFailed = false;
  let knowledge: Awaited<ReturnType<typeof prepareKnowledge>> | undefined;
  let memory: Awaited<ReturnType<typeof prepareMemory>> | undefined;
  const deadline = setTimeout(() => running.controller.abort(), 240_000);
  try {
    const config = await loadConfig();
    const settings = await chrome.storage.local.get(['learningChatBudget', 'learningChatStreaming']);
    if (!config.assistant.currentVideoAiAssistantEnabled) {
      result.status = 'disabled'; result.message = '请先在设置中开启当前视频 AI 助手。'; return result;
    }
    if (!config.ai.apiKey.trim() || !config.ai.chatModel.trim() || !config.ai.baseURL.trim()) {
      result.status = 'not_configured'; result.message = '请先配置 AI 服务。'; return result;
    }
    const source = await input.resolveSource();
    running.source = source.source;
    if (running.controller.signal.aborted) throw new Error('CHAT_CANCELLED');
    const view = await getCurrentVideoQaSessionsView(input.sessionId);
    const originalSession = view.activeSession?.sessionId === input.sessionId ? view.activeSession : null;
    knowledge = await prepareKnowledge(input.question, originalSession, running.controller);
    memory = await prepareMemory(knowledge.session, running.controller);
    const session = memory.session;
    const inheritedKnowledge = session?.turns.some(t => t.knowledgeStamp) ?? false;
    result.knowledgeStamp = knowledge.stamp && (knowledge.refs.length || inheritedKnowledge) ? knowledge.stamp : undefined;
    result.memoryStamp = memory.stamp && (memory.items.length || session?.turns.some(t => t.memoryStamp)) ? memory.stamp : undefined;
    result.sourceReference = source.source;
    result.title = source.source?.title ?? '学习对话';
    result.sourceLabel = source.text ? source.source?.sourceLabel ?? null : null;
    result.textSize = source.source?.textSize ?? result.textSize;
    result.ai.model = config.ai.chatModel;
    await upsertCurrentVideoQaPendingTurn({ ...input, memoryStamp: result.memoryStamp, knowledgeStamp: result.knowledgeStamp, source: source.source, answerMode: 'learning', writeGuard: guard });
    pending = true;
    const valid = () => !running.controller.signal.aborted && canUseCurrentVideoQaSessionWriteGuard(input.sessionId, guard);
    const liveValid = async () => {
      const live = await loadConfig();
      return valid() && live.assistant.currentVideoAiAssistantEnabled && JSON.stringify(live.ai) === JSON.stringify(config.ai) && await source.stillCurrent();
    };
    const check = async () => { if (!await liveValid()) { running.controller.abort(); throw new Error('CHAT_CANCELLED'); } await knowledge!.check(); await memory!.check(); };
    const context = await prepareLearningChatContext({
      input: { question: input.question, session, retryTurnId: input.turnId,
        videoText: source.text, videoTitle: source.source?.title ?? null, budget: chatBudget(settings.learningChatBudget) },
      sourceIdentity: JSON.stringify(source.source && [source.source.bvid, source.source.cid, source.source.page, source.source.sourceIdentityKey]),
      check,
      notice: text => { running.notice = text; result.contextNotice = text; },
      persist: async state => {
        try { await saveLearningChatContext(input.sessionId, state, guard, valid); }
        catch (error) { storageFailed = valid(); running.controller.abort(); throw error; }
      },
      generate: async messages => readableModelOutput(await streamLearningChat(config.ai, messages, {
        signal: running.controller.signal, stream: settings.learningChatStreaming !== false, onText: () => {}, maxOutputTokens: 1024,
      }), 'qa'),
    });
    const attached = attachKnowledge(context.messages, knowledge.refs, chatBudget(settings.learningChatBudget));
    const remembered = attachMemory(attached.messages, memory.items, chatBudget(settings.learningChatBudget));
    result.knowledgeReferences = attached.refs;
    // Persist provenance before sending so a restart/partial answer cannot lose its knowledge dependency.
    await upsertCurrentVideoQaPendingTurn({ ...input, memoryStamp: result.memoryStamp, knowledgeStamp: result.knowledgeStamp, knowledgeReferences: attached.refs,
      source: source.source, answerMode: 'learning', writeGuard: guard });
    result.contextNotice = [knowledge.notice, memory.notice, memory.enabled ? `本次带入 ${remembered.count} 项目标或偏好。` : '', attached.refs.length ? `本次参考 ${attached.refs.length} 条学习材料，引用可展开核对。` : knowledge.enabled ? '本次未带入知识库材料。' : '', context.notice].filter(Boolean).join(' ') || undefined;
    running.notice = context.notice;
    await check();
    await streamLearningChat(config.ai, remembered.messages, { signal: running.controller.signal, stream: settings.learningChatStreaming !== false, onText: text => {
      if (!valid()) { running.controller.abort(); return; }
      running.text = readableModelOutput(text, 'qa');
      if (Date.now() - persistedAt > 1000) {
        persistedAt = Date.now(); const partial = running.text;
        persistQueue = persistQueue.then(() => saveLearningChatPartial(input.sessionId, input.turnId, input.requestId, partial, guard))
          .catch(() => { storageFailed = true; running.controller.abort(); });
      }
    } });
    await persistQueue;
    await check();
    // Prose may mix expansion with video claims; it is never a verified learning snapshot.
    result.status = 'invalid_output'; result.ai.status = 'generated'; result.ai.errorCode = null;
    result.message = source.text ? '参考当前视频，拓展内容由模型补充。' : '一般知识讨论，本次未使用视频字幕。';
    result.canRetry = context.incomplete;
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    result.status = running.controller.signal.aborted ? 'cancelled' : code === 'CHAT_CONTEXT_LIMIT' ? 'context_too_long' : 'error';
    result.ai.status = result.status === 'context_too_long' ? 'context_too_long' : result.status === 'cancelled' ? 'cancelled' : 'failed';
    result.message = result.status === 'cancelled' ? '已停止，以下内容未完成。'
      : result.status === 'context_too_long' ? '内容超过本地或模型窗口预算。请检查上下文预算设置，原记录仍保留。'
      : '回答未完成，已收到的内容仍保留。可重试或在更多操作中关闭流式输出。';
    if (storageFailed) result.message = '本地保存失败，已停止生成；请先释放会话空间。';
  } finally {
    result.answer = running.text;
    result.generatedAt = Date.now();
    try { await persistQueue; if (pending) await completeCurrentVideoQaTurn(input.sessionId, input.turnId, result, Date.now(), guard); }
    finally { knowledge?.dispose(); memory?.dispose(); clearTimeout(deadline); active.delete(input.requestId); settleCurrentVideoQaSessionTurnWriteGuard(guard); }
  }
  return result;
}
