import { streamLearningChat } from './learning-chat-transport.ts';
import { loadConfig } from '../storage/config-store.ts';
import { loadPrompts } from './prompt-settings.ts';
import { AI_PROMPTS_KEY, promptText, withPromptPreference } from '../../shared/ai-prompts.ts';
import { correctionBatches, correctionKey, nextCorrectionBatch, parseCorrection, SUBTITLE_CORRECTION_CACHE,
  SUBTITLE_CORRECTION_PREFERENCE, SUBTITLE_CORRECTION_PROMPT, type CorrectionLine, type CorrectionState } from '../../shared/subtitle-correction.ts';

const active = new Map<number, AbortController>();
const activeSources = new Map<string, AbortController>();
let cacheQueue: Promise<unknown> = Promise.resolve();
let cacheEpoch = 0;
let listening = false;
function watchPreference(): void {
  if (listening) return;
  listening = true;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && ((SUBTITLE_CORRECTION_PREFERENCE in changes && changes[SUBTITLE_CORRECTION_PREFERENCE].newValue !== true)
      || 'userConfig' in changes || AI_PROMPTS_KEY in changes)) cancelSubtitleCorrection();
  });
}
export function cancelSubtitleCorrection(tabId?: number): void {
  if (tabId !== undefined) { active.get(tabId)?.abort(); active.delete(tabId); }
  else { for (const controller of active.values()) controller.abort(); active.clear(); }
}
export async function clearSubtitleCorrections(): Promise<void> {
  cacheEpoch++; cancelSubtitleCorrection();
  await cacheQueue.catch(() => {}); await globalThis.chrome?.storage?.session?.remove(SUBTITLE_CORRECTION_CACHE);
}
async function cache(): Promise<CorrectionState[]> {
  const value = (await chrome.storage.session.get(SUBTITLE_CORRECTION_CACHE))[SUBTITLE_CORRECTION_CACHE];
  return Array.isArray(value) ? value : [];
}
export async function readCorrectedSubtitle(sourceIdentityKey: string): Promise<CorrectionState | null> {
  return (await cache()).filter(row => row.sourceIdentityKey === sourceIdentityKey && row.done > 0).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
}
async function store(state: CorrectionState, epoch: number): Promise<void> {
  const operation = cacheQueue.catch(() => {}).then(async () => {
    if (epoch !== cacheEpoch) return;
    const rows = (await cache()).filter(row => row.key !== state.key).sort((a, b) => b.updatedAt - a.updatedAt);
    rows.unshift(state);
    while (rows.length > 12 || new TextEncoder().encode(JSON.stringify(rows)).length > 6 * 1024 * 1024) {
      if (rows.length === 1) throw new Error('CORRECTION_CAPACITY');
      rows.pop();
    }
    if (epoch === cacheEpoch) await chrome.storage.session.set({ [SUBTITLE_CORRECTION_CACHE]: rows });
  });
  cacheQueue = operation; await operation;
}
export async function subtitleCorrection(options: {
  tabId: number; sourceIdentityKey: string; lines: CorrectionLine[]; step: boolean; retry?: boolean;
  current: () => Promise<boolean>;
}): Promise<CorrectionState> {
  watchPreference();
  const config = await loadConfig(), epoch = cacheEpoch;
  const prompts = await loadPrompts(), prompt = withPromptPreference(SUBTITLE_CORRECTION_PROMPT, promptText(prompts, 'subtitles'));
  const key = correctionKey(options.sourceIdentityKey, config.ai.chatModel, config.ai.baseURL, prompt);
  const batches = correctionBatches(options.lines);
  let state = (await cache()).find(row => row.key === key) ?? {
    key, sourceIdentityKey: options.sourceIdentityKey, corrected: {}, failed: [], total: options.lines.length,
    done: 0, status: 'idle' as const, message: '', updatedAt: Date.now(),
  };
  if (!options.step) return state;
  const allowed = async () => epoch === cacheEpoch
    && prompts.revision === (await loadPrompts()).revision
    && (await chrome.storage.local.get(SUBTITLE_CORRECTION_PREFERENCE))[SUBTITLE_CORRECTION_PREFERENCE] === true
    && await options.current();
  if (!await allowed()) return { ...state, status: 'stopped', message: '已停止，原字幕仍可阅读。' };
  if (!config.ai.apiKey.trim() || !config.ai.chatModel.trim() || !config.ai.baseURL.trim()) {
    return { ...state, status: 'unavailable', message: '请先在设置中连接 AI，原字幕仍可阅读。' };
  }
  if (active.has(options.tabId) || activeSources.has(key)) return { ...state, status: 'running', message: '正在优化当前字幕。' };
  if (options.retry) state = { ...state, failed: [] };
  const index = nextCorrectionBatch(batches, state);
  if (index < 0) return { ...state, status: state.failed.length ? 'partial' : 'complete' };
  const controller = new AbortController(); active.set(options.tabId, controller); activeSources.set(key, controller);
  try {
  try {
    // Resolve live source, authorization and config again immediately before each small request.
    if (!await allowed() || controller.signal.aborted) throw new Error('CORRECTION_STOPPED');
    const live = await loadConfig();
    if (JSON.stringify(live.ai) !== JSON.stringify(config.ai)) throw new Error('CORRECTION_STOPPED');
    const text = await streamLearningChat(config.ai, [
      { role: 'system', content: prompt },
      { role: 'user', content: JSON.stringify(batches[index]) },
    ], { signal: controller.signal, stream: false, onText: () => {}, maxOutputTokens: 6000 });
    if (!await allowed() || controller.signal.aborted) throw new Error('CORRECTION_STOPPED');
    state = { ...state, corrected: { ...state.corrected, ...parseCorrection(text, batches[index]) } };
  } catch {
    if (controller.signal.aborted || !await allowed()) return { ...state, status: 'stopped', message: '已停止，已完成的部分仍保留。' };
    state = { ...state, failed: [...state.failed, index] };
  }
  state = { ...state, done: Object.keys(state.corrected).length, updatedAt: Date.now(),
    status: nextCorrectionBatch(batches, state) >= 0 ? 'running' : state.failed.length ? 'partial' : 'complete',
    message: state.failed.length ? '部分字幕未完成，保留原文，可重试。' : 'AI 优化版，仅作阅读辅助。',
  };
  if (await allowed()) await store(state, epoch);
  return state;
  } finally {
    if (active.get(options.tabId) === controller) active.delete(options.tabId);
    if (activeSources.get(key) === controller) activeSources.delete(key);
  }
}
