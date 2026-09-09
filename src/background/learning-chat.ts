import type { CurrentVideoQaSourceSnapshot } from '../shared/types/current-video-qa-session.ts';
import { buildLearningChatMessages, chatBudget } from '../shared/learning-chat.ts';
import { readableModelOutput } from '../shared/readable-model-output.ts';
import { unavailableCurrentVideoFullTextQa } from './current-video-full-text-qa.ts';
import { loadConfig } from './storage/config-store.ts';
import { canUseCurrentVideoQaSessionWriteGuard, registerCurrentVideoQaSessionTurnWriteGuard, settleCurrentVideoQaSessionTurnWriteGuard,
  getCurrentVideoQaSessionsView, saveLearningChatPartial, upsertCurrentVideoQaPendingTurn, completeCurrentVideoQaTurn } from './storage/current-video-qa-session-repo.ts';
import { streamLearningChat } from './ai/learning-chat-transport.ts';

interface Running { controller: AbortController; tabId: number | null; sessionId: string; turnId: string; text: string }
const active = new Map<string, Running>();
export function learningChatProgress(requestId: string, tabId: number | null, cancel = false): { text: string } {
  const running = active.get(requestId);
  if (!running || running.tabId !== tabId) return { text: '' };
  if (cancel) running.controller.abort();
  return { text: running.text };
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
    const view = await getCurrentVideoQaSessionsView(input.sessionId);
    const session = view.activeSession?.sessionId === input.sessionId ? view.activeSession : null;
    result.sourceReference = source.source;
    result.title = source.source?.title ?? '学习对话';
    result.sourceLabel = source.text ? source.source?.sourceLabel ?? null : null;
    result.textSize = source.source?.textSize ?? result.textSize;
    result.ai.model = config.ai.chatModel;
    await upsertCurrentVideoQaPendingTurn({ ...input, source: source.source, answerMode: 'learning', writeGuard: guard });
    pending = true;
    const valid = () => !running.controller.signal.aborted && canUseCurrentVideoQaSessionWriteGuard(input.sessionId, guard);
    const liveValid = async () => {
      const live = await loadConfig();
      return valid() && live.assistant.currentVideoAiAssistantEnabled && JSON.stringify(live.ai) === JSON.stringify(config.ai) && await source.stillCurrent();
    };
    const messages = buildLearningChatMessages({ question: input.question, session, retryTurnId: input.turnId,
      videoText: source.text, videoTitle: source.source?.title ?? null, budget: chatBudget(settings.learningChatBudget) });
    if (!await liveValid()) { running.controller.abort(); throw new Error('CHAT_CANCELLED'); }
    await streamLearningChat(config.ai, messages, { signal: running.controller.signal, stream: settings.learningChatStreaming !== false, onText: text => {
      if (!valid()) { running.controller.abort(); return; }
      running.text = readableModelOutput(text, 'qa');
      if (Date.now() - persistedAt > 1000) {
        persistedAt = Date.now(); const partial = running.text;
        persistQueue = persistQueue.then(() => saveLearningChatPartial(input.sessionId, input.turnId, input.requestId, partial, guard))
          .catch(() => { storageFailed = true; running.controller.abort(); });
      }
    } });
    if (!await liveValid()) { running.controller.abort(); throw new Error('CHAT_CANCELLED'); }
    // Prose may mix expansion with video claims; it is never a verified learning snapshot.
    result.status = 'invalid_output'; result.ai.status = 'generated'; result.ai.errorCode = null;
    result.message = source.text ? '参考当前视频，拓展内容由模型补充。' : '一般知识讨论，本次未使用视频字幕。';
    result.canRetry = false;
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    result.status = running.controller.signal.aborted ? 'cancelled' : code === 'CHAT_CONTEXT_LIMIT' ? 'context_too_long' : 'error';
    result.ai.status = result.status === 'context_too_long' ? 'context_too_long' : result.status === 'cancelled' ? 'cancelled' : 'failed';
    result.message = result.status === 'cancelled' ? '已停止，以下内容未完成。'
      : result.status === 'context_too_long' ? '正文和对话超过当前预算。请提高上下文预算或新建对话，原记录仍保留。'
      : '回答未完成，已收到的内容仍保留。可重试或在更多操作中关闭流式输出。';
    if (storageFailed) result.message = '本地保存失败，已停止生成；请先释放会话空间。';
  } finally {
    result.answer = running.text;
    result.generatedAt = Date.now();
    try { await persistQueue; if (pending) await completeCurrentVideoQaTurn(input.sessionId, input.turnId, result, Date.now(), guard); }
    finally { active.delete(input.requestId); settleCurrentVideoQaSessionTurnWriteGuard(guard); }
  }
  return result;
}
